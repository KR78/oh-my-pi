/**
 * Sync an OMP session that was imported from OpenCode back into OpenCode's
 * SQLite transcript store, so the conversation can continue in `opencode`.
 *
 * The reverse of `foreign-session-import.ts`: entries added to the OMP session
 * after the import point (the `foreign_session_import` provenance marker) are
 * converted into OpenCode's native `message` + `part` rows and appended inside
 * one transaction. Resume state lives in the OMP session itself as
 * `opencode_sync` custom entries, so re-running syncs only new material and
 * re-runs are idempotent. A pre-write backup of the database is copied next to
 * it before the first write to a given session.
 *
 * Scope guard: only sessions whose provenance is `source: "opencode"` can be
 * synced; Claude/Codex/Pi imports have no writable target.
 */
import { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
	AssistantMessage,
	TextContent,
	ThinkingContent,
	ToolCall,
	ToolResultMessage,
	UserMessage,
} from "@oh-my-pi/pi-ai";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { SessionEntry } from "./session-entries";
import type { SessionManager } from "./session-manager";

/** Provenance payload written by `persistForeignSession` at import time. */
interface ForeignSessionImportData {
	source: string;
	sourceId: string;
	sourcePath: string;
	sourceCwd: string;
}

/** Resume pointer appended after every successful sync. */
export interface OpencodeSyncState {
	/** Index of the last OMP entry (into `getEntries()`) mirrored to OpenCode. */
	lastEntryIndex: number;
	/** ISO timestamp of the sync. */
	syncedAt: string;
}

export interface SyncToOpencodeResult {
	sessionFile: string;
	opencodeSessionId: string;
	databasePath: string;
	backupPath: string | undefined;
	appendedMessages: number;
	appendedParts: number;
	alreadyUpToDate: boolean;
}

interface PendingMessageRow {
	id: string;
	sessionId: string;
	timeCreated: number;
	timeUpdated: number;
	data: Record<string, unknown>;
}

/**
 * Fields every OpenCode message row needs for the UI to render it:
 * `parentID` chains an assistant response to its user turn (the session-turn
 * component groups by it — without it responses are invisible), and `mode`/
 * `path`/`agent` are required by the AssistantMessage schema.
 */
interface OpenCodeMessageContext {
	/** Id of the last synced user message, or undefined while none is active. */
	currentUserId: string | undefined;
	cwd: string;
	agent: string;
}

interface PendingPartRow {
	id: string;
	messageId: string;
	sessionId: string;
	timeCreated: number;
	timeUpdated: number;
	data: Record<string, unknown>;
}

function findImportProvenance(entries: readonly SessionEntry[]): ForeignSessionImportData | undefined {
	for (const entry of entries) {
		if (entry.type === "custom" && entry.customType === "foreign_session_import") {
			const data = entry.data;
			if (
				isRecord(data) &&
				typeof data.source === "string" &&
				typeof data.sourceId === "string" &&
				typeof data.sourcePath === "string"
			) {
				return data as unknown as ForeignSessionImportData;
			}
		}
	}
	return undefined;
}

function findLastSyncState(entries: readonly SessionEntry[]): OpencodeSyncState | undefined {
	let state: OpencodeSyncState | undefined;
	for (const entry of entries) {
		if (entry.type === "custom" && entry.customType === "opencode_sync") {
			const data = entry.data;
			if (isRecord(data) && typeof data.lastEntryIndex === "number") {
				state = data as unknown as OpencodeSyncState;
			}
		}
	}
	return state;
}

function opencodeTimestamp(entry: SessionEntry): number {
	if (typeof entry.timestamp === "string") {
		const parsed = Date.parse(entry.timestamp);
		if (Number.isFinite(parsed)) return parsed;
	}
	return Date.now();
}

/** Shape of an OpenCode tool part as stored in `part.data`. */
interface OpenCodeToolPart {
	type: "tool";
	tool: string;
	callID: string;
	state: {
		status: "pending" | "running" | "completed" | "error";
		input: Record<string, unknown>;
		output?: string;
		error?: string;
		metadata?: Record<string, unknown>;
	};
}

/** Monotonic id generator matching OpenCode's `msg_`/`prt_` prefix style. */
class IdSequence {
	#lastMs = 0;
	#counter = 0;

	next(prefix: "msg" | "prt", timestampMs: number): string {
		const ms = Math.max(timestampMs, this.#lastMs);
		this.#lastMs = ms;
		this.#counter += 1;
		// 24 hex chars of pseudo-uniqueness: timestamp-derived head plus a
		// per-millisecond counter tail. OpenCode ids are opaque strings; only
		// uniqueness within the table matters.
		const head = ms.toString(16).padStart(12, "0");
		const tail =
			((this.#counter & 0xffffff) ^ Math.floor(Math.random() * 0xffffff)).toString(16).padStart(6, "0") +
			Date.now().toString(16).slice(-6);
		return `${prefix}_${head}001${tail}${Math.floor(Math.random() * 0xffff)
			.toString(16)
			.padStart(4, "0")}`;
	}
}

function textFromUserContent(message: UserMessage): string {
	if (typeof message.content === "string") return message.content;
	const parts: string[] = [];
	for (const block of message.content) {
		if (block.type === "text") parts.push(block.text);
	}
	return parts.join("\n\n");
}

function assistantTextBlocks(message: AssistantMessage): Array<Record<string, unknown> | OpenCodeToolPart> {
	const parts: Array<Record<string, unknown> | OpenCodeToolPart> = [];
	for (const block of message.content) {
		if (block.type === "text") {
			parts.push({ type: "text", text: block.text });
		} else if (block.type === "thinking") {
			parts.push({ type: "reasoning", text: block.thinking });
		} else if (block.type === "toolCall") {
			parts.push({
				type: "tool",
				tool: block.name,
				callID: block.id,
				state: {
					status: "pending",
					input: block.arguments,
					metadata: { title: block.name },
				},
			});
		}
	}
	return parts;
}

function toolResultState(result: ToolResultMessage): OpenCodeToolPart["state"] {
	const text =
		typeof result.content === "string"
			? result.content
			: result.content
					.map(block => ("text" in block ? (block as TextContent).text : ""))
					.filter(text => text.length > 0)
					.join("\n");
	return {
		status: result.isError ? ("error" as const) : ("completed" as const),
		input: {},
		output: text,
		error: result.isError ? text : undefined,
		metadata: { title: result.toolName },
	};
}

async function backupDatabase(databasePath: string): Promise<string> {
	const backupDir = path.join(path.dirname(databasePath), "backups");
	await fs.mkdir(backupDir, { recursive: true });
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const backupPath = path.join(backupDir, `opencode.db-before-omp-sync-${stamp}.db`);
	await fs.copyFile(databasePath, backupPath);
	// Copy the WAL too when present, so the backup reflects the latest commits.
	try {
		await fs.copyFile(`${databasePath}-wal`, `${backupPath}-wal`);
	} catch {
		// No WAL pending; the main file is complete.
	}
	return backupPath;
}

/**
 * Mirror OMP-side continuation entries back into the source OpenCode session.
 * Safe to re-run: only entries past the last recorded sync point are sent, and
 * everything lands in a single transaction that either fully applies or leaves
 * the database untouched.
 */
export async function syncSessionToOpencode(
	manager: SessionManager,
	options?: { dryRun?: boolean },
): Promise<SyncToOpencodeResult> {
	const sessionFile = manager.getSessionFile();
	if (!sessionFile) throw new Error("Session has no file on disk; open a persisted session first.");
	const entries = manager.getEntries();
	const foundProvenance = findImportProvenance(entries);
	if (!foundProvenance) throw new Error(`Session ${sessionFile} has no foreign_session_import provenance.`);
	if (foundProvenance.source !== "opencode") {
		throw new Error(
			`Only OpenCode-imported sessions can be synced back (this one came from "${foundProvenance.source}").`,
		);
	}
	const provenance = foundProvenance;
	const separator = provenance.sourcePath.lastIndexOf("#");
	const databasePath = separator > 0 ? provenance.sourcePath.slice(0, separator) : undefined;
	if (!databasePath) throw new Error(`Provenance sourcePath does not reference a database: ${provenance.sourcePath}`);

	const lastSync = findLastSyncState(entries);
	const startIndex = lastSync ? lastSync.lastEntryIndex + 1 : 0;
	const pending = entries.slice(startIndex).filter(entry => entry.type === "message");
	const result: SyncToOpencodeResult = {
		sessionFile,
		opencodeSessionId: provenance.sourceId,
		databasePath,
		backupPath: undefined,
		appendedMessages: 0,
		appendedParts: 0,
		alreadyUpToDate: false,
	};
	if (pending.length === 0) {
		result.alreadyUpToDate = true;
		return result;
	}

	const ids = new IdSequence();

	const context: OpenCodeMessageContext = {
		currentUserId: undefined,
		cwd: manager.getCwd(),
		agent: "build",
	};

	function rowsForEntry(
		entry: SessionEntry,
		index: number,
	): { message: PendingMessageRow; parts: PendingPartRow[] } | undefined {
		if (entry.type !== "message") return undefined;
		const message = entry.message;
		const timestampMs = opencodeTimestamp(entry);
		if (message.role === "user") {
			const userMessage = message as UserMessage;
			const messageId = ids.next("msg", timestampMs);
			const partId = ids.next("prt", timestampMs);
			context.currentUserId = messageId;
			return {
				message: {
					id: messageId,
					sessionId: provenance.sourceId,
					timeCreated: timestampMs,
					timeUpdated: timestampMs,
					data: {
						role: "user",
						time: { created: timestampMs },
						agent: context.agent,
						model: { providerID: "omp", modelID: "omp" },
					},
				},
				parts: [
					{
						id: partId,
						messageId,
						sessionId: provenance.sourceId,
						timeCreated: timestampMs,
						timeUpdated: timestampMs,
						data: { type: "text", text: textFromUserContent(userMessage) },
					},
				],
			};
		}
		if (message.role === "toolResult") {
			// Results ride along inside their call's tool part; nothing standalone.
			return undefined;
		}
		if (message.role !== "assistant") return undefined;
		const assistantMessage = message as AssistantMessage;
		const messageId = ids.next("msg", timestampMs);
		const messageParts = assistantTextBlocks(assistantMessage);
		const completed = timestampMs + Math.max(...messageParts.map((_, i) => i + 1), 1);
		const row: PendingMessageRow = {
			id: messageId,
			sessionId: provenance.sourceId,
			timeCreated: timestampMs,
			timeUpdated: completed,
			data: {
				// UI groups responses under their prompt via parentID; without it
				// the response renders under no turn at all (session-turn.tsx).
				parentID: context.currentUserId ?? null,
				role: "assistant",
				mode: context.agent,
				agent: context.agent,
				path: { cwd: context.cwd, root: context.cwd },
				cost: 0,
				tokens: { input: 0, output: 0, reasoning: 0, cache: { write: 0, read: 0 } },
				providerID: "omp",
				modelID: assistantMessage.model || "unknown",
				finish: "stop",
				time: { created: timestampMs, completed },
			},
		};
		const partRows: PendingPartRow[] = [];
		// Native OpenCode assistant messages are bracketed by step-start/step-finish;
		// the session UI expects this rhythm.
		partRows.push({
			id: ids.next("prt", timestampMs),
			messageId,
			sessionId: provenance.sourceId,
			timeCreated: timestampMs,
			timeUpdated: completed,
			data: { type: "step-start" },
		});
		let partIndex = 0;
		for (const part of messageParts) {
			const toolPart = isRecord(part) && part.type === "tool" ? (part as unknown as OpenCodeToolPart) : undefined;
			if (toolPart && toolPart.state.status === "pending") {
				// Attach the matching result from the following OMP toolResult entry.
				const sibling = entries[index + 1];
				if (sibling?.type === "message" && sibling.message.role === "toolResult") {
					toolPart.state = toolResultState(sibling.message);
				} else {
					toolPart.state.status = "error";
					toolPart.state.error = "[no result captured]";
				}
			}
			partIndex += 1;
			partRows.push({
				id: ids.next("prt", timestampMs + partIndex),
				messageId,
				sessionId: provenance.sourceId,
				timeCreated: timestampMs + partIndex,
				timeUpdated: completed,
				data: part as Record<string, unknown>,
			});
		}
		partRows.push({
			id: ids.next("prt", completed),
			messageId,
			sessionId: provenance.sourceId,
			timeCreated: completed,
			timeUpdated: completed,
			data: {
				type: "step-finish",
				reason: "stop",
				tokens: { input: 0, output: 0, reasoning: 0, cache: { write: 0, read: 0 } },
				cost: 0,
			},
		});
		return { message: row, parts: partRows };
	}

	const planned: Array<{ message: PendingMessageRow; parts: PendingPartRow[] }> = [];
	for (let index = startIndex; index < entries.length; index += 1) {
		const rowSet = rowsForEntry(entries[index], index);
		if (rowSet) planned.push(rowSet);
	}
	if (planned.length === 0) {
		result.alreadyUpToDate = true;
		return result;
	}

	result.appendedMessages = planned.length;
	result.appendedParts = planned.reduce((sum, row) => sum + row.parts.length, 0);
	if (options?.dryRun) {
		console.log(
			`DRY RUN — would append ${result.appendedMessages} message(s), ${result.appendedParts} part(s) to ${provenance.sourceId}.`,
		);
		return result;
	}

	result.backupPath = await backupDatabase(databasePath);

	const database = new Database(databasePath);
	try {
		const transaction = database.transaction(() => {
			for (const row of planned) {
				database.run(
					"INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?1, ?2, ?3, ?4, ?5)",
					[
						row.message.id,
						row.message.sessionId,
						row.message.timeCreated,
						row.message.timeUpdated,
						JSON.stringify(row.message.data),
					],
				);
				for (const part of row.parts) {
					database.run(
						"INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
						[
							part.id,
							part.messageId,
							part.sessionId,
							part.timeCreated,
							part.timeUpdated,
							JSON.stringify(part.data),
						],
					);
				}
			}
		});
		transaction();
	} finally {
		database.close();
	}

	manager.appendCustomEntry("opencode_sync", {
		lastEntryIndex: entries.length - 1,
		syncedAt: new Date().toISOString(),
	} satisfies OpencodeSyncState);

	console.log(
		`Synced ${result.appendedMessages} message(s) (${result.appendedParts} part(s)) into ${provenance.sourceId}.\nBackup: ${result.backupPath}`,
	);
	return result;
}

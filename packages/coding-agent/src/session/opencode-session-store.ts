import { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type {
	AssistantMessage,
	ImageContent,
	TextContent,
	ToolCall,
	ToolResultMessage,
	Usage,
	UserMessage,
} from "@oh-my-pi/pi-ai";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { ForeignSessionInfo, ForeignSessionStore } from "./foreign-session-store";
import type { ModelChangeEntry, SessionMessageEntry } from "./session-entries";
import { SessionManager } from "./session-manager";

/** Row shape of OpenCode's `session` table (columns this importer reads). */
interface OpenCodeSessionRow {
	id: string;
	directory: string;
	title: string;
	slug: string;
	time_created: number;
	time_updated: number;
}

interface ParsedOpenCodeMessage {
	readonly id: string;
	readonly timeCreated: number;
	readonly data: Record<string, unknown>;
}

interface ParsedOpenCodePart {
	readonly messageId: string;
	readonly timeCreated: number;
	readonly data: Record<string, unknown>;
}

interface ConvertedMessage {
	readonly message: UserMessage | AssistantMessage | ToolResultMessage;
}

const EMPTY_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function stringField(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberField(record: Record<string, unknown>, key: string): number {
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function safeParse(raw: string): Record<string, unknown> {
	try {
		const value: unknown = JSON.parse(raw);
		return isRecord(value) ? value : {};
	} catch {
		return {};
	}
}

/**
 * Converts an OpenCode message-part transcript into ordered OMP messages.
 *
 * One OpenCode `message` row becomes one or more OMP messages:
 * - user `text` parts merge into a single user message; `file` parts become
 *   image content when they carry data URLs (dropped otherwise);
 * - assistant `reasoning` parts become thinking blocks, `text` parts become
 *   assistant text, and `tool` parts become tool calls whose results are
 *   emitted as sibling OMP toolResult messages;
 * - `step-start`/`step-finish`/`patch`/`compaction`/`file` assistant parts are
 *   structural runtime metadata with no OMP equivalent and are skipped.
 */
function convertOpenCodeMessages(
	messages: readonly ParsedOpenCodeMessage[],
	partsByMessage: Map<string, ParsedOpenCodePart[]>,
	fallbackTimestampMs: number,
): ConvertedMessage[] {
	const converted: ConvertedMessage[] = [];
	for (const message of messages) {
		const role = message.data.role;
		const parts = partsByMessage.get(message.id)?.sort((left, right) => left.timeCreated - right.timeCreated) ?? [];
		if (role === "user") {
			let text = "";
			const images: ImageContent[] = [];
			for (const part of parts) {
				if (part.data.type === "text" && typeof part.data.text === "string") {
					text += (text ? "\n" : "") + part.data.text;
				} else if (part.data.type === "file") {
					const image = imageFromDataUrl(stringField(part.data, "url"), stringField(part.data, "mime"));
					if (image) images.push(image);
				}
			}
			const content: string | (TextContent | ImageContent)[] =
				images.length > 0 ? [...(text ? [{ type: "text" as const, text }] : []), ...images] : text;
			if (typeof content === "string" ? content.length === 0 : content.length === 0) continue;
			converted.push({
				message: { role: "user", content, timestamp: message.timeCreated || fallbackTimestampMs },
			});
			continue;
		}
		if (role !== "assistant") continue;

		const modelId = stringField(message.data, "modelID") ?? "unknown";
		const providerId = stringField(message.data, "providerID") ?? "unknown";
		const content: AssistantMessage["content"] = [];
		let toolUse = false;
		let errorMessage: string | undefined;
		const toolResults: ToolResultMessage[] = [];
		for (const part of parts) {
			if (part.data.type === "text" && typeof part.data.text === "string" && part.data.text.length > 0) {
				content.push({ type: "text", text: part.data.text });
				continue;
			}
			if (part.data.type !== "tool") continue;
			const call = toolCallFromPart(part.data);
			if (!call) continue;
			content.push(call);
			toolUse = true;
			errorMessage = errorMessage ?? stringField(isRecord(part.data.state) ? part.data.state : {}, "error");
			toolResults.push(toolResultFromPart(part.data, call, part.timeCreated || fallbackTimestampMs));
		}
		const usage = usageFromTokens(message.data.tokens);
		if (content.length === 0 && !errorMessage) continue;
		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content,
			api: "openai-completions",
			provider: providerId,
			model: modelId,
			usage,
			stopReason: content.length === 0 && errorMessage ? "error" : toolUse ? "toolUse" : "stop",
			timestamp: message.timeCreated || fallbackTimestampMs,
		};
		if (errorMessage) assistantMessage.errorMessage = errorMessage;
		converted.push({ message: assistantMessage });
		for (const result of toolResults) converted.push({ message: result });
	}
	return converted;
}

function imageFromDataUrl(url: string | undefined, mimeType: string | undefined): ImageContent | undefined {
	if (!url?.startsWith("data:")) return undefined;
	const match = /^data:([^;,]+)(?:;base64)?,(.*)$/s.exec(url);
	if (!match) return undefined;
	return { type: "image", data: match[2], mimeType: mimeType ?? match[1] };
}

function toolCallFromPart(part: Record<string, unknown>): ToolCall | undefined {
	const id = stringField(part, "callID");
	const name = stringField(part, "tool");
	if (!id || !name) return undefined;
	const state = isRecord(part.state) ? part.state : {};
	return { type: "toolCall", id, name, arguments: isRecord(state.input) ? state.input : {} };
}

/**
 * Builds the OMP toolResult matching one OpenCode tool part. Calls still
 * `pending`/`running` when the source session ended get a synthetic error
 * result so every imported tool call keeps a well-formed sibling result.
 */
function toolResultFromPart(part: Record<string, unknown>, call: ToolCall, timestampMs: number): ToolResultMessage {
	const state = isRecord(part.state) ? part.state : {};
	const status = state.status;
	if (status !== "completed" && status !== "error") {
		return {
			role: "toolResult",
			toolCallId: call.id,
			toolName: call.name,
			content: [{ type: "text", text: "[interrupted]" }],
			isError: true,
			timestamp: timestampMs,
		};
	}
	const output = state.output;
	const text =
		status === "error"
			? (stringField(state, "error") ?? "Tool call failed")
			: typeof output === "string"
				? output
				: JSON.stringify(output ?? "");
	return {
		role: "toolResult",
		toolCallId: call.id,
		toolName: call.name,
		content: [{ type: "text", text }],
		isError: status === "error",
		timestamp: timestampMs,
	};
}

function usageFromTokens(value: unknown): Usage {
	if (!isRecord(value)) return EMPTY_USAGE;
	const cache = isRecord(value.cache) ? value.cache : {};
	return {
		input: numberField(value, "input"),
		output: numberField(value, "output") + numberField(value, "reasoning"),
		cacheRead: numberField(cache, "read"),
		cacheWrite: numberField(cache, "write"),
		totalTokens: numberField(value, "total"),
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function defaultOpenCodeDataDir(): string {
	const override = process.env.OPENCODE_DATA_DIR?.trim();
	if (override) return path.resolve(override.replace(/^~(?=$|\/|\\)/, os.homedir()));
	const xdgData = process.env.XDG_DATA_HOME?.trim();
	if (xdgData) return path.join(path.resolve(xdgData), "opencode");
	return path.join(os.homedir(), ".local", "share", "opencode");
}

async function findDatabasePath(dataDir: string): Promise<string | undefined> {
	for (const candidate of [path.join(dataDir, "opencode.db"), path.join(dataDir, ".opencode", "opencode.db")]) {
		try {
			if ((await fs.stat(candidate)).isFile()) return candidate;
		} catch {
			// Try the next candidate location.
		}
	}
	return undefined;
}

interface ParsedOpenCodeTranscript {
	cwd: string | undefined;
	messages: ParsedOpenCodeMessage[];
	parts: ParsedOpenCodePart[];
}

async function requireDatabasePath(dataDir: string): Promise<string> {
	const found = await findDatabasePath(dataDir);
	if (!found) throw new Error(`OpenCode database not found under ${dataDir}`);
	return found;
}

async function loadParsedTranscript(databasePath: string, sessionId: string): Promise<ParsedOpenCodeTranscript> {
	const database = new Database(databasePath, { readonly: true });
	try {
		type MessageRow = { id: string; time_created: number; data: string };
		const messages = database
			.query<MessageRow, [string]>(
				"SELECT id, time_created, data FROM message WHERE session_id = ?1 ORDER BY time_created, id",
			)
			.all(sessionId)
			.map(row => ({ id: row.id, timeCreated: row.time_created || 0, data: safeParse(row.data) }));
		type PartRow = { message_id: string; time_created: number; data: string };
		const parts = database
			.query<PartRow, [string]>(
				"SELECT message_id, time_created, data FROM part WHERE session_id = ?1 ORDER BY time_created, id",
			)
			.all(sessionId)
			.map(row => ({
				messageId: row.message_id,
				timeCreated: row.time_created || 0,
				data: safeParse(row.data),
			}));
		let cwd: string | undefined;
		for (const message of messages) {
			cwd = stringField(isRecord(message.data.path) ? message.data.path : {}, "cwd");
			if (cwd) break;
		}
		return { cwd, messages, parts };
	} finally {
		database.close();
	}
}

/** Imports locally stored OpenCode sessions into OMP's in-memory session format. */
export class OpenCodeSessionStore implements ForeignSessionStore {
	/** Foreign-session source discriminator. */
	readonly source = "opencode" as const;
	readonly #dataDir: string;

	/**
	 * Uses the supplied OpenCode data directory (`~/.local/share/opencode`),
	 * or the resolved default honoring `OPENCODE_DATA_DIR`/`XDG_DATA_HOME`.
	 */
	constructor(dataDir: string = defaultOpenCodeDataDir()) {
		this.#dataDir = path.resolve(dataDir);
	}

	/** Lists sessions from OpenCode's SQLite index without reading transcripts. */
	async list(): Promise<ForeignSessionInfo[]> {
		const databasePath = await findDatabasePath(this.#dataDir);
		if (!databasePath) return [];
		let rows: OpenCodeSessionRow[];
		try {
			const database = new Database(databasePath, { readonly: true });
			try {
				rows = database
					.query<OpenCodeSessionRow, []>(
						"SELECT id, directory, title, slug, time_created, time_updated FROM session ORDER BY time_updated DESC",
					)
					.all();
			} finally {
				database.close();
			}
		} catch {
			return [];
		}
		const sessions: ForeignSessionInfo[] = [];
		for (const row of rows) {
			if (!row.id || !row.directory) continue;
			sessions.push({
				source: this.source,
				id: row.id,
				path: `${databasePath}#${row.id}`,
				cwd: row.directory,
				title: row.title || row.slug || undefined,
				created: new Date(row.time_created || 0),
				modified: new Date(row.time_updated || row.time_created || 0),
			});
		}
		return sessions.sort(
			(left, right) => right.modified.getTime() - left.modified.getTime() || left.id.localeCompare(right.id),
		);
	}

	/** Converts one OpenCode session (message + part rows) into a non-persistent OMP session. */
	async load(info: ForeignSessionInfo): Promise<SessionManager> {
		if (info.source !== this.source) throw new Error(`Cannot load ${info.source} session with OpenCodeSessionStore`);
		const separator = info.path.lastIndexOf("#");
		const sessionId = separator >= 0 ? info.path.slice(separator + 1) : info.id;
		let databasePath: string;
		let transcript: Awaited<ReturnType<typeof loadParsedTranscript>>;
		try {
			databasePath = await requireDatabasePath(this.#dataDir);
			transcript = await loadParsedTranscript(databasePath, sessionId);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			throw new Error(`Unable to read OpenCode session ${sessionId}: ${detail}`);
		}
		if (transcript.messages.length === 0)
			throw new Error(`OpenCode session ${sessionId} contains no readable messages`);

		const partsByMessage = new Map<string, ParsedOpenCodePart[]>();
		for (const part of transcript.parts) {
			const bucket = partsByMessage.get(part.messageId) ?? [];
			bucket.push(part);
			partsByMessage.set(part.messageId, bucket);
		}

		const manager = SessionManager.inMemory(transcript.cwd ?? info.cwd);
		const converted = convertOpenCodeMessages(transcript.messages, partsByMessage, info.created.getTime());
		if (converted.length === 0) throw new Error(`OpenCode session ${sessionId} contains no convertible messages`);

		let parentId: string | null = null;
		let lastModel: string | undefined;
		let ordinal = 0;
		for (const item of converted) {
			const message = item.message;
			const timestamp = new Date(message.timestamp).toISOString();
			if (message.role === "assistant" && message.model !== lastModel) {
				lastModel = message.model;
				const modelChange: ModelChangeEntry = {
					type: "model_change",
					id: `opencode-${(++ordinal).toString(36)}`,
					parentId,
					timestamp,
					model: message.model,
				};
				manager.ingestReplicatedEntry(modelChange);
				parentId = modelChange.id;
			}
			const entry: SessionMessageEntry = {
				type: "message",
				id: `opencode-${(++ordinal).toString(36)}`,
				parentId,
				timestamp,
				message,
			};
			manager.ingestReplicatedEntry(entry);
			parentId = entry.id;
		}

		if (info.title) await manager.setSessionName(info.title, "auto", "opencode-import");
		return manager;
	}
}

import type * as fsTypes from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isRecord } from "@oh-my-pi/pi-utils";
import { collectForeignJsonRecords, type ForeignJsonRecord, readForeignJsonRecords } from "./foreign-session-jsonl";
import type { ForeignSessionInfo, ForeignSessionStore } from "./foreign-session-store";
import type { CompactionEntry, SessionEntry, SessionMessageEntry, ThinkingLevelChangeEntry } from "./session-entries";
import { SessionManager } from "./session-manager";

/** First record of a Pi session file; carries the session identity and working directory. */
interface PiSessionHeader {
	id?: string;
	cwd?: string;
	timestamp?: string;
}

const PI_FILE_ID_RE = /^\d{4}-\d{2}-\d{2}T[\d-]+Z_([0-9a-f-]{36})\.jsonl$/;

function stringField(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isoTimestamp(value: unknown, fallbackTimestampMs: number): string {
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
	}
	if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
	return new Date(fallbackTimestampMs).toISOString();
}

export async function decodePiSessionDirName(name: string): Promise<string | undefined> {
	const match = /^--(.+)--$/.exec(name);
	if (!match) return undefined;
	const body = match[1];
	if (!body) return undefined;

	// Pi encodes a session cwd by replacing every path separator with "-" while
	// keeping literal hyphens, so decoding is ambiguous. Resolve it by walking
	// the hyphen-separated tokens depth-first: at each junction the token run
	// either continues the current path segment or starts a new one. Real
	// directories exist on disk, which prunes wrong branches quickly.
	const tokens = body.split("-");

	async function resolveFrom(tokenIndex: number, segments: string[]): Promise<string | undefined> {
		if (tokenIndex === tokens.length) {
			const candidate = `/${segments.join("/")}`;
			try {
				return (await fs.stat(candidate)).isDirectory() ? candidate : undefined;
			} catch {
				return undefined;
			}
		}
		for (let end = tokens.length; end > tokenIndex; end -= 1) {
			const nextSegments = [...segments, tokens.slice(tokenIndex, end).join("-")];
			const resolved = await resolveFrom(end, nextSegments);
			if (resolved !== undefined) return resolved;
		}
		return undefined;
	}

	return await resolveFrom(0, []);
}

async function readPiHeader(filePath: string): Promise<PiSessionHeader | undefined> {
	for await (const { value } of readForeignJsonRecords(filePath)) {
		return value.type === "session" ? { ...value } : undefined;
	}
	return undefined;
}

/**
 * Converts one raw Pi JSONL record into an OMP session entry.
 *
 * Pi and OMP share the replicated-entry lineage (`type`/`id`/`parentId` plus
 * matching `message` payloads), so records pass through structurally intact:
 * messages are re-keyed to avoid cross-session id collisions, `model_change`
 * gains the `provider/modelId` composite OMP expects, thinking-level changes
 * map 1:1, and compactions keep their summaries without provider-native
 * replay state. Unknown entry types are dropped rather than guessed at.
 */
function convertPiRecord(
	value: Record<string, unknown>,
	fallbackTimestampMs: number,
	ordinal: number,
): SessionEntry | undefined {
	const timestamp = isoTimestamp(value.timestamp, fallbackTimestampMs);
	const id = `pi-${ordinal.toString(36)}`;
	switch (value.type) {
		case "message": {
			if (!isRecord(value.message)) return undefined;
			const entry: SessionMessageEntry = {
				type: "message",
				id,
				parentId: null,
				timestamp,
				message: value.message as unknown as SessionMessageEntry["message"],
			};
			return entry;
		}
		case "model_change": {
			return {
				type: "model_change",
				id,
				parentId: null,
				timestamp,
				model: `${stringField(value, "provider") ?? "unknown"}/${stringField(value, "modelId") ?? "unknown"}`,
			};
		}
		case "thinking_level_change": {
			const entry: ThinkingLevelChangeEntry = {
				type: "thinking_level_change",
				id,
				parentId: null,
				timestamp,
				thinkingLevel: typeof value.thinkingLevel === "string" ? value.thinkingLevel : null,
			};
			return entry;
		}
		case "compaction": {
			const entry: CompactionEntry = {
				type: "compaction",
				id,
				parentId: null,
				timestamp,
				summary: stringField(value, "summary") ?? stringField(value, "message") ?? "Context compacted by Pi.",
				shortSummary: "Imported Pi compaction",
				firstKeptEntryId: id,
				tokensBefore: typeof value.tokensBefore === "number" ? value.tokensBefore : 0,
				preserveData: { piCompaction: { sourceId: stringField(value, "id") ?? null } },
			};
			return entry;
		}
		default:
			return undefined;
	}
}

/** Imports locally stored Pi coding-agent sessions into OMP's in-memory session format. */
export class PiSessionStore implements ForeignSessionStore {
	/** Foreign-session source discriminator. */
	readonly source = "pi" as const;
	readonly #root: string;

	/**
	 * Uses the supplied Pi data root (the `~/.pi/agent` directory), or the
	 * resolved default honoring `PI_CODING_AGENT_DIR` when omitted.
	 */
	constructor(root: string = PiSessionStore.defaultRoot()) {
		this.#root = path.resolve(root);
	}

	/** Resolves Pi's agent directory the same way Pi itself does (`PI_CODING_AGENT_DIR`, then `~/.pi/agent`). */
	static defaultRoot(): string {
		const override = process.env.PI_CODING_AGENT_DIR?.trim();
		if (override) return path.resolve(override.replace(/^~(?=$|\/|\\)/, os.homedir()));
		return path.join(os.homedir(), ".pi", "agent");
	}

	/** Lists Pi sessions across every project bucket without parsing transcript bodies. */
	async list(): Promise<ForeignSessionInfo[]> {
		let buckets: string[];
		try {
			buckets = await fs.readdir(path.join(this.#root, "sessions"));
		} catch {
			return [];
		}
		const sessions: ForeignSessionInfo[] = [];
		for (const bucket of buckets) {
			let files: string[];
			try {
				files = await fs.readdir(path.join(this.#root, "sessions", bucket));
			} catch {
				continue;
			}
			let bucketCwd = await decodePiSessionDirName(bucket);
			if (bucketCwd) {
				try {
					if (!(await fs.stat(bucketCwd)).isDirectory()) bucketCwd = undefined;
				} catch {
					bucketCwd = undefined;
				}
			}
			for (const file of files) {
				if (!file.endsWith(".jsonl")) continue;
				const filePath = path.join(this.#root, "sessions", bucket, file);
				let stats: fsTypes.Stats;
				try {
					stats = await fs.stat(filePath);
				} catch {
					continue;
				}
				const header = await readPiHeader(filePath);
				const id = header?.id ?? PI_FILE_ID_RE.exec(file)?.[1] ?? file.replace(/\.jsonl$/, "");
				sessions.push({
					source: this.source,
					id,
					path: filePath,
					cwd: header?.cwd ?? bucketCwd ?? process.cwd(),
					created: new Date(
						header?.timestamp && Number.isFinite(Date.parse(header.timestamp))
							? Date.parse(header.timestamp)
							: stats.birthtimeMs || stats.mtimeMs,
					),
					modified: new Date(stats.mtimeMs),
				});
			}
		}
		return sessions.sort(
			(left, right) => right.modified.getTime() - left.modified.getTime() || left.path.localeCompare(right.path),
		);
	}

	/** Converts one Pi transcript into a non-persistent OMP session. */
	async load(info: ForeignSessionInfo): Promise<SessionManager> {
		if (info.source !== this.source) throw new Error(`Cannot load ${info.source} session with PiSessionStore`);
		let records: ForeignJsonRecord[];
		let stats: fsTypes.Stats;
		try {
			[records, stats] = await Promise.all([collectForeignJsonRecords(info.path), fs.stat(info.path)]);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			throw new Error(`Unable to read Pi session ${info.id}: ${detail}`);
		}
		if (records.length === 0 && stats.size > 0) throw new Error(`Pi session ${info.id} contains no readable records`);

		const header = await readPiHeader(info.path);
		const manager = SessionManager.inMemory(header?.cwd ?? info.cwd);

		let ordinal = 0;
		let parentId: string | null = null;
		for (const { value } of records) {
			const entry = convertPiRecord(value, info.created.getTime(), ++ordinal);
			if (!entry) continue;
			entry.parentId = parentId;
			manager.ingestReplicatedEntry(entry);
			parentId = entry.id;
		}

		if (info.title) await manager.setSessionName(info.title, "auto", "pi-import");
		return manager;
	}
}

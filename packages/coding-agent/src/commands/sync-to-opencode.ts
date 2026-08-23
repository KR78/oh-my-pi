/**
 * `omp sync-to-opencode` — mirror OMP-side continuation entries of an
 * OpenCode-imported session back into OpenCode's transcript store so the
 * conversation can continue in `opencode`.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isRecord } from "@oh-my-pi/pi-utils";
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { syncToOpencodeHelp as commandHelp } from "../cli/command-help";
import type { SessionEntry } from "../session/session-entries";
import { SessionManager } from "../session/session-manager";
import { type OpencodeSyncState, syncSessionToOpencode } from "../session/sync-to-opencode";

interface ImportProvenance {
	source: string;
	sourceId: string;
}

async function* sessionFiles(): AsyncGenerator<string> {
	const home = process.env.HOME ?? "/";
	const root = path.join(home, ".omp", "agent", "sessions");
	let buckets: string[] = [];
	try {
		buckets = await fs.readdir(root);
	} catch {
		return;
	}
	for (const bucket of buckets) {
		const bucketPath = path.join(root, bucket);
		try {
			for (const file of await fs.readdir(bucketPath)) {
				if (file.endsWith(".jsonl")) yield path.join(bucketPath, file);
			}
		} catch {
			// Bucket vanished mid-scan.
		}
	}
}

function readProvenance(raw: string): ImportProvenance | undefined {
	for (const line of raw.split("\n")) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		if (!isRecord(parsed) || parsed.type !== "custom" || parsed.customType !== "foreign_session_import") continue;
		if (isRecord(parsed.data) && typeof parsed.data.source === "string" && typeof parsed.data.sourceId === "string") {
			return { source: parsed.data.source, sourceId: parsed.data.sourceId };
		}
	}
	return undefined;
}

async function openByPrefix(prefix: string): Promise<SessionManager> {
	const matches: string[] = [];
	for await (const file of sessionFiles()) {
		const base = path.basename(file, ".jsonl");
		const idPart = base.replace(/^[\dT-]+Z_/, "");
		if (idPart.startsWith(prefix)) matches.push(file);
	}
	if (matches.length === 0) throw new Error(`No OMP session matches "${prefix}".`);
	if (matches.length > 1) {
		throw new Error(`Ambiguous session prefix "${prefix}" matches ${matches.length} sessions; use a longer prefix.`);
	}
	return await SessionManager.open(matches[0], undefined, undefined, { suppressBreadcrumb: true });
}

async function latestImportedOpencodeSession(): Promise<{ file: string; title?: string }> {
	const found: Array<{ file: string; mtimeMs: number }> = [];
	for await (const file of sessionFiles()) {
		const stats = await fs.stat(file);
		found.push({ file, mtimeMs: stats.mtimeMs });
	}
	found.sort((left, right) => right.mtimeMs - left.mtimeMs);
	for (const candidate of found.slice(0, 50)) {
		const raw = await Bun.file(candidate.file).text();
		const provenance = readProvenance(raw);
		if (provenance?.source !== "opencode") continue;
		const headerLine = raw.split("\n", 1)[0];
		let title: string | undefined;
		try {
			const header: unknown = JSON.parse(headerLine);
			if (isRecord(header) && typeof header.title === "string") title = header.title;
		} catch {
			// Header unreadable; still usable.
		}
		return { file: candidate.file, title };
	}
	throw new Error("No OpenCode-imported sessions found. Import one first with `omp --from-opencode`.");
}

async function resolveSession(sessionArg: string | undefined): Promise<SessionManager> {
	if (sessionArg) return await openByPrefix(sessionArg);
	const latest = await latestImportedOpencodeSession();
	console.log("No session given — using most recent OpenCode import:");
	console.log(`  ${latest.file}`);
	console.log(`  title: ${latest.title ?? "(untitled)"}`);
	return await SessionManager.open(latest.file, undefined, undefined, { suppressBreadcrumb: true });
}

export default class SyncToOpencode extends Command {
	static description = commandHelp.description;
	static args = {
		session: Args.string({
			description: "OMP session id prefix (default: most recent OpenCode import)",
			required: false,
		}),
	};
	static flags = {
		"dry-run": Flags.boolean({ description: "Show what would be appended without writing" }),
	};

	async run(): Promise<void> {
		const { args, flags } = await this.parse(SyncToOpencode);
		const manager = await resolveSession(args.session);
		await syncSessionToOpencode(manager, { dryRun: flags["dry-run"] === true });
	}
}

/** Exposed for tests. */
export function lastSyncIndex(entries: readonly SessionEntry[]): OpencodeSyncState | undefined {
	let state: OpencodeSyncState | undefined;
	for (const entry of entries) {
		if (entry.type === "custom" && entry.customType === "opencode_sync") {
			const data = entry.data;
			if (isRecord(data) && typeof data.lastEntryIndex === "number" && typeof data.syncedAt === "string") {
				state = { lastEntryIndex: data.lastEntryIndex, syncedAt: data.syncedAt };
			}
		}
	}
	return state;
}

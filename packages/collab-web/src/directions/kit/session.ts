/**
 * The session as the directions read it: a flat timeline of prompts, replies
 * and notes, the tool calls joined to their results, and the files the run
 * touched. Pure functions of the snapshot; every direction derives from these
 * instead of walking `entries` itself.
 */
import type { AssistantMessage, SessionEntry, SessionState } from "@oh-my-pi/pi-wire";
import { COLLAB_PROMPT_MESSAGE_TYPE } from "@oh-my-pi/pi-wire";
import type { ConnectionPhase, GuestSnapshot } from "../../lib/client";
import { fmtTokens } from "../../lib/format";
import type { DiffStats, ToolCallView } from "./tools";
import { collectToolCalls, diffStats, toolDiff, toolPath, writeLines } from "./tools";

export type TimelineItem =
	| { kind: "prompt"; id: string; author: string; byGuest: boolean; text: string; at: number }
	| { kind: "reply"; id: string; message: AssistantMessage; streaming: boolean; at: number }
	| { kind: "note"; id: string; text: string; at: number };

function contentText(content: string | readonly { type: string; text?: string }[]): string {
	if (typeof content === "string") return content;
	const parts: string[] = [];
	for (const block of content) if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
	return parts.join("\n");
}

function detailsFrom(details: unknown): string | null {
	if (typeof details !== "object" || details === null) return null;
	const from = (details as Record<string, unknown>).from;
	return typeof from === "string" && from.length > 0 ? from : null;
}

/**
 * `hostName` names who typed the plain user turns: the person who started
 * the run, as the host reports it in `participants`.
 */
export function buildTimeline(
	entries: readonly SessionEntry[],
	stream: AssistantMessage | null,
	streamDone: boolean,
	hostName: string,
): TimelineItem[] {
	const items: TimelineItem[] = [];
	for (const entry of entries) {
		const at = Date.parse(entry.timestamp);
		switch (entry.type) {
			case "message": {
				const message = entry.message;
				if (message.role === "user") {
					items.push({
						kind: "prompt",
						id: entry.id,
						author: hostName,
						byGuest: false,
						text: contentText(message.content),
						at,
					});
				} else if (message.role === "assistant") {
					items.push({ kind: "reply", id: entry.id, message, streaming: false, at: message.timestamp || at });
				}
				break;
			}
			case "custom_message":
				if (entry.customType === COLLAB_PROMPT_MESSAGE_TYPE) {
					items.push({
						kind: "prompt",
						id: entry.id,
						author: detailsFrom(entry.details) ?? "guest",
						byGuest: true,
						text: contentText(entry.content),
						at,
					});
				} else if (entry.display) {
					items.push({ kind: "note", id: entry.id, text: contentText(entry.content), at });
				}
				break;
			case "compaction":
				items.push({
					kind: "note",
					id: entry.id,
					text: `Earlier messages were summarised to save space (${fmtTokens(entry.tokensBefore)} tokens).`,
					at,
				});
				break;
			case "model_change":
				break;
			default:
				break;
		}
	}
	if (stream)
		items.push({
			kind: "reply",
			id: "stream",
			message: stream,
			streaming: !streamDone,
			at: stream.timestamp || Date.now(),
		});
	return items;
}

export interface TouchedFile {
	path: string;
	/** "edited" wins over "written" wins over "read". */
	change: "edited" | "written" | "read";
	stats: DiffStats | null;
	/** The latest diff or written content preview, newest call last. */
	diffs: string[];
	written: string | null;
	calls: ToolCallView[];
	lastAt: number;
}

const CHANGE_RANK: Record<TouchedFile["change"], number> = { read: 0, written: 1, edited: 2 };

export function touchedFiles(calls: readonly ToolCallView[]): TouchedFile[] {
	const byPath = new Map<string, TouchedFile>();
	for (const call of calls) {
		if (call.kind !== "read" && call.kind !== "edit" && call.kind !== "write") continue;
		const path = toolPath(call);
		if (!path) continue;
		const change: TouchedFile["change"] =
			call.kind === "edit" ? "edited" : call.kind === "write" ? "written" : "read";
		let file = byPath.get(path);
		if (!file) {
			file = { path, change, stats: null, diffs: [], written: null, calls: [], lastAt: call.at };
			byPath.set(path, file);
		}
		if (CHANGE_RANK[change] > CHANGE_RANK[file.change]) file.change = change;
		file.calls.push(call);
		file.lastAt = Math.max(file.lastAt, call.at);
		const diff = toolDiff(call);
		if (diff) {
			file.diffs.push(diff);
			const stats = diffStats(diff);
			file.stats = {
				added: (file.stats?.added ?? 0) + stats.added,
				removed: (file.stats?.removed ?? 0) + stats.removed,
			};
		}
		if (call.kind === "write") {
			const content = call.args.content;
			if (typeof content === "string") file.written = content;
			const lines = writeLines(call);
			if (lines !== null && !diff)
				file.stats = { added: (file.stats?.added ?? 0) + lines, removed: file.stats?.removed ?? 0 };
		}
	}
	return [...byPath.values()].toSorted((a, b) => CHANGE_RANK[b.change] - CHANGE_RANK[a.change] || b.lastAt - a.lastAt);
}

/** Who started the run: the host participant, else a neutral word. */
export function hostName(state: SessionState | null): string {
	return state?.participants.find(p => p.role === "host")?.name ?? "host";
}

export function sessionTitle(snapshot: GuestSnapshot): string {
	return snapshot.header?.title?.trim() || snapshot.state?.sessionName?.trim() || "Live run";
}

export function toolCallsOf(snapshot: GuestSnapshot): ToolCallView[] {
	return collectToolCalls(snapshot.entries, snapshot.stream, snapshot.activeTools);
}

/** Plain words for the connection phase; the same everywhere so people learn them once. */
export const PHASE_WORDS: Record<ConnectionPhase, string> = {
	connecting: "Connecting",
	waiting: "Joining the run",
	live: "Live",
	reconnecting: "Reconnecting",
	ended: "Ended",
};

/** Context window use in percent, from whichever fields the host sent. */
export function contextPercent(state: SessionState | null): number | null {
	const usage = state?.contextUsage;
	if (!usage) return null;
	if (usage.percent !== null && Number.isFinite(usage.percent)) return usage.percent;
	if (usage.tokens !== null && usage.contextWindow !== null && usage.contextWindow > 0)
		return (usage.tokens / usage.contextWindow) * 100;
	return null;
}

/** Sum of per-message usage across committed assistant replies. */
export function runUsage(entries: readonly SessionEntry[]): {
	cost: number;
	output: number;
	input: number;
	replies: number;
} {
	let cost = 0;
	let output = 0;
	let input = 0;
	let replies = 0;
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const usage = entry.message.usage;
		replies++;
		if (Number.isFinite(usage.cost.total)) cost += usage.cost.total;
		if (Number.isFinite(usage.output)) output += usage.output;
		if (Number.isFinite(usage.input)) input += usage.input + (Number.isFinite(usage.cacheRead) ? usage.cacheRead : 0);
	}
	return { cost, output, input, replies };
}

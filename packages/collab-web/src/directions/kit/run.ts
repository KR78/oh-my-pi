/**
 * One memoised read of the snapshot for a direction: the timeline, tool
 * results by id, every call, and the files touched. Recomputed only when the
 * pieces it reads change, so a streaming token (which replaces `stream`, not
 * `entries`) does not rescan the whole transcript for files.
 */
import type { ToolResultMessage } from "@oh-my-pi/pi-wire";
import { useMemo } from "react";
import type { GuestSnapshot } from "../../lib/client";
import type { TimelineItem, TouchedFile } from "./session";
import { buildTimeline, hostName, touchedFiles } from "./session";
import type { ToolCallView } from "./tools";
import { collectToolCalls, resultsById } from "./tools";

export interface RunView {
	timeline: TimelineItem[];
	results: ReadonlyMap<string, ToolResultMessage>;
	calls: ToolCallView[];
	files: TouchedFile[];
	host: string;
	/** The call running right now, newest first, if any. */
	current: ToolCallView | null;
}

export function useRun(snapshot: GuestSnapshot): RunView {
	const host = hostName(snapshot.state);
	const timeline = useMemo(
		() => buildTimeline(snapshot.entries, snapshot.stream, snapshot.streamDone, host),
		[snapshot.entries, snapshot.stream, snapshot.streamDone, host],
	);
	const results = useMemo(() => resultsById(snapshot.entries), [snapshot.entries]);
	const calls = useMemo(
		() => collectToolCalls(snapshot.entries, snapshot.stream, snapshot.activeTools),
		[snapshot.entries, snapshot.stream, snapshot.activeTools],
	);
	const files = useMemo(() => touchedFiles(calls), [calls]);
	const current = useMemo(() => {
		for (let i = calls.length - 1; i >= 0; i--) if (calls[i]!.status === "running") return calls[i]!;
		return null;
	}, [calls]);
	return { timeline, results, calls, files, host, current };
}

export interface Turn {
	id: string;
	prompt: Extract<TimelineItem, { kind: "prompt" }> | null;
	items: TimelineItem[];
}

/** Prompt-led turns: each prompt and everything until the next one. */
export function groupTurns(timeline: readonly TimelineItem[]): Turn[] {
	const turns: Turn[] = [];
	let current: Turn | null = null;
	for (const item of timeline) {
		if (item.kind === "prompt") {
			current = { id: item.id, prompt: item, items: [] };
			turns.push(current);
			continue;
		}
		if (!current) {
			current = { id: `lead-${item.id}`, prompt: null, items: [] };
			turns.push(current);
		}
		current.items.push(item);
	}
	return turns;
}

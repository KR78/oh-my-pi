/**
 * Second mock-host scenario: a real Oz session file instead of the canned
 * fixture, so the directions are judged on what Oz actually does.
 *
 *   bun scripts/mock-host.ts --session /path/to/session.jsonl
 *
 * The file is the coding agent's JSONL session log. Every `message` row
 * becomes a transcript entry (non-message rows are host bookkeeping and are
 * dropped, as the host's own snapshot drops them). The task prompt Oz
 * receives is a JSON envelope inside `<file name="…/task.md">`; it is shown
 * as the plain request text a person typed in Slack, which is what a guest
 * would recognise.
 *
 * The last turn (from its user prompt on) is held back. A guest prompt (or
 * `--autoplay`) replays it as a live stream: thinking and text grow, each
 * tool call runs with its real result, so a direction sees a real run
 * mid-stream rather than a finished transcript.
 */
import type {
	AssistantMessage,
	SessionEntry,
	SessionHeader,
	ToolCallContent,
	ToolResultMessage,
	WireModel,
} from "@oh-my-pi/pi-wire";
import type { ScriptedStep } from "./fixture";

export interface SessionScenario {
	header: SessionHeader;
	model: WireModel;
	entries: SessionEntry[];
	/** Steps that replay the held-back turn, given the id it should chain onto. */
	makeTurn(seq: number, parentId: string | null): ScriptedStep[];
	/** The held-back turn's prompt, shown as already sent when the turn replays. */
	pendingPrompt: SessionEntry | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const TASK_FILE = /<file name="[^"]*task\.md">\s*([\s\S]*?)\s*<\/file>/;
const SLACK_FOOTER = /\n+---\nFiled from Slack[\s\S]*$/;
const EARLIER_THREAD = /\n+Earlier in this thread:[\s\S]*$/;
const SLACK_MENTION = /<@[A-Z0-9]+>\s*/g;

/** The request a person wrote, out of the task envelope Oz is given. */
function requestText(raw: string): string {
	const match = TASK_FILE.exec(raw);
	if (!match) return raw;
	const body = match[1] ?? "";
	const start = body.indexOf("{");
	if (start < 0) return body;
	try {
		const parsed: unknown = JSON.parse(body.slice(start));
		if (isRecord(parsed) && Array.isArray(parsed.untrusted_content)) {
			const first = parsed.untrusted_content.find(isRecord);
			if (first && typeof first.text === "string") {
				return first.text.replace(SLACK_FOOTER, "").replace(EARLIER_THREAD, "").replace(SLACK_MENTION, "").trim();
			}
		}
	} catch {
		// not the envelope we know; show it raw
	}
	return body;
}

function userText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) if (isRecord(block) && typeof block.text === "string") parts.push(block.text);
	return parts.join("\n");
}

function displayModel(id: string): string {
	const tail = id.split("/").pop() ?? id;
	return tail
		.replace(/^claude-/, "")
		.replaceAll("-", " ")
		.replace(/(\d) (\d)/g, "$1.$2");
}

export async function loadSessionScenario(file: string): Promise<SessionScenario> {
	const text = await Bun.file(file).text();
	const rows: unknown[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			rows.push(JSON.parse(line));
		} catch {
			// a torn last line; skip
		}
	}
	let headerRow: Record<string, unknown> | null = null;
	let modelId = "oz";
	const entries: SessionEntry[] = [];
	for (const row of rows) {
		if (!isRecord(row)) continue;
		if (row.type === "session") headerRow = row;
		if (row.type === "model_change" && typeof row.model === "string") modelId = row.model;
		if (row.type !== "message" || !isRecord(row.message)) continue;
		const message = row.message;
		const base = {
			id: String(row.id),
			parentId: typeof row.parentId === "string" ? row.parentId : null,
			timestamp: String(row.timestamp),
		};
		if (message.role === "user") {
			entries.push({
				...base,
				type: "message",
				message: {
					role: "user",
					content: requestText(userText(message.content)),
					timestamp: Number(message.timestamp) || Date.parse(base.timestamp),
				},
			});
			continue;
		}
		entries.push({ ...base, type: "message", message: message as unknown as AssistantMessage | ToolResultMessage });
	}

	// Shift every timestamp so the run ends a few minutes ago, not on the day it was recorded.
	const lastTs = entries.length > 0 ? Date.parse(entries[entries.length - 1]!.timestamp) : Date.now();
	const shift = Date.now() - 3 * 60_000 - lastTs;
	const shifted = entries.map((entry): SessionEntry => {
		const timestamp = new Date(Date.parse(entry.timestamp) + shift).toISOString();
		if (entry.type !== "message") return { ...entry, timestamp };
		return {
			...entry,
			timestamp,
			message: { ...entry.message, timestamp: entry.message.timestamp + shift },
		} as SessionEntry;
	});

	let lastUser = -1;
	for (let i = shifted.length - 1; i >= 0; i--) {
		const entry = shifted[i]!;
		if (entry.type === "message" && entry.message.role === "user") {
			lastUser = i;
			break;
		}
	}
	const held = lastUser > 0 ? shifted.slice(lastUser) : [];
	const kept = lastUser > 0 ? shifted.slice(0, lastUser) : shifted;

	const model: WireModel = { id: modelId, name: displayModel(modelId), provider: "oz", contextWindow: 200_000 };
	const header: SessionHeader = {
		type: "session",
		id: String(headerRow?.id ?? "oz-session"),
		title: "Restore README.md on main",
		timestamp: kept[0]?.timestamp ?? new Date().toISOString(),
		cwd: typeof headerRow?.cwd === "string" ? headerRow.cwd : "/work/oz",
	};

	return {
		header,
		model,
		entries: kept,
		pendingPrompt: held[0] ?? null,
		makeTurn: (seq, parentId) => replaySteps(held.slice(1), seq, parentId),
	};
}

/** Grows `text` in a few slices so the stream looks like it is being typed. */
function slices(text: string, count: number): string[] {
	if (text.length === 0) return [];
	const out: string[] = [];
	for (let i = 1; i <= count; i++) {
		const cut = Math.round((text.length * i) / count);
		const space = text.indexOf(" ", cut);
		out.push(i === count || space < 0 ? text : text.slice(0, space));
	}
	return [...new Set(out)];
}

function replaySteps(turn: readonly SessionEntry[], seq: number, parentId: string | null): ScriptedStep[] {
	const steps: ScriptedStep[] = [
		{ kind: "event", event: { type: "agent_start" } },
		{ kind: "state", streaming: true },
	];
	const results = new Map<string, ToolResultMessage>();
	for (const entry of turn) {
		if (entry.type === "message" && entry.message.role === "toolResult")
			results.set(entry.message.toolCallId, entry.message);
	}
	let parent = parentId;
	// Call ids are suffixed per replay, so a second replay never collides with the first.
	const rid = (id: string): string => `${id}-r${seq}`;
	for (const entry of turn) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const content = entry.message.content.map(block =>
			block.type === "toolCall" ? { ...block, id: rid(block.id) } : block,
		);
		const final: AssistantMessage = { ...entry.message, content, timestamp: Date.now() };
		const built: AssistantMessage["content"] = [];
		const partial = (content: AssistantMessage["content"]): AssistantMessage => ({
			...final,
			content: [...content],
			stopReason: "stop",
		});
		steps.push({ kind: "event", event: { type: "message_start", message: partial([]) } });
		const calls: ToolCallContent[] = [];
		for (const block of final.content) {
			if (block.type === "thinking") {
				for (const s of slices(block.thinking, 4))
					steps.push({
						kind: "event",
						event: { type: "message_update", message: partial([...built, { type: "thinking", thinking: s }]) },
					});
				built.push(block);
			} else if (block.type === "text") {
				for (const s of slices(block.text, 8))
					steps.push({
						kind: "event",
						event: { type: "message_update", message: partial([...built, { type: "text", text: s }]) },
					});
				built.push(block);
			} else {
				built.push(block);
				if (block.type === "toolCall") calls.push(block);
				steps.push({ kind: "event", event: { type: "message_update", message: partial(built) } });
			}
		}
		steps.push({ kind: "event", event: { type: "message_end", message: final } });
		const entryId = rid(entry.id);
		steps.push({
			kind: "entry",
			entry: { ...entry, id: entryId, parentId: parent, timestamp: new Date().toISOString(), message: final },
		});
		parent = entryId;
		for (const call of calls) {
			const result = results.get(call.id.slice(0, -`-r${seq}`.length));
			const text = result?.content.find(block => block.type === "text");
			const output = text && text.type === "text" ? text.text : "";
			const firstLines = output.split("\n").slice(0, 3).join("\n");
			steps.push({
				kind: "event",
				event: {
					type: "tool_execution_start",
					toolCallId: call.id,
					toolName: call.name,
					args: call.arguments,
					intent: call.intent,
				},
			});
			// Hold the running tool on screen for a moment, with its first output lines streaming.
			for (let i = 0; i < 12; i++) {
				steps.push({
					kind: "event",
					event: {
						type: "tool_execution_update",
						toolCallId: call.id,
						toolName: call.name,
						args: call.arguments,
						partialResult: i < 4 ? "" : firstLines,
					},
				});
			}
			steps.push({
				kind: "event",
				event: {
					type: "tool_execution_end",
					toolCallId: call.id,
					toolName: call.name,
					result: output,
					isError: result?.isError === true,
				},
			});
			if (result) {
				const resultId = `${call.id}-res`;
				steps.push({
					kind: "entry",
					entry: {
						id: resultId,
						parentId: parent,
						timestamp: new Date().toISOString(),
						type: "message",
						message: { ...result, toolCallId: call.id, timestamp: Date.now() },
					},
				});
				parent = resultId;
			}
		}
	}
	steps.push({ kind: "event", event: { type: "agent_end" } }, { kind: "state", streaming: false });
	return steps;
}

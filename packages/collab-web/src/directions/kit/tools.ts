/**
 * Tool classification and plain-language description, shared by every
 * direction so each does not reinvent what a call "is".
 *
 * Inputs are wire JSON (tool args and results) and are treated as untrusted
 * shapes: every field is narrowed before use, and an unknown tool falls back
 * to the `other` kind rather than throwing.
 */
import type { AssistantMessage, SessionEntry, ToolResultMessage } from "@oh-my-pi/pi-wire";
import { INTENT_FIELD } from "@oh-my-pi/pi-wire";
import type { ActiveTool } from "../../lib/client";

export type ToolKind =
	| "shell"
	| "read"
	| "edit"
	| "write"
	| "search"
	| "browser"
	| "web"
	| "agent"
	| "ask"
	| "wait"
	| "todo"
	| "other";

const KIND_BY_NAME: Record<string, ToolKind> = {
	bash: "shell",
	eval: "shell",
	js: "shell",
	python: "shell",
	notebook: "shell",
	debug: "shell",
	read: "read",
	lsp: "read",
	edit: "edit",
	apply_patch: "edit",
	ast_edit: "edit",
	write: "write",
	grep: "search",
	search: "search",
	glob: "search",
	find: "search",
	ast_grep: "search",
	browser: "browser",
	puppeteer: "browser",
	fetch: "web",
	web_search: "web",
	github: "web",
	task: "agent",
	ask: "ask",
	wait: "wait",
	todo: "todo",
	goal: "todo",
};

export function toolKind(name: string): ToolKind {
	return KIND_BY_NAME[name] ?? "other";
}

export type ToolStatus = "running" | "done" | "failed";

/** One tool call joined with its result or live execution, in transcript order. */
export interface ToolCallView {
	id: string;
	name: string;
	kind: ToolKind;
	args: Record<string, unknown>;
	intent: string | null;
	status: ToolStatus;
	result: ToolResultMessage | null;
	/** Streaming output tail while running. */
	partial: string | null;
	/** Epoch ms of the assistant message that made the call. */
	at: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

/** Tool args without the internal intent field. */
export function cleanArgs(raw: unknown): { args: Record<string, unknown>; intent: string | null } {
	if (!isRecord(raw)) return { args: {}, intent: null };
	const intent = str(raw[INTENT_FIELD])?.trim() || null;
	if (!(INTENT_FIELD in raw)) return { args: raw, intent };
	const args: Record<string, unknown> = {};
	for (const key in raw) if (key !== INTENT_FIELD) args[key] = raw[key];
	return { args, intent };
}

/** Joined text of a tool result's text blocks. */
export function resultText(result: ToolResultMessage | null): string {
	if (!result) return "";
	let out = "";
	for (const block of result.content) {
		if (block.type === "text") out = out.length > 0 ? `${out}\n${block.text}` : block.text;
	}
	return out;
}

function partialText(value: unknown): string | null {
	if (typeof value === "string") return value;
	if (!isRecord(value)) return null;
	const content = value.content;
	if (!Array.isArray(content)) return null;
	const parts: string[] = [];
	for (const block of content) if (isRecord(block) && typeof block.text === "string") parts.push(block.text);
	return parts.length > 0 ? parts.join("\n") : null;
}

const HASHLINE_HEADER = /^\[([^\]#]+)(?:#[0-9A-Fa-f]{4})?\]$/m;
const PATCH_HEADER = /^\*{3} (?:Update|Add|Delete) File:\s*(.+)$/m;
const PATH_SELECTOR = /:(?:\d+(?:[-+]\d*)?(?:,\d+(?:[-+]\d*)?)*|raw|conflicts)$/;

/** The file a call touches, when it names one. */
export function toolPath(call: Pick<ToolCallView, "args" | "result">): string | null {
	const { args } = call;
	const details = call.result && isRecord(call.result.details) ? call.result.details : null;
	const fromDetails = details ? str(details.path) : null;
	if (fromDetails) return fromDetails;
	const direct = str(args.path) ?? str(args.file_path);
	if (direct) return direct.replace(PATH_SELECTOR, "");
	const input = str(args.input) ?? str(args._input);
	if (input) {
		const header = HASHLINE_HEADER.exec(input) ?? PATCH_HEADER.exec(input);
		if (header?.[1]) return header[1].trim();
	}
	return null;
}

/** Unified diff text of an edit, when the host reported one. */
export function toolDiff(call: Pick<ToolCallView, "result">): string | null {
	const details = call.result && isRecord(call.result.details) ? call.result.details : null;
	if (!details || call.result?.isError) return null;
	const diff = str(details.diff);
	if (diff) return diff;
	if (Array.isArray(details.perFileResults)) {
		const parts: string[] = [];
		for (const file of details.perFileResults)
			if (isRecord(file) && typeof file.diff === "string") parts.push(file.diff);
		if (parts.length > 0) return parts.join("\n");
	}
	return null;
}

export interface DiffStats {
	added: number;
	removed: number;
}

export function diffStats(diff: string): DiffStats {
	let added = 0;
	let removed = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+") && !line.startsWith("+++")) added++;
		else if (line.startsWith("-") && !line.startsWith("---")) removed++;
	}
	return { added, removed };
}

/** File writes report line counts rather than diffs. */
export function writeLines(call: Pick<ToolCallView, "args">): number | null {
	const content = str(call.args.content);
	return content === null ? null : content.split("\n").length;
}

/** The command of a shell call, the pattern of a search, the URL of a fetch… */
export function toolSubject(call: Pick<ToolCallView, "args" | "result" | "kind">): string {
	const { args } = call;
	switch (call.kind) {
		case "shell":
			return str(args.command) ?? str(args.code) ?? "";
		case "search": {
			const pattern = str(args.pattern) ?? str(args.query);
			if (pattern) return pattern;
			const paths = args.paths ?? args.path;
			return Array.isArray(paths) ? paths.filter(p => typeof p === "string").join(", ") : (str(paths) ?? "");
		}
		case "browser":
		case "web":
			return str(args.url) ?? str(args.query) ?? str(args.action) ?? "";
		case "agent": {
			const tasks = Array.isArray(args.tasks) ? args.tasks : [];
			const first = tasks.find(isRecord);
			return (first && (str(first.description) ?? str(first.id))) ?? str(args.description) ?? str(args.agent) ?? "";
		}
		default:
			return toolPath(call) ?? "";
	}
}

function lastSegment(path: string): string {
	const parts = path.split("/").filter(Boolean);
	return parts[parts.length - 1] ?? path;
}

const TEST_SUMMARY = /(\d+)\s+(?:tests?\s+)?(passed|failed)/gi;

/**
 * A sentence a non-engineer can read: "Changed README.md", "Ran the tests:
 * 61 passed". Built from the call itself; never from model prose.
 */
export function plainStep(call: ToolCallView): string {
	const path = toolPath(call);
	const file = path ? lastSegment(path) : null;
	switch (call.kind) {
		case "shell": {
			const command = str(call.args.command) ?? "";
			if (/\b(test|vitest|jest|check)\b/.test(command)) {
				const text = resultText(call.result);
				const counts: string[] = [];
				for (const match of text.matchAll(TEST_SUMMARY)) counts.push(`${match[1]} ${match[2].toLowerCase()}`);
				if (call.status === "running") return "Running the checks";
				return counts.length > 0 ? `Ran the checks: ${counts.slice(0, 2).join(", ")}` : "Ran the checks";
			}
			const now = call.status === "running";
			if (/^\s*git\s+(commit|revert)/.test(command) || /&&\s*git commit/.test(command))
				return now ? "Saving a commit" : "Saved a commit";
			if (/^\s*git\s+(log|show|status|diff|ls-tree|ls-remote|fetch)/.test(command))
				return now ? "Looking at the history" : "Looked at the history";
			if (/\bnpm (ci|install)\b/.test(command)) return now ? "Installing dependencies" : "Installed dependencies";
			return now ? "Running a command" : "Ran a command";
		}
		case "read":
			if (call.status === "running") return file ? `Reading ${file}` : "Reading a file";
			return file ? `Read ${file}` : "Read a file";
		case "edit":
			if (call.status === "running") return file ? `Changing ${file}` : "Changing a file";
			return file ? `Changed ${file}` : "Changed a file";
		case "write":
			if (call.status === "running") return file ? `Writing ${file}` : "Writing a file";
			return file ? `Wrote ${file}` : "Wrote a file";
		case "search":
			return "Searched the code";
		case "browser":
			return "Used the browser";
		case "web":
			return "Looked something up";
		case "agent":
			return "Asked a helper agent";
		case "ask":
			return "Asked a question";
		case "wait":
			return call.status === "failed" ? "Waited, then stopped" : "Waited for a job";
		case "todo":
			return "Updated the plan";
		default:
			return `Used ${call.name}`;
	}
}

/** One call block joined with its result and live execution. */
export function toolCallView(
	block: { id: string; name: string; arguments: Record<string, unknown>; intent?: string },
	result: ToolResultMessage | undefined,
	active: ActiveTool | undefined,
	pending: boolean,
	at: number,
): ToolCallView {
	const { args, intent } = cleanArgs(active?.args ?? block.arguments);
	return {
		id: block.id,
		name: block.name,
		kind: toolKind(block.name),
		args,
		intent: block.intent?.trim() || active?.intent?.trim() || intent,
		status: result ? (result.isError ? "failed" : "done") : active || pending ? "running" : "done",
		result: result ?? null,
		partial: active ? partialText(active.partialResult) : null,
		at,
	};
}

/** Tool results by call id, for pairing. */
export function resultsById(entries: readonly SessionEntry[]): Map<string, ToolResultMessage> {
	const results = new Map<string, ToolResultMessage>();
	for (const entry of entries) {
		if (entry.type === "message" && entry.message.role === "toolResult")
			results.set(entry.message.toolCallId, entry.message);
	}
	return results;
}

/**
 * Every tool call in the transcript (plus the live stream and tools running
 * outside any message), joined with its result, in order.
 */
export function collectToolCalls(
	entries: readonly SessionEntry[],
	stream: AssistantMessage | null,
	activeTools: ReadonlyMap<string, ActiveTool>,
): ToolCallView[] {
	const results = new Map<string, ToolResultMessage>();
	for (const entry of entries) {
		if (entry.type === "message" && entry.message.role === "toolResult")
			results.set(entry.message.toolCallId, entry.message);
	}
	const calls: ToolCallView[] = [];
	const seen = new Set<string>();
	const push = (message: AssistantMessage, pending: boolean): void => {
		for (const block of message.content) {
			if (block.type !== "toolCall" || seen.has(block.id)) continue;
			seen.add(block.id);
			const active = activeTools.get(block.id);
			const result = results.get(block.id) ?? null;
			const { args, intent } = cleanArgs(active?.args ?? block.arguments);
			calls.push({
				id: block.id,
				name: block.name,
				kind: toolKind(block.name),
				args,
				intent: block.intent?.trim() || active?.intent?.trim() || intent,
				status: result ? (result.isError ? "failed" : "done") : active || pending ? "running" : "done",
				result,
				partial: active ? partialText(active.partialResult) : null,
				at: message.timestamp,
			});
		}
	};
	for (const entry of entries) {
		if (entry.type === "message" && entry.message.role === "assistant") push(entry.message, false);
	}
	if (stream) push(stream, true);
	for (const tool of activeTools.values()) {
		if (seen.has(tool.toolCallId)) continue;
		calls.push(orphanToolView(tool));
	}
	return calls;
}

/** A running tool that no message has claimed yet. */
export function orphanToolView(tool: ActiveTool): ToolCallView {
	return toolCallView(
		{ id: tool.toolCallId, name: tool.toolName, arguments: {}, intent: tool.intent },
		undefined,
		tool,
		true,
		tool.startedAt,
	);
}

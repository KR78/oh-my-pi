/**
 * Chamber's tool row: OpenChamber's collapsed tool line (icon that turns
 * into a chevron on hover, bold title, muted one-line description, +/-
 * counts, live duration) and its expanded body hung off a thin vertical
 * line that also folds the block. Adapted from OpenChamber's
 * `components/chat/message/parts/ToolPart.tsx`, `toolPresentation.tsx`,
 * `BlockLine.tsx` and `ReasoningPart.tsx` to collab-web's data.
 *
 * Copyright (c) 2025 Bohdan Triapitsyn. MIT License; see
 * LICENSE-openchamber.txt in this folder.
 */
import type { LucideIcon } from "lucide-react";
import {
	Bot,
	Brain,
	ChevronDown,
	ChevronRight,
	CircleHelp,
	FilePen,
	FileText,
	Globe,
	Hourglass,
	ListChecks,
	Pencil,
	Search,
	SquareTerminal,
	Wrench,
} from "lucide-react";
import type { ReactNode } from "react";
import { memo, useId, useState } from "react";
import { useNow } from "../kit/hooks";
import type { ToolCallView, ToolKind } from "../kit/tools";
import { diffStats, resultText, toolDiff, toolSubject, writeLines } from "../kit/tools";
import { Prose, ToolDetail } from "../kit/views";
import { seconds, splitPath } from "../kit/words";

const ICONS: Record<ToolKind, LucideIcon> = {
	shell: SquareTerminal,
	read: FileText,
	edit: Pencil,
	write: FilePen,
	search: Search,
	browser: Globe,
	web: Globe,
	agent: Bot,
	ask: CircleHelp,
	wait: Hourglass,
	todo: ListChecks,
	other: Wrench,
};

const TITLES: Record<ToolKind, string> = {
	shell: "Shell",
	read: "Read",
	edit: "Edit",
	write: "Write",
	search: "Search",
	browser: "Browser",
	web: "Fetch",
	agent: "Agent",
	ask: "Question",
	wait: "Wait",
	todo: "Plan",
	other: "",
};

const PATH_KINDS: ReadonlySet<ToolKind> = new Set(["read", "edit", "write"]);

/** The path as OpenChamber draws it: folders muted and truncated from the left, the file name kept. */
function PathDescription({ path }: { path: string }): ReactNode {
	const { dir, name } = splitPath(path);
	return (
		<span className="ch-path" title={path}>
			{dir && <span className="ch-path-dir">{dir}</span>}
			<span className="ch-path-name">{name}</span>
		</span>
	);
}

function firstLine(text: string): string {
	return (
		text
			.split("\n")
			.find(line => line.trim().length > 0)
			?.trim() ?? ""
	);
}

/** A failed command's verdict is at the end of its output; anything else states it first. */
function failureLine(call: ToolCallView): string {
	const text = resultText(call.result);
	if (call.kind !== "shell") return firstLine(text);
	const lines = text.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) if (lines[i]!.trim()) return lines[i]!.trim();
	return "";
}

export const ToolRow = memo(function ToolRow({
	call,
	diffHook = false,
}: {
	call: ToolCallView;
	diffHook?: boolean;
}): ReactNode {
	const [open, setOpen] = useState(false);
	const bodyId = useId();
	const running = call.status === "running";
	const failed = call.status === "failed";
	const now = useNow(1000, running);
	const Icon = ICONS[call.kind];
	const title = TITLES[call.kind] || call.name;
	const subject = toolSubject(call);
	const diff = call.kind === "edit" ? toolDiff(call) : null;
	const stats = diff ? diffStats(diff) : null;
	const lines = call.kind === "write" ? writeLines(call) : null;
	const failure = failed ? failureLine(call) : "";
	const showDuration = call.kind === "shell" || call.kind === "agent" || running;

	return (
		<div className="ch-tool" data-status={call.status} data-shot={running ? "running" : undefined}>
			<button
				type="button"
				className="ch-row"
				aria-expanded={open}
				aria-controls={bodyId}
				onClick={() => setOpen(v => !v)}
				data-shot={diffHook ? "open-diff" : undefined}
			>
				<span className="ch-row-icon" aria-hidden="true">
					<Icon className="ch-ico ch-ico--kind" size={14} />
					{open ? (
						<ChevronDown className="ch-ico ch-ico--chev" size={14} />
					) : (
						<ChevronRight className="ch-ico ch-ico--chev" size={14} />
					)}
				</span>
				<span className={running ? "ch-row-title ch-shine" : "ch-row-title"}>{title}</span>
				<span className="ch-row-desc">
					{call.intent ? (
						<span className="ch-trunc" title={subject || call.intent}>
							{call.intent}
						</span>
					) : PATH_KINDS.has(call.kind) && subject ? (
						<PathDescription path={subject} />
					) : (
						<span className="ch-trunc" title={subject}>
							{subject}
						</span>
					)}
					{failure && (
						<>
							<span className="ch-dot" aria-hidden="true">
								·
							</span>
							<span className="ch-fail" title={failure}>
								{failure}
							</span>
						</>
					)}
				</span>
				{stats && (
					<span className="ch-stats" aria-label={`${stats.added} lines added, ${stats.removed} removed`}>
						<span className="ch-add">+{stats.added}</span>
						<span className="ch-slash">/</span>
						<span className="ch-del">-{stats.removed}</span>
					</span>
				)}
				{lines !== null && !stats && (
					<span className="ch-stats" aria-label={`${lines} lines written`}>
						<span className="ch-add">+{lines}</span>
					</span>
				)}
				{showDuration && running && <span className="ch-dur">{seconds(now - call.at)}</span>}
				{failed && <span className="k-sr">failed</span>}
				{running && <span className="k-sr">running</span>}
			</button>
			{open && (
				<div className="ch-body" id={bodyId}>
					<button
						type="button"
						className="ch-line"
						aria-label="Collapse"
						onClick={() => setOpen(false)}
						tabIndex={-1}
					/>
					{call.intent && subject && <div className="ch-body-subject">{subject}</div>}
					<ToolDetail call={call} />
				</div>
			)}
		</div>
	);
});

const MD_NOISE = /[`*_#>[\]]/g;

/** OpenChamber's reasoning row: "Thinking" with a one-line summary, the full text under a fold line. */
export const ThinkingRow = memo(function ThinkingRow({
	text,
	streaming,
}: {
	text: string;
	streaming: boolean;
}): ReactNode {
	const [open, setOpen] = useState(false);
	const bodyId = useId();
	const summary = firstLine(text.replace(MD_NOISE, "")).slice(0, 120);
	return (
		<div className="ch-tool ch-think">
			<button
				type="button"
				className="ch-row"
				aria-expanded={open}
				aria-controls={bodyId}
				onClick={() => setOpen(v => !v)}
			>
				<span className="ch-row-icon" aria-hidden="true">
					<Brain className="ch-ico ch-ico--kind" size={14} />
					{open ? (
						<ChevronDown className="ch-ico ch-ico--chev" size={14} />
					) : (
						<ChevronRight className="ch-ico ch-ico--chev" size={14} />
					)}
				</span>
				<span className={streaming ? "ch-row-title ch-shine" : "ch-row-title"}>Thinking</span>
				<span className="ch-row-desc">{!open && !streaming && <span className="ch-trunc">{summary}</span>}</span>
			</button>
			{open && (
				<div className="ch-body ch-body--think" id={bodyId}>
					<button
						type="button"
						className="ch-line"
						aria-label="Collapse"
						onClick={() => setOpen(false)}
						tabIndex={-1}
					/>
					<Prose text={text} />
				</div>
			)}
		</div>
	);
});

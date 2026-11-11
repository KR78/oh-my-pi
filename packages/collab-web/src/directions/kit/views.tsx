/**
 * Content views shared by the directions: prose, code, command output,
 * diffs and a per-kind tool detail. They render content, not chrome; each
 * direction wraps them in its own rows, cards or panels and styles them
 * through the `--k-*` tokens in `kit.css`.
 *
 * Long content is the rule, not the exception (a 2,000-line diff, a
 * 3,000-line test log), so every view shows a window and an explicit
 * "show all" rather than mounting everything.
 */
import type { ReactNode } from "react";
import { memo, useMemo, useState } from "react";
import { Markdown, StreamingMarkdown } from "../../components/transcript/Markdown";
import { languageFromPath, stripAnsi } from "../../tool-render/util";
import { parseDiff } from "./diff";
import { highlight } from "./highlight";
import type { ToolCallView } from "./tools";
import { diffStats, resultText, toolDiff, toolPath } from "./tools";
import "./kit.css";

export const Prose = memo(function Prose({
	text,
	streaming = false,
}: {
	text: string;
	streaming?: boolean;
}): ReactNode {
	return streaming ? <StreamingMarkdown text={text} className="kmd" /> : <Markdown text={text} className="kmd" />;
});

function ShowMore({
	hidden,
	open,
	onToggle,
	noun,
}: {
	hidden: number;
	open: boolean;
	onToggle(): void;
	noun: string;
}): ReactNode {
	return (
		<button type="button" className="k-more" onClick={onToggle} aria-expanded={open}>
			{open ? `Show less` : `Show ${hidden.toLocaleString("en-US")} more ${noun}`}
		</button>
	);
}

export const CodeView = memo(function CodeView({
	code,
	lang,
	maxLines = 24,
	numbered = true,
	startLine = 1,
	lineNumbers,
}: {
	code: string;
	lang: string | null;
	maxLines?: number;
	numbered?: boolean;
	startLine?: number;
	/** Explicit gutter numbers (null for an elided span), when lines are not contiguous. */
	lineNumbers?: readonly (number | null)[];
}): ReactNode {
	const [open, setOpen] = useState(false);
	const lines = useMemo(() => code.replace(/\n+$/, "").replaceAll("\t", "    ").split("\n"), [code]);
	const shown = open ? lines : lines.slice(0, maxLines);
	const hidden = lines.length - shown.length;
	return (
		<div className="k-code">
			<pre className="k-pre" tabIndex={0}>
				{shown.map((line, i) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: lines have no identity beyond position
					<span key={i} className="k-line">
						{numbered && <span className="k-ln">{lineNumbers ? (lineNumbers[i] ?? "") : startLine + i}</span>}
						<span className="k-lt">{line.length > 0 ? highlight(line, lang) : " "}</span>
					</span>
				))}
			</pre>
			{(hidden > 0 || open) && lines.length > maxLines && (
				<ShowMore hidden={lines.length - maxLines} open={open} onToggle={() => setOpen(v => !v)} noun="lines" />
			)}
		</div>
	);
});

/** Command output: the tail matters most, so a long log shows its last lines first. */
export const OutputView = memo(function OutputView({
	text,
	error = false,
	maxLines = 16,
}: {
	text: string;
	error?: boolean;
	maxLines?: number;
}): ReactNode {
	const [open, setOpen] = useState(false);
	const lines = useMemo(() => stripAnsi(text).replace(/\n+$/, "").replaceAll("\t", "    ").split("\n"), [text]);
	if (text.trim().length === 0) return <div className="k-empty">No output</div>;
	const long = lines.length > maxLines;
	const shown = open || !long ? lines : lines.slice(-maxLines);
	return (
		<div className={`k-out${error ? " k-out--err" : ""}`}>
			{long && !open && (
				<div className="k-elided">{(lines.length - maxLines).toLocaleString("en-US")} earlier lines hidden</div>
			)}
			<pre className="k-pre" tabIndex={0}>
				{shown.join("\n")}
			</pre>
			{long && (
				<ShowMore hidden={lines.length - maxLines} open={open} onToggle={() => setOpen(v => !v)} noun="lines" />
			)}
		</div>
	);
});

export const DiffView = memo(function DiffView({ diff, maxRows = 60 }: { diff: string; maxRows?: number }): ReactNode {
	const [open, setOpen] = useState(false);
	const rows = useMemo(() => parseDiff(diff), [diff]);
	const shown = open ? rows : rows.slice(0, maxRows);
	return (
		<div className="k-diff">
			<pre className="k-pre" tabIndex={0}>
				{shown.map((row, i) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: diff rows are positional
					<span key={i} className={`k-dr k-dr--${row.kind}`}>
						{row.kind === "hunk" ? (
							<span className="k-hunk">{row.text || "⋯"}</span>
						) : (
							<>
								<span className="k-ln">{row.line ?? ""}</span>
								<span className="k-sign" aria-hidden="true">
									{row.kind === "add" ? "+" : row.kind === "del" ? "−" : " "}
								</span>
								<span className="k-lt">
									<span className="k-sr">
										{row.kind === "add" ? "added: " : row.kind === "del" ? "removed: " : ""}
									</span>
									{row.text || " "}
								</span>
							</>
						)}
					</span>
				))}
			</pre>
			{rows.length > maxRows && (
				<ShowMore hidden={rows.length - maxRows} open={open} onToggle={() => setOpen(v => !v)} noun="lines" />
			)}
		</div>
	);
});

export function DiffCounts({ diff }: { diff: string }): ReactNode {
	const stats = diffStats(diff);
	return (
		<span className="k-counts">
			<span className="k-add">+{stats.added}</span>
			<span className="k-del">−{stats.removed}</span>
		</span>
	);
}

/** The command line of a shell call. */
export function CommandLine({ command }: { command: string }): ReactNode {
	return (
		<pre className="k-cmd" tabIndex={0}>
			<span className="k-prompt" aria-hidden="true">
				${" "}
			</span>
			{command}
		</pre>
	);
}

function argsText(args: Record<string, unknown>): string {
	try {
		return JSON.stringify(args, null, 2);
	} catch {
		return String(args);
	}
}

/**
 * What a tool did, in full: command and output, file content, the diff, the
 * matches. Each direction decides where this goes (inline, a side panel, a
 * sheet); the content is the same everywhere.
 */
export const ToolDetail = memo(function ToolDetail({
	call,
	compact = false,
}: {
	call: ToolCallView;
	compact?: boolean;
}): ReactNode {
	const output = call.status === "running" ? (call.partial ?? "") : resultText(call.result);
	const failed = call.status === "failed";
	const lines = compact ? 10 : 18;
	switch (call.kind) {
		case "shell": {
			const command =
				typeof call.args.command === "string"
					? call.args.command
					: typeof call.args.code === "string"
						? call.args.code
						: null;
			return (
				<div className="k-detail">
					{command !== null && <CommandLine command={command} />}
					{call.status === "running" && output.length === 0 ? (
						<div className="k-empty">Waiting for output</div>
					) : (
						<OutputView text={output} error={failed} maxLines={lines} />
					)}
				</div>
			);
		}
		case "edit": {
			const diff = toolDiff(call);
			if (diff) return <DiffView diff={diff} maxRows={compact ? 24 : 60} />;
			return (
				<OutputView
					text={output || (call.status === "running" ? "" : "No changes reported")}
					error={failed}
					maxLines={lines}
				/>
			);
		}
		case "write": {
			const content = typeof call.args.content === "string" ? call.args.content : null;
			const path = toolPath(call);
			if (content !== null)
				return <CodeView code={content} lang={path ? languageFromPath(path) : null} maxLines={lines} />;
			return <OutputView text={output} error={failed} maxLines={lines} />;
		}
		case "read": {
			if (failed) return <OutputView text={output} error maxLines={lines} />;
			const path = toolPath(call);
			return <ReadView text={output} lang={path ? languageFromPath(path) : null} maxLines={lines} />;
		}
		case "search":
		case "web":
		case "browser":
		case "wait":
		case "todo":
			return <OutputView text={output} error={failed} maxLines={lines} />;
		default:
			return (
				<div className="k-detail">
					{Object.keys(call.args).length > 0 && (
						<CodeView code={argsText(call.args)} lang="json" maxLines={8} numbered={false} />
					)}
					<OutputView text={output} error={failed} maxLines={lines} />
				</div>
			);
	}
});

const NUMBERED_LINE = /^(\d+):(.*)$/;
const READ_HEADER = /^\[[^\]]+\]$/;

/**
 * File reads arrive as `12:text` rows (and `…` for skipped spans), with an
 * optional `[path#TAG]` header. Shown as numbered code.
 */
function ReadView({ text, lang, maxLines }: { text: string; lang: string | null; maxLines: number }): ReactNode {
	const parsed = useMemo(() => {
		const rows = text
			.replace(/\n+$/, "")
			.split("\n")
			.filter(line => !READ_HEADER.test(line));
		const numbers: (number | null)[] = [];
		const body: string[] = [];
		let numbered = false;
		for (const row of rows) {
			const match = NUMBERED_LINE.exec(row);
			if (match) {
				numbered = true;
				numbers.push(Number(match[1]));
				body.push(match[2] ?? "");
			} else {
				numbers.push(null);
				body.push(row);
			}
		}
		return { code: body.join("\n"), numbers, numbered };
	}, [text]);
	if (text.trim().length === 0) return <div className="k-empty">Empty file</div>;
	return (
		<CodeView
			code={parsed.code}
			lang={lang}
			maxLines={maxLines}
			numbered={parsed.numbered}
			lineNumbers={parsed.numbers}
		/>
	);
}

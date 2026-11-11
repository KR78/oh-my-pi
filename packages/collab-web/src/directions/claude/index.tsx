/**
 * `claude`: the feel of a calm chat page. One centred reading column on warm
 * paper, the assistant's prose in a serif, the person's words in a soft
 * pill, the run's tool use folded into quiet one-line groups ("Ran 3
 * commands, read a file") that open in place, and long diffs or files in a
 * side panel that slides in beside the column, like an artifact. The
 * composer floats at the bottom.
 *
 * Mechanism only: its own palette, its own type, the Oz mark.
 */
import type { AssistantMessage, ToolResultMessage } from "@oh-my-pi/pi-wire";
import {
	ArrowDown,
	ArrowUp,
	ChevronDown,
	ChevronRight,
	Eye,
	FileCode2,
	PanelRightOpen,
	RotateCw,
	Square,
	X,
} from "lucide-react";
import type { ReactNode } from "react";
import { memo, useCallback, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ActiveTool, GuestClient, GuestSnapshot } from "../../lib/client";
import { languageFromPath } from "../../tool-render/util";
import serifItalic from "../fonts/newsreader-latin-wght-italic.woff2";
import serifUpright from "../fonts/newsreader-latin-wght.woff2";
import { BrandMark, useBrandName } from "../kit/brand";
import type { FontSource } from "../kit/font";
import { useDirectionFont } from "../kit/font";
import { useEscape, useFollowTail, useNarrow, useNow, useToasts } from "../kit/hooks";
import { groupTurns, useRun } from "../kit/run";
import type { TimelineItem } from "../kit/session";
import { sessionTitle } from "../kit/session";
import { BLOCK_WORDS, optionDescription, optionLabel, sendPrompt, steerState, useEnterToSend } from "../kit/steer";
import { ThemeButton } from "../kit/theme-button";
import type { ToolCallView, ToolKind } from "../kit/tools";
import { diffStats, plainStep, toolCallView, toolDiff, toolPath, toolSubject } from "../kit/tools";
import { CodeView, DiffView, Prose, ToolDetail } from "../kit/views";
import {
	EMPTY_RUN,
	ENDED_HELP,
	ENDED_RETRY,
	ENDED_TITLE,
	endedReason,
	guestsLine,
	joinDetail,
	joinHeadline,
	loadingPercent,
	seconds,
	splitPath,
} from "../kit/words";
import type { Direction, DirectionProps } from "../types";
import { dark, light } from "./tokens";
import "./claude.css";

const SERIF: readonly FontSource[] = [
	{ url: serifUpright, weight: "200 800" },
	{ url: serifItalic, weight: "200 800", style: "italic" },
];

/** What the side panel shows: a diff or a file, from one call. */
interface Artifact {
	call: ToolCallView;
	title: string;
}

/** Calls long enough to open in the side panel rather than inline. */
function panelWorthy(call: ToolCallView): boolean {
	if (call.kind === "edit") return toolDiff(call) !== null;
	if (call.kind === "write")
		return typeof call.args.content === "string" && (call.args.content as string).split("\n").length > 8;
	return false;
}

const VERBS: Record<ToolKind, [string, string, string]> = {
	shell: ["Ran", "command", "commands"],
	read: ["Read", "file", "files"],
	edit: ["Edited", "file", "files"],
	write: ["Wrote", "file", "files"],
	search: ["Searched", "time", "times"],
	browser: ["Used the browser", "", ""],
	web: ["Looked up", "page", "pages"],
	agent: ["Asked", "helper", "helpers"],
	ask: ["Asked", "question", "questions"],
	wait: ["Waited", "", ""],
	todo: ["Updated the plan", "", ""],
	other: ["Used", "tool", "tools"],
};

/** "Ran 3 commands, read a file" for a group of calls. */
function groupSummary(calls: readonly ToolCallView[]): string {
	const counts = new Map<ToolKind, number>();
	for (const call of calls) counts.set(call.kind, (counts.get(call.kind) ?? 0) + 1);
	const parts: string[] = [];
	for (const [kind, n] of counts) {
		const [verb, one, many] = VERBS[kind];
		if (!one) parts.push(verb);
		else parts.push(`${verb} ${n === 1 ? `a ${one}` : `${n} ${many}`}`);
	}
	const text = parts.join(", ").toLowerCase();
	return text[0]!.toUpperCase() + text.slice(1);
}

const ToolLine = memo(function ToolLine({
	call,
	onOpenArtifact,
}: {
	call: ToolCallView;
	onOpenArtifact(a: Artifact): void;
}): ReactNode {
	const [open, setOpen] = useState(false);
	const id = useId();
	const path = toolPath(call);
	const subject = toolSubject(call);
	const diff = call.kind === "edit" ? toolDiff(call) : null;
	const stats = diff ? diffStats(diff) : null;
	const artifact = panelWorthy(call);
	const label = plainStep(call);
	return (
		<li className="cl-tl" data-status={call.status}>
			<div className="cl-tl-row">
				<button
					type="button"
					className="cl-tl-btn"
					aria-expanded={open}
					aria-controls={id}
					onClick={() => setOpen(v => !v)}
				>
					<span className="cl-tl-dot" aria-hidden="true" />
					<span className="cl-tl-label">{label}</span>
					{subject && call.kind !== "read" && call.kind !== "edit" && call.kind !== "write" && (
						<code className="cl-tl-subject">{subject.split("\n")[0]}</code>
					)}
					{path && (call.kind === "read" || call.kind === "edit" || call.kind === "write") && (
						<span className="cl-tl-path">{splitPath(path).dir}</span>
					)}
					{stats && (
						<span className="cl-tl-stats">
							<span className="k-add">+{stats.added}</span> <span className="k-del">−{stats.removed}</span>
						</span>
					)}
					{call.status === "failed" && <span className="cl-tl-fail">failed</span>}
				</button>
				{artifact && (
					<button
						type="button"
						className="cl-tl-open"
						onClick={() => onOpenArtifact({ call, title: path ? splitPath(path).name : label })}
						aria-label={`Open ${path ? splitPath(path).name : "the change"} beside the conversation`}
						data-shot={diff ? "open-diff" : undefined}
					>
						<PanelRightOpen size={14} aria-hidden="true" />
					</button>
				)}
			</div>
			{open && (
				<div className="cl-tl-body" id={id}>
					<ToolDetail call={call} compact />
				</div>
			)}
		</li>
	);
});

/** A run of consecutive tool calls, folded into one quiet line. */
const ToolGroup = memo(function ToolGroup({
	calls,
	onOpenArtifact,
}: {
	calls: ToolCallView[];
	onOpenArtifact(a: Artifact): void;
}): ReactNode {
	const running = calls.find(call => call.status === "running") ?? null;
	const [open, setOpen] = useState(false);
	const id = useId();
	const now = useNow(1000, running !== null);
	const failed = calls.filter(call => call.status === "failed").length;
	const lastArtifact = [...calls].reverse().find(panelWorthy) ?? null;
	return (
		<div className={running ? "cl-group cl-group--live" : "cl-group"} data-shot={running ? "running" : undefined}>
			<div className="cl-group-head">
				<button
					type="button"
					className="cl-group-btn"
					aria-expanded={open}
					aria-controls={id}
					onClick={() => setOpen(v => !v)}
				>
					<BrandMark size={16} className={running ? "cl-group-mark cl-spin" : "cl-group-mark"} />
					<span className="cl-group-text">
						{running ? (
							<>
								<span className="cl-group-now">{plainStep(running)}</span>
								<span className="cl-group-time">{seconds(now - running.at)}</span>
							</>
						) : (
							groupSummary(calls)
						)}
					</span>
					{failed > 0 && !running && <span className="cl-group-fail">{failed} failed</span>}
					{open ? <ChevronDown size={15} aria-hidden="true" /> : <ChevronRight size={15} aria-hidden="true" />}
				</button>
				{lastArtifact && !open && (
					<button
						type="button"
						className="cl-chip"
						onClick={() => {
							const path = toolPath(lastArtifact);
							onOpenArtifact({
								call: lastArtifact,
								title: path ? splitPath(path).name : plainStep(lastArtifact),
							});
						}}
						data-shot={toolDiff(lastArtifact) ? "open-diff" : undefined}
					>
						<FileCode2 size={14} aria-hidden="true" />
						{(() => {
							const path = toolPath(lastArtifact);
							return path ? splitPath(path).name : "View change";
						})()}
					</button>
				)}
			</div>
			{running?.partial && !open && (
				<pre className="cl-group-tail">{running.partial.split("\n").filter(Boolean).slice(-2).join("\n")}</pre>
			)}
			{open && (
				<ol className="cl-group-list" id={id}>
					{calls.map(call => (
						<ToolLine key={call.id} call={call} onOpenArtifact={onOpenArtifact} />
					))}
				</ol>
			)}
		</div>
	);
});

const Thinking = memo(function Thinking({ text, streaming }: { text: string; streaming: boolean }): ReactNode {
	const [open, setOpen] = useState(false);
	const id = useId();
	return (
		<div className="cl-think">
			<button
				type="button"
				className="cl-think-btn"
				aria-expanded={open}
				aria-controls={id}
				onClick={() => setOpen(v => !v)}
			>
				<span className={streaming ? "cl-shimmer" : undefined}>
					{streaming ? "Thinking" : "Thought it through"}
				</span>
				{open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
			</button>
			{open && (
				<div className="cl-think-body" id={id}>
					<Prose text={text} />
				</div>
			)}
		</div>
	);
});

type Piece =
	| { kind: "text"; key: string; text: string }
	| { kind: "think"; key: string; text: string; streaming: boolean }
	| { kind: "tools"; key: string; calls: ToolCallView[] };

/** One reply's blocks, with consecutive tool calls merged into a group. */
function piecesOf(
	message: AssistantMessage,
	streaming: boolean,
	results: ReadonlyMap<string, ToolResultMessage>,
	active: ReadonlyMap<string, ActiveTool>,
): Piece[] {
	const pieces: Piece[] = [];
	message.content.forEach((block, i) => {
		if (block.type === "text" && block.text.trim()) pieces.push({ kind: "text", key: `x${i}`, text: block.text });
		else if (block.type === "thinking" && block.thinking.trim())
			pieces.push({
				kind: "think",
				key: `t${i}`,
				text: block.thinking,
				streaming: streaming && i === message.content.length - 1,
			});
		else if (block.type === "toolCall") {
			const call = toolCallView(block, results.get(block.id), active.get(block.id), streaming, message.timestamp);
			const last = pieces[pieces.length - 1];
			if (last?.kind === "tools") last.calls.push(call);
			else pieces.push({ kind: "tools", key: block.id, calls: [call] });
		}
	});
	return pieces;
}

/**
 * A turn's replies flattened so tool calls that span several replies (one
 * call per reply, as Oz works) still fold into one group.
 */
function turnPieces(
	items: readonly TimelineItem[],
	results: ReadonlyMap<string, ToolResultMessage>,
	active: ReadonlyMap<string, ActiveTool>,
): { pieces: Piece[]; notes: TimelineItem[]; streaming: boolean; failed: AssistantMessage | null } {
	const pieces: Piece[] = [];
	const notes: TimelineItem[] = [];
	let streaming = false;
	let failed: AssistantMessage | null = null;
	for (const item of items) {
		if (item.kind === "note") {
			notes.push(item);
			continue;
		}
		if (item.kind !== "reply") continue;
		streaming = streaming || item.streaming;
		if (!item.streaming && (item.message.stopReason === "error" || item.message.stopReason === "aborted"))
			failed = item.message;
		for (const piece of piecesOf(item.message, item.streaming, results, active)) {
			const last = pieces[pieces.length - 1];
			if (piece.kind === "tools" && last?.kind === "tools") last.calls.push(...piece.calls);
			else pieces.push(piece);
		}
	}
	return { pieces, notes, streaming, failed };
}

const TurnBlock = memo(function TurnBlock({
	prompt,
	items,
	results,
	active,
	onOpenArtifact,
}: {
	prompt: Extract<TimelineItem, { kind: "prompt" }> | null;
	items: readonly TimelineItem[];
	results: ReadonlyMap<string, ToolResultMessage>;
	active: ReadonlyMap<string, ActiveTool>;
	onOpenArtifact(a: Artifact): void;
}): ReactNode {
	const brand = useBrandName();
	const { pieces, notes, streaming, failed } = useMemo(
		() => turnPieces(items, results, active),
		[items, results, active],
	);
	return (
		<section className="cl-turn">
			{prompt && (
				<div className="cl-you">
					<div className="cl-you-pill">
						<span className="cl-you-name" aria-label={`${prompt.author} wrote`}>
							{prompt.author[0]?.toUpperCase()}
						</span>
						<div className="cl-you-text">
							<Prose text={prompt.text} />
						</div>
					</div>
				</div>
			)}
			{notes.map(note => (
				<p key={note.id} className="cl-note">
					{note.kind === "note" ? note.text : ""}
				</p>
			))}
			{pieces.length > 0 && (
				<div className="cl-oz" aria-label={`${brand} replied`}>
					{pieces.map(piece => {
						if (piece.kind === "text") {
							return (
								<div key={piece.key} className="cl-prose">
									<Prose text={piece.text} streaming={streaming} />
								</div>
							);
						}
						if (piece.kind === "think")
							return <Thinking key={piece.key} text={piece.text} streaming={piece.streaming} />;
						return <ToolGroup key={piece.key} calls={piece.calls} onOpenArtifact={onOpenArtifact} />;
					})}
					{failed && (
						<p className="cl-stopped" role="note">
							{failed.stopReason === "aborted"
								? "Stopped here."
								: `Something went wrong${failed.errorMessage ? `: ${failed.errorMessage}` : "."}`}
						</p>
					)}
				</div>
			)}
		</section>
	);
});

function ArtifactPanel({ artifact, onClose }: { artifact: Artifact; onClose(): void }): ReactNode {
	useEscape(onClose);
	const { call } = artifact;
	const diff = call.kind === "edit" ? toolDiff(call) : null;
	const path = toolPath(call);
	const content = typeof call.args.content === "string" ? call.args.content : null;
	const stats = diff ? diffStats(diff) : null;
	return (
		<aside className="cl-art" aria-label={`${artifact.title}, opened beside the conversation`}>
			<header className="cl-art-head">
				<FileCode2 size={16} aria-hidden="true" />
				<div className="cl-art-titles">
					<div className="cl-art-title">{artifact.title}</div>
					{path && (
						<div className="cl-art-path" title={path}>
							{path}
						</div>
					)}
				</div>
				{stats && (
					<span className="cl-art-stats">
						<span className="k-add">+{stats.added}</span> <span className="k-del">−{stats.removed}</span>
					</span>
				)}
				<button type="button" className="cl-icon" onClick={onClose} aria-label="Close (Esc)">
					<X size={16} aria-hidden="true" />
				</button>
			</header>
			<div className="cl-art-body">
				{diff ? (
					<DiffView diff={diff} maxRows={400} />
				) : content !== null ? (
					<CodeView code={content} lang={path ? languageFromPath(path) : null} maxLines={400} />
				) : (
					<ToolDetail call={call} />
				)}
			</div>
		</aside>
	);
}

function autosize(el: HTMLTextAreaElement | null, max: number): void {
	if (!el) return;
	el.style.height = "0px";
	el.style.height = `${Math.min(el.scrollHeight, max)}px`;
	el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
}

function Question({ client, snapshot }: { client: GuestClient; snapshot: GuestSnapshot }): ReactNode {
	const request = snapshot.uiRequest!;
	const brand = useBrandName();
	const [draft, setDraft] = useState(request.kind === "editor" ? (request.prefill ?? "") : "");
	const ref = useRef<HTMLTextAreaElement | null>(null);
	useLayoutEffect(() => autosize(ref.current, 200), [draft]);
	const answer = useCallback(() => client.sendUiResponse(request.reqId, draft), [client, request.reqId, draft]);
	const keys = useEnterToSend(answer);
	const skip = (): void => client.sendUiResponse(request.reqId);
	useEscape(skip);
	return (
		<div className="cl-q" role="group" aria-labelledby={`clq-${request.reqId}`} data-shot="ask">
			<div className="cl-q-kicker">
				<BrandMark size={14} /> {brand} needs an answer to keep going
			</div>
			<div className="cl-q-title" id={`clq-${request.reqId}`}>
				{request.title}
			</div>
			{request.kind === "select" ? (
				<div className="cl-q-options">
					{request.options.map((option, index) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: options are positional
						<button
							key={index}
							type="button"
							className="cl-q-option"
							onClick={() => client.sendUiResponse(request.reqId, optionLabel(option))}
						>
							<span className="cl-q-label">{optionLabel(option)}</span>
							{optionDescription(option) && <span className="cl-q-desc">{optionDescription(option)}</span>}
						</button>
					))}
				</div>
			) : (
				<textarea
					ref={ref}
					className="cl-q-input"
					rows={2}
					value={draft}
					aria-label="Your answer"
					onChange={e => setDraft(e.target.value)}
					{...keys}
				/>
			)}
			<div className="cl-q-actions">
				<button type="button" className="cl-text-btn" onClick={skip}>
					Skip this question
				</button>
				{request.kind === "editor" && (
					<button type="button" className="cl-pill-btn" onClick={answer}>
						Send answer
					</button>
				)}
			</div>
		</div>
	);
}

function Composer({ client, snapshot }: { client: GuestClient; snapshot: GuestSnapshot }): ReactNode {
	const brand = useBrandName();
	const steer = steerState(snapshot);
	const [text, setText] = useState("");
	const ref = useRef<HTMLTextAreaElement | null>(null);
	useLayoutEffect(() => autosize(ref.current, 240), [text]);
	const send = useCallback(() => {
		if (sendPrompt(client, snapshot, text)) setText("");
	}, [client, snapshot, text]);
	const keys = useEnterToSend(send);
	useEscape(() => client.sendAbort(), steer.canInterrupt && snapshot.uiRequest === null);
	const hasText = text.trim().length > 0;

	if (steer.block === "view-only") {
		return (
			<div className="cl-composer cl-composer--watch" data-shot="composer">
				<Eye size={18} aria-hidden="true" />
				<div>
					<div className="cl-watch-title">You're watching</div>
					<div className="cl-watch-text">{BLOCK_WORDS["view-only"].replace("You're watching. ", "")}</div>
				</div>
			</div>
		);
	}
	return (
		<div className="cl-dock-inner" data-shot="composer">
			{snapshot.uiRequest && steer.canSteer && (
				<Question key={snapshot.uiRequest.reqId} client={client} snapshot={snapshot} />
			)}
			<div className="cl-composer">
				<textarea
					ref={ref}
					className="cl-input"
					rows={1}
					value={text}
					disabled={!steer.canSteer}
					aria-label={`Message ${brand}`}
					placeholder={
						steer.canSteer
							? steer.working
								? `Reply to ${brand} while it works…`
								: `Reply to ${brand}…`
							: BLOCK_WORDS["not-live"]
					}
					onChange={e => setText(e.target.value)}
					{...keys}
				/>
				<div className="cl-composer-row">
					<span className="cl-composer-hint">
						{steer.working
							? steer.queued > 0
								? `${steer.queued} waiting after this step`
								: "Esc to stop"
							: (snapshot.state?.model?.name ?? "")}
					</span>
					{steer.canInterrupt && !hasText ? (
						<button
							type="button"
							className="cl-send cl-send--stop"
							onClick={() => client.sendAbort()}
							aria-label="Stop (Esc)"
							title="Stop (Esc)"
						>
							<Square size={13} fill="currentColor" aria-hidden="true" />
						</button>
					) : (
						<button
							type="button"
							className="cl-send"
							onClick={send}
							disabled={!steer.canSteer || !hasText}
							aria-label="Send (Enter)"
							title="Send (Enter)"
						>
							<ArrowUp size={17} aria-hidden="true" />
						</button>
					)}
				</div>
			</div>
		</div>
	);
}

function Join({ snapshot }: { snapshot: GuestSnapshot }): ReactNode {
	const brand = useBrandName();
	const pct = loadingPercent(snapshot);
	return (
		<div className="cl-join" role="status" aria-live="polite">
			<BrandMark size={40} className="cl-join-mark cl-spin" />
			<h2 className="cl-join-title">{joinHeadline(snapshot, brand)}</h2>
			<p className="cl-join-text">{joinDetail(snapshot)}</p>
			{pct !== null && (
				<div className="cl-join-bar" aria-hidden="true">
					<span style={{ width: `${pct}%` }} />
				</div>
			)}
		</div>
	);
}

function ClaudeApp({ client, snapshot, onRejoin }: DirectionProps): ReactNode {
	useDirectionFont("Oz Newsreader", SERIF);
	const brand = useBrandName();
	const run = useRun(snapshot);
	const turns = useMemo(() => groupTurns(run.timeline), [run.timeline]);
	const [artifact, setArtifact] = useState<Artifact | null>(null);
	const narrow = useNarrow(1000);
	const scrollRef = useRef<HTMLDivElement | null>(null);
	const { away, jump } = useFollowTail(scrollRef, [
		snapshot.entries,
		snapshot.stream,
		snapshot.activeTools,
		snapshot.working,
	]);
	const { visible: toasts, dismiss } = useToasts(snapshot.notices, 2);
	const title = sessionTitle(snapshot);
	const joining = snapshot.phase === "connecting" || (snapshot.phase === "waiting" && snapshot.entries.length === 0);
	const guests = guestsLine(snapshot);
	const reason = endedReason(snapshot);
	const closeArtifact = useCallback(() => setArtifact(null), []);

	return (
		<div className={artifact && !narrow ? "cl-app cl-app--art" : "cl-app"}>
			<div className="cl-main">
				<header className="cl-top">
					<div className="cl-top-title">
						<BrandMark size={20} className="cl-top-mark" />
						<h1 className="cl-title" title={title}>
							{title}
						</h1>
					</div>
					<div className="cl-top-meta">
						<span className={`cl-state cl-state--${snapshot.phase}`}>
							{snapshot.phase === "live"
								? snapshot.working
									? `${brand} is working`
									: "Live"
								: snapshot.phase === "ended"
									? "Ended"
									: snapshot.phase === "reconnecting"
										? "Reconnecting"
										: "Joining"}
						</span>
						<span className="cl-access">{snapshot.readOnly ? "Watching" : "You can reply"}</span>
						{guests && <span className="cl-guests">{guests}</span>}
						<ThemeButton className="cl-icon" />
					</div>
				</header>
				{toasts.length === 0 ? (
					<div aria-hidden="true" />
				) : (
					<div className="cl-toasts" aria-live="polite">
						{toasts.map(notice => (
							<div
								key={notice.id}
								className={`cl-toast cl-toast--${notice.level}`}
								role={notice.level === "error" ? "alert" : "status"}
							>
								<span>{notice.message}</span>
								<button
									type="button"
									className="cl-icon cl-icon--sm"
									onClick={() => dismiss(notice.id)}
									aria-label="Dismiss"
								>
									<X size={13} aria-hidden="true" />
								</button>
							</div>
						))}
					</div>
				)}
				<div className="cl-scroll" ref={scrollRef}>
					<div className="cl-column">
						{snapshot.phase === "reconnecting" && (
							<p className="cl-reconnect" role="status">
								{joinHeadline(snapshot, brand)}. {joinDetail(snapshot)}
							</p>
						)}
						{joining ? (
							<Join snapshot={snapshot} />
						) : turns.length === 0 ? (
							<p className="cl-empty">{EMPTY_RUN}</p>
						) : (
							turns.map(turn => (
								<TurnBlock
									key={turn.id}
									prompt={turn.prompt}
									items={turn.items}
									results={run.results}
									active={snapshot.activeTools}
									onOpenArtifact={setArtifact}
								/>
							))
						)}
						{snapshot.working && !snapshot.stream && run.current === null && (
							<div className="cl-pending" aria-live="polite">
								<BrandMark size={16} className="cl-spin" />
								<span className="cl-shimmer">Working</span>
							</div>
						)}
						{snapshot.phase === "ended" && (
							<div className="cl-ended" data-shot="ended" role="status">
								<h2 className="cl-ended-title">{ENDED_TITLE}</h2>
								<p className="cl-ended-text">
									{reason ? `${reason} ` : ""}
									{ENDED_HELP}
								</p>
								<button type="button" className="cl-text-btn" onClick={onRejoin}>
									<RotateCw size={14} aria-hidden="true" /> {ENDED_RETRY}
								</button>
							</div>
						)}
					</div>
				</div>
				{away && (
					<button type="button" className="cl-jump" onClick={jump} aria-label="Jump to the latest">
						<ArrowDown size={16} aria-hidden="true" />
					</button>
				)}
				{!joining && snapshot.phase !== "ended" && (
					<div className="cl-dock">
						<Composer client={client} snapshot={snapshot} />
					</div>
				)}
			</div>
			{artifact && (
				<>
					{narrow && <button type="button" className="cl-scrim" aria-label="Close" onClick={closeArtifact} />}
					<ArtifactPanel artifact={artifact} onClose={closeArtifact} />
				</>
			)}
		</div>
	);
}

export const claude: Direction = {
	id: "claude",
	name: "Paper",
	pitch: "A calm chat you already know how to read: one serif column, tool use folded to a line, long diffs open beside it.",
	tokens: { light, dark },
	App: ClaudeApp,
};

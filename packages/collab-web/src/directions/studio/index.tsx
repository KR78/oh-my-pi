/**
 * `studio`: the run as a shared workspace, the feel of pairing. The code is
 * the hero: a left rail of the files the run touched (and its terminal), the
 * selected file's changes in an editor pane in the middle, and the
 * conversation as a narrower panel on the right with the composer pinned to
 * it. The editor follows Oz from file to file, the way you watch a pair's
 * screen, until you pick a file yourself; "Follow Oz" hands it back.
 *
 * Under 1100 px the rail becomes a strip of file tabs above the editor; at
 * phone width the editor and the conversation are two tabs.
 */
import type { AgentSnapshot, AssistantMessage } from "@oh-my-pi/pi-wire";
import {
	ChevronDown,
	Crosshair,
	Eye,
	FilePen,
	FilePlus,
	FileText,
	RotateCw,
	Send,
	Square,
	SquareTerminal,
	X,
} from "lucide-react";
import type { ReactNode } from "react";
import { memo, useCallback, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { GuestClient, GuestSnapshot } from "../../lib/client";
import { languageFromPath } from "../../tool-render/util";
import jbm400 from "../fonts/jetbrains-mono-latin-400-normal.woff2";
import jbm600 from "../fonts/jetbrains-mono-latin-600-normal.woff2";
import { BrandMark, useBrandName } from "../kit/brand";
import type { FontSource } from "../kit/font";
import { useDirectionFont } from "../kit/font";
import { useEscape, useFollowTail, useNarrow, useNow, useToasts } from "../kit/hooks";
import type { RunView } from "../kit/run";
import { useRun } from "../kit/run";
import type { TimelineItem, TouchedFile } from "../kit/session";
import { fileKey, PHASE_WORDS, sessionTitle } from "../kit/session";
import { BLOCK_WORDS, optionDescription, optionLabel, sendPrompt, steerState, useEnterToSend } from "../kit/steer";
import { ThemeButton } from "../kit/theme-button";
import type { ToolCallView } from "../kit/tools";
import { diffStats, plainStep, toolCallView, toolDiff, toolPath, toolSubject } from "../kit/tools";
import { CodeView, DiffView, Prose, ToolDetail } from "../kit/views";
import {
	clock,
	EMPTY_RUN,
	ENDED_HELP,
	ENDED_RETRY,
	ENDED_TITLE,
	endedReason,
	initials,
	joinDetail,
	joinHeadline,
	loadingPercent,
	seconds,
	splitPath,
} from "../kit/words";
import type { Direction, DirectionProps } from "../types";
import { dark, light } from "./tokens";
import "./studio.css";

const MONO_FONT: readonly FontSource[] = [
	{ url: jbm400, weight: "400" },
	{ url: jbm600, weight: "600" },
];

/** What the editor pane shows: one touched file, or the run's terminal. */
type Pane = { kind: "file"; path: string } | { kind: "terminal" } | { kind: "helpers" };

const TERMINAL: Pane = { kind: "terminal" };

function samePane(a: Pane | null, b: Pane | null): boolean {
	if (!a || !b) return false;
	if (a.kind !== b.kind) return false;
	return a.kind !== "file" || a.path === (b as { path: string }).path;
}

/** Where a call happens: its file, the terminal for a command, else nowhere the editor can show. */
function paneOf(call: ToolCallView): Pane | null {
	if (call.kind === "shell") return TERMINAL;
	if (call.kind !== "read" && call.kind !== "edit" && call.kind !== "write") return null;
	const raw = toolPath(call);
	const path = raw ? fileKey(raw) : null;
	return path ? { kind: "file", path } : null;
}

/** Where Oz is right now, or was last: the pane the editor follows. */
function ozPane(run: RunView): Pane | null {
	if (run.current) {
		const pane = paneOf(run.current);
		if (pane) return pane;
	}
	for (let i = run.calls.length - 1; i >= 0; i--) {
		const pane = paneOf(run.calls[i]!);
		if (pane) return pane;
	}
	return null;
}

const CHANGE_ICON: Record<TouchedFile["change"], typeof FileText> = {
	edited: FilePen,
	written: FilePlus,
	read: FileText,
};

const CHANGE_WORD: Record<TouchedFile["change"], string> = { edited: "changed", written: "new", read: "read" };

function Stats({ file }: { file: TouchedFile }): ReactNode {
	if (!file.stats || file.change === "read") return null;
	return (
		<span className="st-stats">
			<span className="k-add">+{file.stats.added}</span>
			{file.stats.removed > 0 && <span className="k-del">−{file.stats.removed}</span>}
		</span>
	);
}

function Presence({ snapshot }: { snapshot: GuestSnapshot }): ReactNode {
	const people = snapshot.state?.participants ?? [];
	if (people.length === 0) return null;
	const shown = people.slice(0, 4);
	const names = people.map(p => (p.role === "host" ? `${p.name} (started it)` : p.name)).join(", ");
	return (
		<div className="st-presence" role="img" aria-label={`Here: ${names}`} title={`Here: ${names}`}>
			{shown.map((person, i) => (
				<span
					// biome-ignore lint/suspicious/noArrayIndexKey: names can repeat; position is the identity
					key={i}
					className={`st-face st-face--${person.role}`}
				>
					{initials(person.name)}
				</span>
			))}
			{people.length > shown.length && (
				<span className="st-face st-face--more">+{people.length - shown.length}</span>
			)}
		</div>
	);
}

// ---- the files rail and its narrow twin ----

function Helpers({ agents, snapshot }: { agents: readonly AgentSnapshot[]; snapshot: GuestSnapshot }): ReactNode {
	return (
		<section className="st-rail-sec" aria-label="Helper agents">
			<h2 className="st-rail-h">Helpers</h2>
			<ul className="st-helpers">
				{agents.map(agent => {
					const payload = snapshot.progress.get(agent.id);
					const p = payload?.progress;
					return (
						<li key={agent.id} className={`st-helper st-helper--${agent.status}`}>
							<span className="st-helper-dot" aria-hidden="true" />
							<span className="st-helper-text">
								<span className="st-helper-name">{agent.displayName}</span>
								<span className="st-helper-line">
									{agent.status === "running"
										? (p?.lastIntent ?? p?.currentTool ?? "working")
										: agent.status === "parked"
											? "finished"
											: agent.status}
									{p ? ` · ${p.toolCount} steps` : ""}
								</span>
							</span>
						</li>
					);
				})}
			</ul>
		</section>
	);
}

function Rail({
	files,
	shells,
	pane,
	oz,
	agents,
	snapshot,
	onPick,
}: {
	files: readonly TouchedFile[];
	shells: number;
	pane: Pane | null;
	oz: Pane | null;
	agents: readonly AgentSnapshot[];
	snapshot: GuestSnapshot;
	onPick(pane: Pane): void;
}): ReactNode {
	const changed = files.filter(f => f.change !== "read");
	const read = files.filter(f => f.change === "read");
	const item = (file: TouchedFile): ReactNode => {
		const { dir, name } = splitPath(file.path);
		const me: Pane = { kind: "file", path: file.path };
		const Icon = CHANGE_ICON[file.change];
		return (
			<li key={file.path}>
				<button
					type="button"
					className="st-file"
					aria-current={samePane(pane, me) ? "true" : undefined}
					onClick={() => onPick(me)}
					title={file.path}
					data-shot={file.change === "edited" ? "open-diff" : undefined}
				>
					<Icon size={15} className={`st-file-icon st-file-icon--${file.change}`} aria-hidden="true" />
					<span className="st-file-path">
						<span className="st-file-name">{name}</span>
						{dir && <span className="st-file-dir">{dir}</span>}
					</span>
					{samePane(oz, me) && snapshot.working ? (
						<span className="st-oz-here" aria-label="Oz is here" />
					) : (
						<Stats file={file} />
					)}
					<span className="k-sr">{CHANGE_WORD[file.change]}</span>
				</button>
			</li>
		);
	};
	return (
		<nav className="st-rail" aria-label="What the run touched">
			{shells > 0 && (
				<ul className="st-rail-list st-rail-list--top">
					<li>
						<button
							type="button"
							className="st-file"
							aria-current={pane?.kind === "terminal" ? "true" : undefined}
							onClick={() => onPick(TERMINAL)}
						>
							<SquareTerminal size={15} className="st-file-icon" aria-hidden="true" />
							<span className="st-file-path">
								<span className="st-file-name">Terminal</span>
								<span className="st-file-dir">
									{shells} command{shells === 1 ? "" : "s"}
								</span>
							</span>
							{oz?.kind === "terminal" && snapshot.working && (
								<span className="st-oz-here" aria-label="Oz is here" />
							)}
						</button>
					</li>
				</ul>
			)}
			<section className="st-rail-sec" aria-label="Changed files">
				<h2 className="st-rail-h">
					Changed <span className="st-rail-n">{changed.length}</span>
				</h2>
				{changed.length === 0 ? (
					<p className="st-rail-empty">Nothing changed yet.</p>
				) : (
					<ul className="st-rail-list">{changed.map(item)}</ul>
				)}
			</section>
			{read.length > 0 && (
				<section className="st-rail-sec" aria-label="Files read">
					<h2 className="st-rail-h">
						Read <span className="st-rail-n">{read.length}</span>
					</h2>
					<ul className="st-rail-list">{read.map(item)}</ul>
				</section>
			)}
			{agents.length > 0 && <Helpers agents={agents} snapshot={snapshot} />}
		</nav>
	);
}

/** The rail as one scrolling row of tabs, for widths where a rail would crowd the code. */
function FileStrip({
	files,
	shells,
	pane,
	oz,
	working,
	helpers,
	onPick,
}: {
	files: readonly TouchedFile[];
	shells: number;
	pane: Pane | null;
	oz: Pane | null;
	working: boolean;
	helpers: number;
	onPick(pane: Pane): void;
}): ReactNode {
	return (
		<nav className="st-strip" aria-label="What the run touched">
			{helpers > 0 && (
				<button
					type="button"
					className="st-tab"
					aria-current={pane?.kind === "helpers" ? "true" : undefined}
					onClick={() => onPick({ kind: "helpers" })}
				>
					Helpers {helpers}
				</button>
			)}
			{shells > 0 && (
				<button
					type="button"
					className="st-tab"
					aria-current={pane?.kind === "terminal" ? "true" : undefined}
					onClick={() => onPick(TERMINAL)}
				>
					<SquareTerminal size={14} aria-hidden="true" /> Terminal
					{oz?.kind === "terminal" && working && <span className="st-oz-here" aria-label="Oz is here" />}
				</button>
			)}
			{files.map(file => {
				const me: Pane = { kind: "file", path: file.path };
				const Icon = CHANGE_ICON[file.change];
				return (
					<button
						key={file.path}
						type="button"
						className="st-tab"
						aria-current={samePane(pane, me) ? "true" : undefined}
						onClick={() => onPick(me)}
						title={file.path}
						data-shot={file.change === "edited" ? "open-diff" : undefined}
					>
						<Icon size={14} className={`st-file-icon st-file-icon--${file.change}`} aria-hidden="true" />
						{splitPath(file.path).name}
						{samePane(oz, me) && working && <span className="st-oz-here" aria-label="Oz is here" />}
					</button>
				);
			})}
		</nav>
	);
}

// ---- the editor pane ----

function FilePane({ file, live }: { file: TouchedFile; live: ToolCallView | null }): ReactNode {
	const lang = languageFromPath(file.path);
	const lastRead = [...file.calls].reverse().find(c => c.kind === "read" && c.status !== "failed") ?? null;
	const hasChanges = file.diffs.length > 0 || file.written !== null;
	const [view, setView] = useState<"changes" | "file">(hasChanges ? "changes" : "file");
	const shown = hasChanges ? view : "file";
	return (
		<>
			{hasChanges && lastRead && (
				<div className="st-seg" role="tablist" aria-label="Show">
					<button
						type="button"
						role="tab"
						aria-selected={shown === "changes"}
						className="st-seg-btn"
						onClick={() => setView("changes")}
					>
						Changes
					</button>
					<button
						type="button"
						role="tab"
						aria-selected={shown === "file"}
						className="st-seg-btn"
						onClick={() => setView("file")}
					>
						As Oz read it
					</button>
				</div>
			)}
			{live && (live.kind === "edit" || live.kind === "write") && (
				<div className="st-live-edit" role="status">
					<span className="st-cursor" aria-hidden="true" />
					{plainStep(live)}
				</div>
			)}
			{shown === "changes" ? (
				<div className="st-changes">
					{file.diffs.map((diff, i) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: diffs are in call order and never reorder
						<div key={i} className="st-hunkset">
							{file.diffs.length > 1 && (
								<div className="st-hunkset-h">
									Change {i + 1} of {file.diffs.length}
								</div>
							)}
							<DiffView diff={diff} maxRows={220} />
						</div>
					))}
					{file.diffs.length === 0 && file.written !== null && (
						<CodeView code={file.written} lang={lang} maxLines={220} />
					)}
				</div>
			) : lastRead ? (
				<ToolDetail call={lastRead} />
			) : (
				<p className="st-pane-empty">Oz has not read this file in full.</p>
			)}
		</>
	);
}

function TerminalPane({ calls }: { calls: readonly ToolCallView[] }): ReactNode {
	const [all, setAll] = useState(false);
	const shown = all ? calls : calls.slice(-5);
	const now = useNow(
		1000,
		calls.some(c => c.status === "running"),
	);
	return (
		<div className="st-term">
			{calls.length > shown.length && (
				<button type="button" className="st-text-btn" onClick={() => setAll(true)}>
					Show {calls.length - shown.length} earlier commands
				</button>
			)}
			{shown.map(call => (
				<section key={call.id} className={`st-term-run st-term-run--${call.status}`}>
					<header className="st-term-h">
						<span className="st-term-step">{plainStep(call)}</span>
						<span className="st-term-meta">
							{call.status === "running"
								? `running ${seconds(now - call.at)}`
								: call.status === "failed"
									? "failed"
									: Number.isFinite(call.at)
										? clock(call.at)
										: ""}
						</span>
					</header>
					{call.intent && <p className="st-term-why">{call.intent}</p>}
					<ToolDetail call={call} />
				</section>
			))}
		</div>
	);
}

function Editor({
	run,
	pane,
	following,
	onFollow,
	joining,
	snapshot,
}: {
	run: RunView;
	pane: Pane | null;
	following: boolean;
	onFollow(): void;
	joining: boolean;
	snapshot: GuestSnapshot;
}): ReactNode {
	const brand = useBrandName();
	const file = pane?.kind === "file" ? (run.files.find(f => f.path === pane.path) ?? null) : null;
	const shells = useMemo(() => run.calls.filter(c => c.kind === "shell"), [run.calls]);
	const livePane = run.current ? paneOf(run.current) : null;
	const ozHere = samePane(pane, livePane);
	const pct = loadingPercent(snapshot);
	const { dir, name } = file ? splitPath(file.path) : { dir: "", name: "" };
	return (
		<section className="st-editor" aria-label="Editor">
			<header className="st-editor-h">
				<div className="st-crumb" title={file?.path}>
					{pane?.kind === "helpers" ? (
						<span className="st-crumb-name">Helpers</span>
					) : pane?.kind === "terminal" ? (
						<span className="st-crumb-name">Terminal</span>
					) : file ? (
						<>
							<span className="st-crumb-dir">{dir}</span>
							<span className="st-crumb-name">{name}</span>
						</>
					) : (
						<span className="st-crumb-dir">No file open</span>
					)}
				</div>
				{ozHere && run.current ? (
					<span className="st-oz-badge" role="status">
						<BrandMark size={13} /> {brand} is here
					</span>
				) : null}
				{!following && (
					<button type="button" className="st-follow" onClick={onFollow}>
						<Crosshair size={14} aria-hidden="true" /> Follow {brand}
					</button>
				)}
			</header>
			<div className="st-editor-body" tabIndex={-1}>
				{joining ? (
					<div className="st-join" role="status" aria-live="polite">
						<BrandMark size={40} className="st-join-mark" />
						<h2 className="st-join-title">{joinHeadline(snapshot, brand)}</h2>
						<p className="st-join-text">{joinDetail(snapshot)}</p>
						<div className="st-join-bar" aria-hidden="true">
							<span
								className={pct === null ? "st-join-indet" : undefined}
								style={pct === null ? undefined : { width: `${pct}%` }}
							/>
						</div>
					</div>
				) : pane?.kind === "helpers" ? (
					<Helpers agents={snapshot.agents.filter(a => a.kind === "sub")} snapshot={snapshot} />
				) : pane?.kind === "terminal" ? (
					<TerminalPane calls={shells} />
				) : file ? (
					<FilePane key={file.path} file={file} live={ozHere ? run.current : null} />
				) : (
					<div className="st-pane-empty st-pane-empty--big">
						<p>When {brand} opens or changes a file, it shows here.</p>
					</div>
				)}
			</div>
			<footer className="st-status">
				<span>{following ? `Following ${brand}` : "Browsing on your own"}</span>
				{file && <span>{languageFromPath(file.path) ?? "text"}</span>}
				{file?.stats && file.change !== "read" && (
					<span>
						+{file.stats.added} −{file.stats.removed}
					</span>
				)}
				<span className="st-status-end">
					{run.files.filter(f => f.change !== "read").length} changed · {run.calls.length} steps
				</span>
			</footer>
		</section>
	);
}

// ---- the conversation ----

type Piece =
	| { kind: "text"; key: string; text: string; streaming: boolean }
	| { kind: "think"; key: string; text: string; streaming: boolean }
	| { kind: "call"; key: string; call: ToolCallView };

function piecesOf(item: Extract<TimelineItem, { kind: "reply" }>, run: RunView, snapshot: GuestSnapshot): Piece[] {
	const m = item.message;
	const pieces: Piece[] = [];
	m.content.forEach((block, i) => {
		const tail = item.streaming && i === m.content.length - 1;
		if (block.type === "text" && block.text.trim())
			pieces.push({ kind: "text", key: `x${i}`, text: block.text, streaming: tail });
		else if (block.type === "thinking" && block.thinking.trim())
			pieces.push({ kind: "think", key: `t${i}`, text: block.thinking, streaming: tail });
		else if (block.type === "toolCall")
			pieces.push({
				kind: "call",
				key: block.id,
				call: toolCallView(
					block,
					run.results.get(block.id),
					snapshot.activeTools.get(block.id),
					item.streaming,
					m.timestamp,
				),
			});
	});
	return pieces;
}

function Thought({ text, streaming }: { text: string; streaming: boolean }): ReactNode {
	const [open, setOpen] = useState(false);
	const id = useId();
	return (
		<div className="st-thought">
			<button
				type="button"
				className="st-text-btn"
				aria-expanded={open}
				aria-controls={id}
				onClick={() => setOpen(v => !v)}
			>
				{streaming ? "Thinking" : "Thought"}
				<ChevronDown size={14} className={open ? "st-flip" : undefined} aria-hidden="true" />
			</button>
			{open && (
				<div className="st-thought-body" id={id}>
					<Prose text={text} streaming={streaming} />
				</div>
			)}
		</div>
	);
}

/** A tool call in the conversation: file and terminal calls point at the editor; the rest open in place. */
const CallChip = memo(function CallChip({
	call,
	selected,
	onShow,
}: {
	call: ToolCallView;
	selected: boolean;
	onShow(pane: Pane): void;
}): ReactNode {
	const [open, setOpen] = useState(false);
	const id = useId();
	const pane = paneOf(call);
	const diff = call.kind === "edit" ? toolDiff(call) : null;
	const stats = diff ? diffStats(diff) : null;
	const subject = toolSubject(call).split("\n")[0] ?? "";
	const label = plainStep(call);
	return (
		<div className={`st-chip st-chip--${call.status}`} data-shot={call.status === "running" ? "running" : undefined}>
			<button
				type="button"
				className="st-chip-btn"
				aria-current={selected ? "true" : undefined}
				aria-expanded={pane ? undefined : open}
				aria-controls={pane ? undefined : id}
				onClick={() => (pane ? onShow(pane) : setOpen(v => !v))}
				data-shot={diff ? "open-diff" : undefined}
				title={pane ? "Show in the editor" : undefined}
			>
				<span className="st-chip-dot" aria-hidden="true" />
				<span className="st-chip-label">{label}</span>
				{call.kind !== "read" && call.kind !== "edit" && call.kind !== "write" && subject && (
					<code className="st-chip-subject">{subject}</code>
				)}
				{stats && (
					<span className="st-stats">
						<span className="k-add">+{stats.added}</span>
						<span className="k-del">−{stats.removed}</span>
					</span>
				)}
				{call.status === "failed" && <span className="st-chip-fail">failed</span>}
			</button>
			{open && !pane && (
				<div className="st-chip-body" id={id}>
					<ToolDetail call={call} compact />
				</div>
			)}
		</div>
	);
});

const Reply = memo(function Reply({
	item,
	run,
	snapshot,
	pane,
	onShow,
}: {
	item: Extract<TimelineItem, { kind: "reply" }>;
	run: RunView;
	snapshot: GuestSnapshot;
	pane: Pane | null;
	onShow(pane: Pane): void;
}): ReactNode {
	const pieces = piecesOf(item, run, snapshot);
	const m: AssistantMessage = item.message;
	return (
		<div className="st-reply">
			{pieces.map(piece => {
				if (piece.kind === "text")
					return (
						<div key={piece.key} className="st-prose">
							<Prose text={piece.text} streaming={piece.streaming} />
						</div>
					);
				if (piece.kind === "think")
					return <Thought key={piece.key} text={piece.text} streaming={piece.streaming} />;
				return (
					<CallChip
						key={piece.key}
						call={piece.call}
						selected={samePane(pane, paneOf(piece.call))}
						onShow={onShow}
					/>
				);
			})}
			{!item.streaming && (m.stopReason === "aborted" || m.stopReason === "error") && (
				<p className="st-stop">
					{m.stopReason === "aborted" ? "Stopped here." : "Something went wrong and this step stopped."}
				</p>
			)}
		</div>
	);
});

function autosize(el: HTMLTextAreaElement | null, max: number): void {
	if (!el) return;
	el.style.height = "0px";
	el.style.height = `${Math.min(el.scrollHeight, max)}px`;
}

function Question({ client, snapshot }: { client: GuestClient; snapshot: GuestSnapshot }): ReactNode {
	const brand = useBrandName();
	const request = snapshot.uiRequest!;
	const [draft, setDraft] = useState(request.kind === "editor" ? (request.prefill ?? "") : "");
	const ref = useRef<HTMLTextAreaElement | null>(null);
	useLayoutEffect(() => autosize(ref.current, 180), [draft]);
	const answer = useCallback(() => client.sendUiResponse(request.reqId, draft), [client, request.reqId, draft]);
	const keys = useEnterToSend(answer);
	const titleId = useId();
	return (
		<section className="st-q" aria-labelledby={titleId} data-shot="ask">
			<div className="st-q-kicker">
				<BrandMark size={14} /> {brand} is waiting on you
			</div>
			<h2 className="st-q-title" id={titleId}>
				{request.title}
			</h2>
			{request.kind === "select" ? (
				<ol className="st-q-options">
					{request.options.map((option, index) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: options are positional
						<li key={index}>
							<button
								type="button"
								className="st-q-option"
								onClick={() => client.sendUiResponse(request.reqId, optionLabel(option))}
							>
								<span className="st-q-n" aria-hidden="true">
									{index + 1}
								</span>
								<span className="st-q-text">
									<span className="st-q-label">{optionLabel(option)}</span>
									{optionDescription(option) && <span className="st-q-desc">{optionDescription(option)}</span>}
								</span>
							</button>
						</li>
					))}
				</ol>
			) : (
				<textarea
					ref={ref}
					className="st-input st-input--boxed"
					rows={2}
					value={draft}
					aria-label="Your answer"
					onChange={e => setDraft(e.target.value)}
					{...keys}
				/>
			)}
			<div className="st-q-actions">
				<button type="button" className="st-text-btn" onClick={() => client.sendUiResponse(request.reqId)}>
					Let {brand} decide
				</button>
				{request.kind === "editor" && (
					<button type="button" className="st-btn st-btn--primary" onClick={answer}>
						Send answer
					</button>
				)}
			</div>
		</section>
	);
}

function Composer({ client, snapshot }: { client: GuestClient; snapshot: GuestSnapshot }): ReactNode {
	const brand = useBrandName();
	const steer = steerState(snapshot);
	const [text, setText] = useState("");
	const ref = useRef<HTMLTextAreaElement | null>(null);
	useLayoutEffect(() => autosize(ref.current, 200), [text]);
	const send = useCallback(() => {
		if (sendPrompt(client, snapshot, text)) setText("");
	}, [client, snapshot, text]);
	const keys = useEnterToSend(send);
	if (steer.block === "view-only") {
		return (
			<div className="st-watch" data-shot="composer">
				<Eye size={18} aria-hidden="true" />
				<p>{BLOCK_WORDS["view-only"]}</p>
			</div>
		);
	}
	return (
		<div className="st-composer" data-shot="composer">
			<textarea
				ref={ref}
				className="st-input"
				rows={1}
				value={text}
				disabled={!steer.canSteer}
				aria-label={`Message ${brand}`}
				placeholder={
					steer.canSteer
						? steer.working
							? `Steer ${brand} while it works`
							: `Ask ${brand} for the next change`
						: BLOCK_WORDS["not-live"]
				}
				onChange={e => setText(e.target.value)}
				{...keys}
			/>
			<div className="st-composer-row">
				<span className="st-composer-hint">
					{!steer.canSteer
						? ""
						: steer.working
							? steer.queued > 0
								? `${steer.queued} waiting after this step`
								: "Enter sends after this step · Esc stops"
							: "Enter sends · Shift+Enter for a new line"}
				</span>
				{steer.canInterrupt && (
					<button
						type="button"
						className="st-btn st-btn--stop"
						onClick={() => client.sendAbort()}
						title="Stop (Esc)"
					>
						<Square size={12} fill="currentColor" aria-hidden="true" /> Stop
					</button>
				)}
				<button
					type="button"
					className="st-btn st-btn--primary"
					onClick={send}
					disabled={!steer.canSteer || !text.trim()}
					aria-label="Send"
				>
					<Send size={14} aria-hidden="true" />
					<span className="st-btn-word">Send</span>
				</button>
			</div>
		</div>
	);
}

function Conversation({
	client,
	snapshot,
	run,
	pane,
	onShow,
	joining,
	onRejoin,
}: {
	client: GuestClient;
	snapshot: GuestSnapshot;
	run: RunView;
	pane: Pane | null;
	onShow(pane: Pane): void;
	joining: boolean;
	onRejoin(): void;
}): ReactNode {
	const scrollRef = useRef<HTMLDivElement | null>(null);
	const { away, jump } = useFollowTail(scrollRef, [snapshot.entries, snapshot.stream, snapshot.activeTools]);
	const { visible: toasts, dismiss } = useToasts(snapshot.notices, 2);
	const steer = steerState(snapshot);
	const reason = endedReason(snapshot);
	return (
		<section className="st-convo" aria-label="Conversation">
			{toasts.length > 0 && (
				<div className="st-toasts" aria-live="polite">
					{toasts.map(n => (
						<div
							key={n.id}
							className={`st-toast st-toast--${n.level}`}
							role={n.level === "error" ? "alert" : "status"}
						>
							<span>{n.message}</span>
							<button type="button" className="st-icon-btn" onClick={() => dismiss(n.id)} aria-label="Dismiss">
								<X size={14} aria-hidden="true" />
							</button>
						</div>
					))}
				</div>
			)}
			<div className="st-convo-scroll" ref={scrollRef}>
				{!joining && run.timeline.length === 0 && <p className="st-pane-empty">{EMPTY_RUN}</p>}
				{run.timeline.map(item => {
					if (item.kind === "prompt")
						return (
							<div key={item.id} className={`st-prompt${item.byGuest ? " st-prompt--guest" : ""}`}>
								<div className="st-prompt-who">
									<span className={`st-face st-face--${item.byGuest ? "guest" : "host"}`} aria-hidden="true">
										{initials(item.author)}
									</span>
									<strong>{item.author}</strong>
									{Number.isFinite(item.at) && <span className="st-prompt-time">{clock(item.at)}</span>}
								</div>
								<div className="st-prompt-text">
									<Prose text={item.text} />
								</div>
							</div>
						);
					if (item.kind === "note")
						return (
							<p key={item.id} className="st-note">
								{item.text}
							</p>
						);
					return <Reply key={item.id} item={item} run={run} snapshot={snapshot} pane={pane} onShow={onShow} />;
				})}
			</div>
			{away && (
				<button type="button" className="st-latest" onClick={jump}>
					Latest
				</button>
			)}
			{snapshot.phase === "ended" ? (
				<div className="st-ended" data-shot="ended" role="status">
					<h2 className="st-ended-title">{ENDED_TITLE}</h2>
					<p>
						{reason ? `${reason} ` : ""}
						{ENDED_HELP}
					</p>
					<button type="button" className="st-btn st-btn--quiet" onClick={onRejoin}>
						<RotateCw size={14} aria-hidden="true" /> {ENDED_RETRY}
					</button>
				</div>
			) : joining ? null : (
				<div className="st-dock">
					{snapshot.uiRequest && steer.canSteer && (
						<Question key={snapshot.uiRequest.reqId} client={client} snapshot={snapshot} />
					)}
					<Composer client={client} snapshot={snapshot} />
				</div>
			)}
		</section>
	);
}

// ---- the page ----

function StudioApp({ client, snapshot, onRejoin }: DirectionProps): ReactNode {
	useDirectionFont("Oz JetBrains Mono", MONO_FONT);
	const brand = useBrandName();
	const run = useRun(snapshot);
	const steer = steerState(snapshot);
	const railFits = !useNarrow(1099);
	const phone = useNarrow(759);
	const [picked, setPicked] = useState<Pane | null>(null);
	const [tab, setTab] = useState<"code" | "chat">("code");
	const oz = useMemo(() => ozPane(run), [run]);
	const following = picked === null;
	const pane: Pane | null = picked ?? oz ?? (run.files[0] ? { kind: "file", path: run.files[0].path } : null);
	const shells = useMemo(() => run.calls.reduce((n, c) => n + (c.kind === "shell" ? 1 : 0), 0), [run.calls]);
	const subs = snapshot.agents.filter(a => a.kind === "sub");
	const joining = snapshot.phase === "connecting" || (snapshot.phase === "waiting" && snapshot.entries.length === 0);
	useEscape(() => client.sendAbort(), steer.canInterrupt && snapshot.uiRequest === null);

	const show = useCallback(
		(next: Pane) => {
			setPicked(samePane(next, oz) && snapshot.working ? null : next);
			if (phone) setTab("code");
		},
		[oz, snapshot.working, phone],
	);
	const pick = useCallback((next: Pane) => setPicked(next), []);

	const editor = (
		<div className="st-work">
			{!railFits && (
				<FileStrip
					files={run.files}
					shells={shells}
					pane={pane}
					oz={oz}
					working={snapshot.working}
					helpers={subs.length}
					onPick={pick}
				/>
			)}
			<Editor
				run={run}
				pane={pane}
				following={following}
				onFollow={() => setPicked(null)}
				joining={joining}
				snapshot={snapshot}
			/>
		</div>
	);
	const convo = (
		<Conversation
			client={client}
			snapshot={snapshot}
			run={run}
			pane={pane}
			onShow={show}
			joining={joining}
			onRejoin={onRejoin}
		/>
	);
	const phase = snapshot.phase;

	return (
		<div className={`st-app${phone ? " st-app--phone" : railFits ? " st-app--wide" : ""}`}>
			<header className="st-top">
				<BrandMark size={20} className="st-mark" />
				<div className="st-top-text">
					<h1 className="st-title">{sessionTitle(snapshot)}</h1>
					<span className={`st-phase st-phase--${phase}`}>
						<span className="st-phase-dot" aria-hidden="true" />
						{phase === "live" ? (snapshot.working ? `${brand} is working` : "Live") : PHASE_WORDS[phase]}
					</span>
				</div>
				<Presence snapshot={snapshot} />
				<span className={`st-access${snapshot.readOnly ? " st-access--view" : ""}`}>
					{snapshot.readOnly ? "Watching" : "Pairing"}
				</span>
				<ThemeButton className="st-icon-btn" size={16} />
			</header>
			{phase === "reconnecting" && (
				<p className="st-banner" role="status">
					{joinHeadline(snapshot, brand)}. {joinDetail(snapshot)}
				</p>
			)}
			{phone ? (
				<>
					<div className="st-phone-tabs" role="tablist" aria-label="View">
						<button
							type="button"
							role="tab"
							aria-selected={tab === "code"}
							className="st-phone-tab"
							onClick={() => setTab("code")}
						>
							Code
						</button>
						<button
							type="button"
							role="tab"
							aria-selected={tab === "chat"}
							className="st-phone-tab"
							onClick={() => setTab("chat")}
							data-shot={tab === "code" ? "open-composer" : undefined}
						>
							Conversation
							{snapshot.uiRequest && tab === "code" && (
								<span className="st-phone-flag" aria-label="question waiting" />
							)}
						</button>
					</div>
					{phase === "ended" && tab === "code" && (
						<p className="st-banner st-banner--ended" role="status">
							{ENDED_TITLE}. {ENDED_HELP}
						</p>
					)}
					<div className="st-phone-body">{tab === "code" ? editor : convo}</div>
					{tab === "code" && snapshot.readOnly && phase !== "ended" && (
						<div className="st-watch st-watch--slim" data-shot="composer">
							<Eye size={16} aria-hidden="true" />
							<p>You're watching. This link can follow the run but not steer it.</p>
						</div>
					)}
				</>
			) : (
				<div className="st-body">
					{railFits && (
						<Rail
							files={run.files}
							shells={shells}
							pane={pane}
							oz={oz}
							agents={subs}
							snapshot={snapshot}
							onPick={pick}
						/>
					)}
					{editor}
					{convo}
				</div>
			)}
		</div>
	);
}

export const studio: Direction = {
	id: "studio",
	name: "Studio",
	pitch: "Pairing: the code is the hero. Files the run touched on the left, the change in the middle following Oz, the conversation and composer on the right.",
	tokens: { light, dark },
	App: StudioApp,
};

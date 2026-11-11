/**
 * `console`: a run console for engineers who want everything at once. A
 * status rail across the top (phase, model, context, steps, cost, people);
 * the transcript on the left as a dense log, one line per event; on the
 * right a "now" panel: the selected (or running) tool's command and its
 * output streaming, then the files touched and the diff so far. The
 * composer is a command bar at the foot; `/` focuses it from anywhere.
 */
import type { AssistantMessage, ToolResultMessage } from "@oh-my-pi/pi-wire";
import { Eye, RotateCw, X } from "lucide-react";
import type { ReactNode } from "react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ActiveTool, GuestClient, GuestSnapshot } from "../../lib/client";
import { fmtCost, fmtTokens } from "../../lib/format";
import plex400 from "../fonts/ibm-plex-mono-latin-400-normal.woff2";
import plex500 from "../fonts/ibm-plex-mono-latin-500-normal.woff2";
import { BrandMark, useBrandName } from "../kit/brand";
import type { FontSource } from "../kit/font";
import { useDirectionFont } from "../kit/font";
import { useEscape, useFollowTail, useNarrow, useNow, useToasts } from "../kit/hooks";
import type { RunView } from "../kit/run";
import { useRun } from "../kit/run";
import type { TouchedFile } from "../kit/session";
import { contextPercent, runUsage, sessionTitle } from "../kit/session";
import { BLOCK_WORDS, optionDescription, optionLabel, sendPrompt, steerState, useEnterToSend } from "../kit/steer";
import { ThemeButton } from "../kit/theme-button";
import type { ToolCallView } from "../kit/tools";
import { diffStats, toolCallView, toolDiff, toolSubject } from "../kit/tools";
import { DiffView, Prose, ToolDetail } from "../kit/views";
import {
	clock,
	EMPTY_RUN,
	ENDED_HELP,
	ENDED_RETRY,
	ENDED_TITLE,
	endedReason,
	joinDetail,
	joinHeadline,
	loadingPercent,
	seconds,
	splitPath,
} from "../kit/words";
import type { Direction, DirectionProps } from "../types";
import { dark, light } from "./tokens";
import "./console.css";

const PLEX: readonly FontSource[] = [
	{ url: plex400, weight: "400" },
	{ url: plex500, weight: "500" },
];

const KIND_TAG: Record<ToolCallView["kind"], string> = {
	shell: "sh",
	read: "rd",
	edit: "ed",
	write: "wr",
	search: "sr",
	browser: "br",
	web: "net",
	agent: "ag",
	ask: "ask",
	wait: "wt",
	todo: "pl",
	other: "fn",
};

type LogLine =
	| { kind: "prompt"; id: string; at: number; who: string; text: string }
	| { kind: "text"; id: string; at: number; text: string; streaming: boolean }
	| { kind: "think"; id: string; at: number; text: string }
	| { kind: "tool"; id: string; at: number; call: ToolCallView }
	| { kind: "note"; id: string; at: number; text: string }
	| { kind: "stop"; id: string; at: number; message: AssistantMessage };

function logLines(
	run: RunView,
	results: ReadonlyMap<string, ToolResultMessage>,
	active: ReadonlyMap<string, ActiveTool>,
): LogLine[] {
	const lines: LogLine[] = [];
	for (const item of run.timeline) {
		if (item.kind === "prompt")
			lines.push({ kind: "prompt", id: item.id, at: item.at, who: item.author, text: item.text });
		else if (item.kind === "note") lines.push({ kind: "note", id: item.id, at: item.at, text: item.text });
		else {
			const m = item.message;
			m.content.forEach((block, i) => {
				const id = `${item.id}:${i}`;
				if (block.type === "text" && block.text.trim())
					lines.push({ kind: "text", id, at: item.at, text: block.text, streaming: item.streaming });
				else if (block.type === "thinking" && block.thinking.trim())
					lines.push({ kind: "think", id, at: item.at, text: block.thinking });
				else if (block.type === "toolCall")
					lines.push({
						kind: "tool",
						id: block.id,
						at: item.at,
						call: toolCallView(block, results.get(block.id), active.get(block.id), item.streaming, m.timestamp),
					});
			});
			if (!item.streaming && (m.stopReason === "error" || m.stopReason === "aborted"))
				lines.push({ kind: "stop", id: `${item.id}:stop`, at: item.at, message: m });
		}
	}
	return lines;
}

function Ts({ at }: { at: number }): ReactNode {
	return <span className="co-ts">{Number.isFinite(at) ? clock(at) : "--:--"}</span>;
}

const LogRow = memo(function LogRow({
	line,
	selected,
	onSelect,
}: {
	line: LogLine;
	selected: boolean;
	onSelect(id: string): void;
}): ReactNode {
	const [open, setOpen] = useState(false);
	switch (line.kind) {
		case "prompt":
			return (
				<li className="co-l co-l--prompt">
					<Ts at={line.at} />
					<span className="co-tag co-tag--you">{line.who}</span>
					<div className="co-l-body">
						<Prose text={line.text} />
					</div>
				</li>
			);
		case "text":
			return (
				<li className="co-l co-l--text">
					<Ts at={line.at} />
					<span className="co-tag co-tag--oz">oz</span>
					<div className="co-l-body">
						<Prose text={line.text} streaming={line.streaming} />
					</div>
				</li>
			);
		case "think":
			return (
				<li className="co-l co-l--think">
					<Ts at={line.at} />
					<span className="co-tag">think</span>
					<button type="button" className="co-l-fold" aria-expanded={open} onClick={() => setOpen(v => !v)}>
						{open ? <Prose text={line.text} /> : <span className="co-ell">{line.text.replace(/\s+/g, " ")}</span>}
					</button>
				</li>
			);
		case "note":
			return (
				<li className="co-l co-l--note">
					<Ts at={line.at} />
					<span className="co-tag">note</span>
					<span className="co-l-body co-muted">{line.text}</span>
				</li>
			);
		case "stop":
			return (
				<li className="co-l co-l--stop">
					<Ts at={line.at} />
					<span className="co-tag co-tag--err">{line.message.stopReason === "aborted" ? "stop" : "err"}</span>
					<span className="co-l-body">
						{line.message.stopReason === "aborted"
							? "Interrupted."
							: (line.message.errorMessage ?? "The step failed.")}
					</span>
				</li>
			);
		case "tool": {
			const { call } = line;
			const diff = call.kind === "edit" ? toolDiff(call) : null;
			const stats = diff ? diffStats(diff) : null;
			const subject = toolSubject(call).split("\n")[0] ?? "";
			return (
				<li
					className={`co-l co-l--tool co-st--${call.status}`}
					data-shot={call.status === "running" ? "running" : undefined}
				>
					<Ts at={line.at} />
					<span className={`co-tag co-tag--tool co-st-${call.status}`}>{KIND_TAG[call.kind]}</span>
					<button
						type="button"
						className="co-l-tool"
						aria-pressed={selected}
						aria-label={`${call.name} ${subject}, ${call.status}. Show in the inspector`}
						onClick={() => onSelect(call.id)}
						data-shot={diff ? "open-diff" : undefined}
					>
						<span className="co-l-name">{call.name}</span>
						<span className="co-l-subject">{subject}</span>
						{stats && (
							<span className="co-l-stats">
								<span className="k-add">+{stats.added}</span> <span className="k-del">−{stats.removed}</span>
							</span>
						)}
						<span className={`co-l-st co-st-${call.status}`}>
							{call.status === "running" ? "run" : call.status === "failed" ? "fail" : "ok"}
						</span>
					</button>
				</li>
			);
		}
	}
});

function RailCell({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }): ReactNode {
	return (
		<div className={wide ? "co-cell co-cell--wide" : "co-cell"}>
			<span className="co-cell-label">{label}</span>
			<span className="co-cell-value">{children}</span>
		</div>
	);
}

function Rail({ snapshot, run }: { snapshot: GuestSnapshot; run: RunView }): ReactNode {
	const brand = useBrandName();
	const pct = contextPercent(snapshot.state);
	const usage = useMemo(() => runUsage(snapshot.entries), [snapshot.entries]);
	const title = sessionTitle(snapshot);
	const people = snapshot.state?.participants ?? [];
	const failed = run.calls.filter(c => c.status === "failed").length;
	const phase = snapshot.phase === "live" ? (snapshot.working ? "RUNNING" : "IDLE") : snapshot.phase.toUpperCase();
	return (
		<header className="co-rail">
			<div className="co-rail-id">
				<BrandMark size={18} className="co-mark" />
				<span className="co-brand">{brand}</span>
				<span className="co-sep" aria-hidden="true">
					/
				</span>
				<h1 className="co-title" title={title}>
					{title}
				</h1>
			</div>
			<div className="co-cells">
				<RailCell label="state">
					<span className={`co-phase co-phase--${snapshot.phase}${snapshot.working ? " co-phase--working" : ""}`}>
						{phase}
					</span>
				</RailCell>
				<RailCell label="access">{snapshot.readOnly ? "watch" : "steer"}</RailCell>
				{snapshot.state?.model && <RailCell label="model">{snapshot.state.model.name}</RailCell>}
				{pct !== null && (
					<RailCell label="ctx" wide>
						<span className="co-meter" aria-hidden="true">
							<span style={{ width: `${Math.min(100, pct)}%` }} />
						</span>
						{pct.toFixed(0)}%
					</RailCell>
				)}
				<RailCell label="tools">
					{run.calls.length}
					{failed > 0 && <span className="co-err-n"> · {failed} fail</span>}
				</RailCell>
				{usage.cost > 0 && <RailCell label="cost">{fmtCost(usage.cost)}</RailCell>}
				{usage.output > 0 && <RailCell label="out">{fmtTokens(usage.output)}</RailCell>}
				<RailCell label="here">
					<span
						className="co-people"
						title={people
							.map(p => `${p.name} (${p.role === "host" ? "host" : p.readOnly ? "watching" : "steering"})`)
							.join(", ")}
					>
						{people.length}
					</span>
				</RailCell>
			</div>
			<ThemeButton className="co-btn co-btn--icon" size={15} />
		</header>
	);
}

function FilesList({
	files,
	selected,
	onPick,
}: {
	files: readonly TouchedFile[];
	selected: string | null;
	onPick(path: string): void;
}): ReactNode {
	if (files.length === 0) return <p className="co-empty-line">No files touched yet.</p>;
	return (
		<ul className="co-files">
			{files.map(file => {
				const { dir, name } = splitPath(file.path);
				return (
					<li key={file.path}>
						<button
							type="button"
							className="co-file"
							aria-pressed={selected === file.path}
							onClick={() => onPick(file.path)}
							title={file.path}
						>
							<span className={`co-file-op co-file-op--${file.change}`}>
								{file.change === "edited" ? "M" : file.change === "written" ? "A" : "R"}
							</span>
							<span className="co-file-path">
								<span className="co-file-dir">{dir}</span>
								<span className="co-file-name">{name}</span>
							</span>
							{file.stats && (
								<span className="co-file-stats">
									<span className="k-add">+{file.stats.added}</span>{" "}
									<span className="k-del">−{file.stats.removed}</span>
								</span>
							)}
						</button>
					</li>
				);
			})}
		</ul>
	);
}

function Inspector({ run, focusId, onClose }: { run: RunView; focusId: string | null; onClose(): void }): ReactNode {
	const now = useNow(1000, run.current !== null);
	const [filePath, setFilePath] = useState<string | null>(null);
	const focused = focusId ? (run.calls.find(c => c.id === focusId) ?? null) : null;
	const call = focused ?? run.current ?? run.calls[run.calls.length - 1] ?? null;
	const pinned = focused !== null;
	const file = filePath ? run.files.find(f => f.path === filePath) : null;
	const diff = file && file.diffs.length > 0 ? file.diffs.join("\n\n") : null;
	return (
		<aside className="co-insp" aria-label="Inspector">
			<section className="co-pane co-pane--now">
				<header className="co-pane-head">
					<span className="co-pane-title">
						{pinned ? "selected" : call?.status === "running" ? "now running" : "last tool"}
					</span>
					{call && (
						<span className={`co-badge co-st-${call.status}`}>
							{call.status === "running"
								? `running ${seconds(now - call.at)}`
								: call.status === "failed"
									? "failed"
									: "done"}
						</span>
					)}
					{pinned && (
						<button type="button" className="co-btn co-btn--ghost" onClick={onClose}>
							follow live
						</button>
					)}
				</header>
				{call ? (
					<div className="co-pane-body">
						<div className="co-now-name">
							<span className={`co-tag co-tag--tool co-st-${call.status}`}>{KIND_TAG[call.kind]}</span>
							<span>{call.name}</span>
							{call.intent && <span className="co-muted co-ell">· {call.intent}</span>}
						</div>
						<ToolDetail call={call} />
					</div>
				) : (
					<p className="co-empty-line">No tool has run yet.</p>
				)}
			</section>
			<section className="co-pane co-pane--files">
				<header className="co-pane-head">
					<span className="co-pane-title">files</span>
					<span className="co-muted">{run.files.length}</span>
				</header>
				<div className="co-pane-body">
					<FilesList
						files={run.files}
						selected={filePath}
						onPick={p => setFilePath(prev => (prev === p ? null : p))}
					/>
					{file && (
						<div className="co-file-diff">
							<div className="co-file-diff-head">
								<span className="co-ell" title={file.path}>
									{file.path}
								</span>
								<button
									type="button"
									className="co-btn co-btn--icon"
									onClick={() => setFilePath(null)}
									aria-label="Close the file"
								>
									<X size={14} aria-hidden="true" />
								</button>
							</div>
							{diff ? (
								<DiffView diff={diff} maxRows={120} />
							) : (
								<p className="co-empty-line">Read only; no changes to this file.</p>
							)}
						</div>
					)}
				</div>
			</section>
		</aside>
	);
}

function Ask({ client, snapshot }: { client: GuestClient; snapshot: GuestSnapshot }): ReactNode {
	const request = snapshot.uiRequest!;
	const [draft, setDraft] = useState(request.kind === "editor" ? (request.prefill ?? "") : "");
	const answer = useCallback(() => client.sendUiResponse(request.reqId, draft), [client, request.reqId, draft]);
	const keys = useEnterToSend(answer);
	const skip = (): void => client.sendUiResponse(request.reqId);
	useEscape(skip);
	useEffect(() => {
		if (request.kind !== "select") return;
		const onKey = (e: KeyboardEvent): void => {
			const target = e.target as HTMLElement | null;
			if (target && (target.tagName === "TEXTAREA" || target.tagName === "INPUT")) return;
			const n = Number(e.key);
			const option = request.options[n - 1];
			if (Number.isInteger(n) && option !== undefined) {
				e.preventDefault();
				client.sendUiResponse(request.reqId, optionLabel(option));
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [client, request]);
	return (
		<div className="co-ask" role="group" aria-labelledby={`coask-${request.reqId}`} data-shot="ask">
			<div className="co-ask-head">
				<span className="co-tag co-tag--ask">ask</span>
				<span id={`coask-${request.reqId}`} className="co-ask-title">
					{request.title}
				</span>
				<button type="button" className="co-btn co-btn--ghost" onClick={skip}>
					skip <kbd>esc</kbd>
				</button>
			</div>
			{request.kind === "select" ? (
				<ol className="co-ask-opts">
					{request.options.map((option, i) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: options are positional
						<li key={i}>
							<button
								type="button"
								className="co-ask-opt"
								onClick={() => client.sendUiResponse(request.reqId, optionLabel(option))}
							>
								<kbd>{i + 1}</kbd>
								<span className="co-ask-label">{optionLabel(option)}</span>
								{optionDescription(option) && (
									<span className="co-muted co-ask-desc">{optionDescription(option)}</span>
								)}
							</button>
						</li>
					))}
				</ol>
			) : (
				<div className="co-ask-edit">
					<textarea
						className="co-ask-input"
						rows={2}
						value={draft}
						aria-label="Your answer"
						onChange={e => setDraft(e.target.value)}
						{...keys}
					/>
					<button type="button" className="co-btn co-btn--primary" onClick={answer}>
						answer <kbd>↵</kbd>
					</button>
				</div>
			)}
		</div>
	);
}

function CommandBar({ client, snapshot }: { client: GuestClient; snapshot: GuestSnapshot }): ReactNode {
	const steer = steerState(snapshot);
	const [text, setText] = useState("");
	const ref = useRef<HTMLInputElement | null>(null);
	const send = useCallback(() => {
		if (sendPrompt(client, snapshot, text)) setText("");
	}, [client, snapshot, text]);
	const keys = useEnterToSend(send);
	useEscape(() => client.sendAbort(), steer.canInterrupt && snapshot.uiRequest === null);
	useEffect(() => {
		const onKey = (e: KeyboardEvent): void => {
			if (e.key !== "/" || e.metaKey || e.ctrlKey) return;
			const target = e.target as HTMLElement | null;
			if (target && (target.tagName === "TEXTAREA" || target.tagName === "INPUT" || target.isContentEditable))
				return;
			e.preventDefault();
			ref.current?.focus();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	if (steer.block === "view-only") {
		return (
			<div className="co-bar co-bar--ro" data-shot="composer">
				<Eye size={14} aria-hidden="true" />
				<span>
					<strong>read-only.</strong> {BLOCK_WORDS["view-only"].replace("You're watching. ", "")}
				</span>
			</div>
		);
	}
	return (
		<div className="co-bar-wrap" data-shot="composer">
			{snapshot.uiRequest && steer.canSteer && (
				<Ask key={snapshot.uiRequest.reqId} client={client} snapshot={snapshot} />
			)}
			<div className="co-bar">
				<span className="co-prompt" aria-hidden="true">
					›
				</span>
				<input
					ref={ref}
					className="co-input"
					value={text}
					disabled={!steer.canSteer}
					aria-label="Message to the run. Press / to focus"
					placeholder={steer.canSteer ? "message the run" : BLOCK_WORDS["not-live"]}
					onChange={e => setText(e.target.value)}
					{...keys}
				/>
				{steer.working && steer.queued > 0 && <span className="co-muted co-queued">{steer.queued} queued</span>}
				<span className="co-keys" aria-hidden="true">
					{text ? (
						<>
							<kbd>↵</kbd> send
						</>
					) : (
						<>
							<kbd>/</kbd> focus
						</>
					)}
				</span>
				{steer.canInterrupt && (
					<button type="button" className="co-btn co-btn--stop" onClick={() => client.sendAbort()}>
						interrupt <kbd>esc</kbd>
					</button>
				)}
				<button
					type="button"
					className="co-btn co-btn--primary"
					onClick={send}
					disabled={!steer.canSteer || !text.trim()}
				>
					send
				</button>
			</div>
		</div>
	);
}

function ConsoleApp({ client, snapshot, onRejoin }: DirectionProps): ReactNode {
	useDirectionFont("Oz Plex Mono", PLEX);
	const brand = useBrandName();
	const run = useRun(snapshot);
	const lines = useMemo(() => logLines(run, run.results, snapshot.activeTools), [run, snapshot.activeTools]);
	const [focusId, setFocusId] = useState<string | null>(null);
	const narrow = useNarrow(900);
	const [tab, setTab] = useState<"log" | "inspect">("log");
	const logRef = useRef<HTMLOListElement | null>(null);
	const { away, jump } = useFollowTail(logRef, [lines]);
	const { visible: toasts, dismiss } = useToasts(snapshot.notices, 4);
	const joining = snapshot.phase === "connecting" || (snapshot.phase === "waiting" && snapshot.entries.length === 0);
	const pct = loadingPercent(snapshot);
	const select = useCallback(
		(id: string) => {
			setFocusId(prev => (prev === id ? null : id));
			if (narrow) setTab("inspect");
		},
		[narrow],
	);
	const reason = endedReason(snapshot);

	return (
		<div className="co-app">
			<Rail snapshot={snapshot} run={run} />
			{snapshot.phase === "reconnecting" && (
				<div className="co-strip co-strip--warn" role="status">
					<span className="co-tag co-tag--err">link</span> {joinHeadline(snapshot, brand)}. {joinDetail(snapshot)}
				</div>
			)}
			{snapshot.phase === "ended" && (
				<div className="co-strip co-strip--ended" role="status" data-shot="ended">
					<span className="co-tag">end</span>
					<span>
						<strong>{ENDED_TITLE}.</strong> {reason ? `${reason} ` : ""}
						{ENDED_HELP}
					</span>
					<button type="button" className="co-btn co-btn--ghost" onClick={onRejoin}>
						<RotateCw size={13} aria-hidden="true" /> {ENDED_RETRY}
					</button>
				</div>
			)}
			{narrow && !joining && (
				<div className="co-tabs" role="tablist" aria-label="View">
					<button type="button" role="tab" aria-selected={tab === "log"} onClick={() => setTab("log")}>
						log <span className="co-muted">{lines.length}</span>
					</button>
					<button type="button" role="tab" aria-selected={tab === "inspect"} onClick={() => setTab("inspect")}>
						inspector {run.current && <span className="co-dot" aria-label="a tool is running" />}
					</button>
				</div>
			)}
			{joining ? (
				<div className="co-join" role="status" aria-live="polite">
					<div className="co-join-lines">
						<div>
							<span className="co-ok">✓</span> page loaded
						</div>
						<div>
							{snapshot.phase === "connecting" ? (
								<span className="co-blink">▍</span>
							) : (
								<span className="co-ok">✓</span>
							)}{" "}
							encrypted link to relay
						</div>
						<div>
							{snapshot.phase === "waiting" ? (
								<span className="co-blink">▍</span>
							) : (
								<span className="co-muted">·</span>
							)}{" "}
							{joinHeadline(snapshot, brand).toLowerCase()}
							{pct !== null && <span className="co-muted"> {pct}%</span>}
						</div>
					</div>
					<p className="co-muted">{joinDetail(snapshot)}</p>
				</div>
			) : (
				<div className="co-split" data-tab={tab}>
					<section className="co-logpane" aria-label="Transcript">
						{lines.length === 0 ? (
							<p className="co-empty-line">{EMPTY_RUN}</p>
						) : (
							<ol className="co-log" ref={logRef}>
								{lines.map(line => (
									<LogRow
										key={line.id}
										line={line}
										selected={line.kind === "tool" && line.id === focusId}
										onSelect={select}
									/>
								))}
								{snapshot.working && !snapshot.stream && run.current === null && (
									<li className="co-l co-l--note">
										<span className="co-ts">--:--</span>
										<span className="co-tag">oz</span>
										<span className="co-blink">▍</span>
									</li>
								)}
							</ol>
						)}
						{away && (
							<button type="button" className="co-btn co-tail" onClick={jump}>
								↓ follow
							</button>
						)}
					</section>
					<Inspector run={run} focusId={focusId} onClose={() => setFocusId(null)} />
				</div>
			)}
			{toasts.length > 0 && (
				<div className="co-toasts" aria-live="polite">
					{toasts.map(n => (
						<div
							key={n.id}
							className={`co-toast co-toast--${n.level}`}
							role={n.level === "error" ? "alert" : "status"}
						>
							<span className="co-ts">{clock(n.at)}</span>
							<span className="co-toast-text">{n.message}</span>
							<button
								type="button"
								className="co-btn co-btn--icon"
								onClick={() => dismiss(n.id)}
								aria-label="Dismiss"
							>
								<X size={12} aria-hidden="true" />
							</button>
						</div>
					))}
				</div>
			)}
			{!joining && snapshot.phase !== "ended" && <CommandBar client={client} snapshot={snapshot} />}
		</div>
	);
}

export const consoleDirection: Direction = {
	id: "console",
	name: "Console",
	pitch: "Everything at once for engineers: a dense log on the left, the live command and its output on the right, a command bar on /.",
	tokens: { light, dark },
	App: ConsoleApp,
};

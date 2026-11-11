/**
 * `feed`: the run as a timeline of plain-language steps, for people who
 * follow it from Slack without reading code. "Read README.md", "Ran the
 * checks: 61 passed", "Changed README.md": each step is one line with a
 * dot on a rail; details (the command, the output, the diff) are one tap
 * away in a sheet. The model's prose is condensed to its first sentence,
 * except the answer that closes a request, which is shown whole. Progress
 * sits at the top. Steering is one big "Tell Oz something" button that
 * opens a sheet. Mobile first; on a desktop it is the same column, wider.
 */
import type { AssistantMessage } from "@oh-my-pi/pi-wire";
import type { AgentSnapshot } from "@oh-my-pi/pi-wire";
import {
	Check,
	ChevronDown,
	ChevronRight,
	Eye,
	Lightbulb,
	MessageCircle,
	RotateCw,
	Send,
	Square,
	TriangleAlert,
	Users,
	X,
} from "lucide-react";
import type { ReactNode } from "react";
import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { GuestClient, GuestSnapshot } from "../../lib/client";
import nunito400 from "../fonts/nunito-latin-400-normal.woff2";
import nunito600 from "../fonts/nunito-latin-600-normal.woff2";
import nunito800 from "../fonts/nunito-latin-800-normal.woff2";
import { BrandMark, useBrandName } from "../kit/brand";
import type { FontSource } from "../kit/font";
import { useDirectionFont } from "../kit/font";
import { useEscape, useFollowTail, useNow, useToasts } from "../kit/hooks";
import type { RunView, Turn } from "../kit/run";
import { groupTurns, useRun } from "../kit/run";
import { sessionTitle } from "../kit/session";
import { BLOCK_WORDS, optionDescription, optionLabel, sendPrompt, steerState, useEnterToSend } from "../kit/steer";
import { ThemeButton } from "../kit/theme-button";
import type { ToolCallView } from "../kit/tools";
import { diffStats, plainStep, toolCallView, toolDiff, toolPath, toolSubject } from "../kit/tools";
import { Prose, ToolDetail } from "../kit/views";
import {
	clock,
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
import "./feed.css";

const VOICE: readonly FontSource[] = [
	{ url: nunito400, weight: "400" },
	{ url: nunito600, weight: "600" },
	{ url: nunito800, weight: "800" },
];

type Step =
	| { kind: "say"; id: string; text: string; streaming: boolean; final: boolean }
	| { kind: "think"; id: string; text: string; streaming: boolean }
	| { kind: "do"; id: string; calls: ToolCallView[] }
	| { kind: "stop"; id: string; message: AssistantMessage };

/** A turn as steps: consecutive reads merge ("Read 3 files"), everything else stays one step. */
function stepsOf(turn: Turn, run: RunView, snapshot: GuestSnapshot): Step[] {
	const steps: Step[] = [];
	let lastText: Extract<Step, { kind: "say" }> | null = null;
	for (const item of turn.items) {
		if (item.kind !== "reply") continue;
		const m = item.message;
		m.content.forEach((block, i) => {
			if (block.type === "text" && block.text.trim()) {
				lastText = {
					kind: "say",
					id: `${item.id}:${i}`,
					text: block.text,
					streaming: item.streaming,
					final: false,
				};
				steps.push(lastText);
			} else if (block.type === "thinking" && block.thinking.trim()) {
				// Thinking is the least plain thing in a run: one quiet line, folded.
				const prev = steps[steps.length - 1];
				if (prev?.kind === "think") prev.text = `${prev.text}\n\n${block.thinking}`;
				else
					steps.push({
						kind: "think",
						id: `${item.id}:${i}`,
						text: block.thinking,
						streaming: item.streaming && i === m.content.length - 1,
					});
			} else if (block.type === "toolCall") {
				const call = toolCallView(
					block,
					run.results.get(block.id),
					snapshot.activeTools.get(block.id),
					item.streaming,
					m.timestamp,
				);
				const prev = steps[steps.length - 1];
				if (prev?.kind === "do" && call.kind === "read" && prev.calls.every(c => c.kind === "read"))
					prev.calls.push(call);
				else steps.push({ kind: "do", id: block.id, calls: [call] });
			}
		});
		if (!item.streaming && (m.stopReason === "error" || m.stopReason === "aborted"))
			steps.push({ kind: "stop", id: `${item.id}:stop`, message: m });
	}
	// The words that close a turn are its answer: shown whole, not condensed.
	const last = steps[steps.length - 1];
	if (last && last === lastText) (last as Extract<Step, { kind: "say" }>).final = true;
	return steps;
}

function stepTitle(calls: readonly ToolCallView[]): string {
	if (calls.length > 1) return `Read ${calls.length} files`;
	return plainStep(calls[0]!);
}

const SENTENCE = /^(.{20,220}?[.!?:])(\s|$)/s;

function firstSentence(text: string): { lead: string; more: boolean } {
	const flat = text
		.replace(/[`*_#>]/g, "")
		.replace(/\s+/g, " ")
		.trim();
	const match = SENTENCE.exec(flat);
	const lead = match ? match[1]! : flat.length > 200 ? `${flat.slice(0, 200).replace(/\s\S*$/, "")}…` : flat;
	return { lead, more: lead.length < flat.length - 2 };
}

/** A bottom sheet: modal, focus moves in, Esc and the scrim close it. */
function Sheet({
	title,
	onClose,
	children,
	label,
}: {
	title: ReactNode;
	onClose(): void;
	children: ReactNode;
	label: string;
}): ReactNode {
	const ref = useRef<HTMLDivElement | null>(null);
	useEscape(onClose);
	useEffect(() => {
		const prev = document.activeElement as HTMLElement | null;
		const first = ref.current?.querySelector<HTMLElement>("textarea, button:not([data-sheet-close]), [href], input");
		(first ?? ref.current)?.focus();
		return () => prev?.focus?.();
	}, []);
	return (
		<div className="fd-sheet-layer">
			<button type="button" className="fd-scrim" aria-label="Close" onClick={onClose} tabIndex={-1} />
			<div className="fd-sheet" role="dialog" aria-modal="true" aria-label={label} ref={ref} tabIndex={-1}>
				<div className="fd-grab" aria-hidden="true" />
				<header className="fd-sheet-head">
					<div className="fd-sheet-title">{title}</div>
					<button type="button" className="fd-round" onClick={onClose} aria-label="Close" data-sheet-close="">
						<X size={18} aria-hidden="true" />
					</button>
				</header>
				<div className="fd-sheet-body">{children}</div>
			</div>
		</div>
	);
}

const DoStep = memo(function DoStep({
	calls,
	onOpen,
}: {
	calls: ToolCallView[];
	onOpen(calls: ToolCallView[]): void;
}): ReactNode {
	const running = calls.some(c => c.status === "running");
	const failed = calls.some(c => c.status === "failed");
	const now = useNow(1000, running);
	const first = calls[0]!;
	const diff = calls.length === 1 && first.kind === "edit" ? toolDiff(first) : null;
	const stats = diff ? diffStats(diff) : null;
	const where = calls.length === 1 ? toolPath(first) : null;
	return (
		<li
			className={`fd-step fd-step--${running ? "running" : failed ? "failed" : "done"}`}
			data-shot={running ? "running" : undefined}
		>
			<span className="fd-node" aria-hidden="true">
				{running ? (
					<span className="fd-node-pulse" />
				) : failed ? (
					<TriangleAlert size={12} />
				) : (
					<Check size={12} strokeWidth={3} />
				)}
			</span>
			<button
				type="button"
				className="fd-step-btn"
				onClick={() => onOpen(calls)}
				data-shot={diff ? "open-diff" : undefined}
				aria-label={`${stepTitle(calls)}. Show details`}
			>
				<span className="fd-step-text">
					<span className="fd-step-title">{stepTitle(calls)}</span>
					<span className="fd-step-sub">
						{running
							? `${seconds(now - first.at)} so far`
							: failed
								? "This didn't work. Oz will see why."
								: stats
									? `${stats.added} lines added, ${stats.removed} removed`
									: where
										? splitPath(where).dir || "in the project root"
										: calls.length > 1
											? calls.map(c => splitPath(toolPath(c) ?? "").name).join(", ")
											: ""}
					</span>
				</span>
				<ChevronRight size={18} className="fd-step-chev" aria-hidden="true" />
			</button>
		</li>
	);
});

function SayStep({ step }: { step: Extract<Step, { kind: "say" }> }): ReactNode {
	const [open, setOpen] = useState(false);
	const brand = useBrandName();
	if (step.final || step.streaming) {
		return (
			<li className="fd-step fd-step--say fd-step--answer">
				<span className="fd-node fd-node--oz" aria-hidden="true">
					<BrandMark size={14} />
				</span>
				<div className="fd-answer">
					<div className="fd-answer-label">{step.streaming ? `${brand} is writing` : `${brand} says`}</div>
					<Prose text={step.text} streaming={step.streaming} />
				</div>
			</li>
		);
	}
	const { lead, more } = firstSentence(step.text);
	return (
		<li className="fd-step fd-step--say">
			<span className="fd-node fd-node--quiet" aria-hidden="true" />
			<div className="fd-say">
				{open ? <Prose text={step.text} /> : <p className="fd-say-lead">{lead}</p>}
				{more && (
					<button type="button" className="fd-link" onClick={() => setOpen(v => !v)} aria-expanded={open}>
						{open ? "Show less" : "Read all"}
					</button>
				)}
			</div>
		</li>
	);
}

function ThinkStep({ step }: { step: Extract<Step, { kind: "think" }> }): ReactNode {
	const [open, setOpen] = useState(false);
	const brand = useBrandName();
	const id = useId();
	return (
		<li className="fd-step fd-step--think">
			<span className="fd-node fd-node--quiet" aria-hidden="true" />
			<div className="fd-think">
				<button
					type="button"
					className="fd-link fd-think-btn"
					onClick={() => setOpen(v => !v)}
					aria-expanded={open}
					aria-controls={id}
				>
					<Lightbulb size={15} aria-hidden="true" />
					{step.streaming ? `${brand} is thinking` : `${brand} thought it through`}
					<ChevronDown size={15} className={open ? "fd-flip" : undefined} aria-hidden="true" />
				</button>
				{open && (
					<div className="fd-think-body" id={id}>
						<Prose text={step.text} streaming={step.streaming} />
					</div>
				)}
			</div>
		</li>
	);
}

const TurnSection = memo(function TurnSection({
	turn,
	run,
	snapshot,
	onOpen,
}: {
	turn: Turn;
	run: RunView;
	snapshot: GuestSnapshot;
	onOpen(calls: ToolCallView[]): void;
}): ReactNode {
	const steps = useMemo(() => stepsOf(turn, run, snapshot), [turn, run, snapshot]);
	const done = steps.filter(s => s.kind === "do").reduce((n, s) => n + (s.kind === "do" ? s.calls.length : 0), 0);
	return (
		<section className="fd-turn">
			{turn.prompt && (
				<div className="fd-ask-card">
					<div className="fd-ask-who">
						<span className="fd-avatar" aria-hidden="true">
							{turn.prompt.author[0]?.toUpperCase()}
						</span>
						<span>
							<strong>{turn.prompt.author}</strong> asked
						</span>
						{Number.isFinite(turn.prompt.at) && <span className="fd-ask-time">{clock(turn.prompt.at)}</span>}
					</div>
					<div className="fd-ask-text">
						<Prose text={turn.prompt.text} />
					</div>
					{done > 0 && <div className="fd-ask-count">{done} steps</div>}
				</div>
			)}
			<ol className="fd-steps">
				{steps.map(step => {
					if (step.kind === "say") return <SayStep key={step.id} step={step} />;
					if (step.kind === "think") return <ThinkStep key={step.id} step={step} />;
					if (step.kind === "stop") {
						return (
							<li key={step.id} className="fd-step fd-step--failed">
								<span className="fd-node" aria-hidden="true">
									<TriangleAlert size={12} />
								</span>
								<p className="fd-say-lead">
									{step.message.stopReason === "aborted"
										? "Stopped here, as someone asked."
										: "Something went wrong and the run stopped."}
								</p>
							</li>
						);
					}
					return <DoStep key={step.id} calls={step.calls} onOpen={onOpen} />;
				})}
			</ol>
		</section>
	);
});

function Progress({ snapshot, run }: { snapshot: GuestSnapshot; run: RunView }): ReactNode {
	const brand = useBrandName();
	const lastTurn = useMemo(() => {
		const turns = groupTurns(run.timeline);
		return turns[turns.length - 1] ?? null;
	}, [run.timeline]);
	const steps = useMemo(() => {
		if (!lastTurn) return 0;
		let n = 0;
		for (const item of lastTurn.items)
			if (item.kind === "reply") for (const b of item.message.content) if (b.type === "toolCall") n++;
		return n;
	}, [lastTurn]);
	let line: string;
	if (snapshot.phase === "ended") line = "This run is over";
	else if (snapshot.uiRequest) line = `${brand} is waiting for an answer`;
	else if (run.current) line = `Step ${steps} · ${plainStep(run.current)}`;
	else if (snapshot.working) line = `Step ${steps + 1} · Thinking about what to do next`;
	else if (steps > 0) line = `Done for now · ${steps} step${steps === 1 ? "" : "s"}`;
	else line = "Waiting for something to do";
	return (
		<div className="fd-progress" role="status" aria-live="polite">
			<span className={`fd-progress-dot${snapshot.working ? " fd-progress-dot--live" : ""}`} aria-hidden="true" />
			<span className="fd-progress-text">{line}</span>
		</div>
	);
}

function autosize(el: HTMLTextAreaElement | null, max: number): void {
	if (!el) return;
	el.style.height = "0px";
	el.style.height = `${Math.min(el.scrollHeight, max)}px`;
}

function TellSheet({
	client,
	snapshot,
	onClose,
}: {
	client: GuestClient;
	snapshot: GuestSnapshot;
	onClose(): void;
}): ReactNode {
	const brand = useBrandName();
	const steer = steerState(snapshot);
	const [text, setText] = useState("");
	const ref = useRef<HTMLTextAreaElement | null>(null);
	useLayoutEffect(() => autosize(ref.current, 260), [text]);
	const send = useCallback(() => {
		if (sendPrompt(client, snapshot, text)) {
			setText("");
			onClose();
		}
	}, [client, snapshot, text, onClose]);
	const keys = useEnterToSend(send);
	return (
		<Sheet title={`Tell ${brand} something`} label={`Tell ${brand} something`} onClose={onClose}>
			<div className="fd-tell" data-shot="composer">
				<p className="fd-tell-help">
					{steer.working
						? `${brand} reads it after the step it is on. Everyone here sees what you send.`
						: `${brand} starts on it straight away. Everyone here sees what you send.`}
				</p>
				<textarea
					ref={ref}
					className="fd-tell-input"
					rows={3}
					value={text}
					disabled={!steer.canSteer}
					aria-label={`Message to ${brand}`}
					placeholder={
						steer.canSteer ? "For example: also update the Development section" : BLOCK_WORDS["not-live"]
					}
					onChange={e => setText(e.target.value)}
					{...keys}
				/>
				<div className="fd-tell-actions">
					{steer.canInterrupt && (
						<button
							type="button"
							className="fd-btn fd-btn--stop"
							onClick={() => {
								client.sendAbort();
								onClose();
							}}
						>
							<Square size={14} fill="currentColor" aria-hidden="true" /> Stop {brand}
						</button>
					)}
					<button
						type="button"
						className="fd-btn fd-btn--primary"
						onClick={send}
						disabled={!steer.canSteer || !text.trim()}
					>
						<Send size={16} aria-hidden="true" /> Send
					</button>
				</div>
			</div>
		</Sheet>
	);
}

function QuestionCard({ client, snapshot }: { client: GuestClient; snapshot: GuestSnapshot }): ReactNode {
	const brand = useBrandName();
	const request = snapshot.uiRequest!;
	const [draft, setDraft] = useState(request.kind === "editor" ? (request.prefill ?? "") : "");
	const ref = useRef<HTMLTextAreaElement | null>(null);
	useLayoutEffect(() => autosize(ref.current, 200), [draft]);
	const answer = useCallback(() => client.sendUiResponse(request.reqId, draft), [client, request.reqId, draft]);
	const keys = useEnterToSend(answer);
	const titleId = useId();
	return (
		<section className="fd-q" aria-labelledby={titleId} data-shot="ask">
			<div className="fd-q-kicker">
				<MessageCircle size={16} aria-hidden="true" /> {brand} has a question for you
			</div>
			<h2 className="fd-q-title" id={titleId}>
				{request.title}
			</h2>
			{request.kind === "select" ? (
				<div className="fd-q-options">
					{request.options.map((option, index) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: options are positional
						<button
							key={index}
							type="button"
							className="fd-q-option"
							onClick={() => client.sendUiResponse(request.reqId, optionLabel(option))}
						>
							<span className="fd-q-label">{optionLabel(option)}</span>
							{optionDescription(option) && <span className="fd-q-desc">{optionDescription(option)}</span>}
						</button>
					))}
				</div>
			) : (
				<>
					<textarea
						ref={ref}
						className="fd-tell-input"
						rows={2}
						value={draft}
						aria-label="Your answer"
						onChange={e => setDraft(e.target.value)}
						{...keys}
					/>
					<button type="button" className="fd-btn fd-btn--primary fd-btn--block" onClick={answer}>
						Send answer
					</button>
				</>
			)}
			<button type="button" className="fd-link fd-q-skip" onClick={() => client.sendUiResponse(request.reqId)}>
				Let {brand} decide
			</button>
		</section>
	);
}

function DetailSheet({ calls, onClose }: { calls: ToolCallView[]; onClose(): void }): ReactNode {
	return (
		<Sheet title={stepTitle(calls)} label={`Details: ${stepTitle(calls)}`} onClose={onClose}>
			<div className="fd-detail">
				{calls.map(call => (
					<div key={call.id} className="fd-detail-item">
						{calls.length > 1 && <h3 className="fd-detail-h">{splitPath(toolPath(call) ?? call.name).name}</h3>}
						{call.intent && <p className="fd-detail-why">Why: {call.intent}</p>}
						{calls.length === 1 && toolSubject(call) && call.kind !== "shell" && (
							<p className="fd-detail-path" title={toolSubject(call)}>
								{toolSubject(call)}
							</p>
						)}
						<ToolDetail call={call} compact />
					</div>
				))}
			</div>
		</Sheet>
	);
}

const AGENT_WORDS: Record<AgentSnapshot["status"], string> = {
	running: "Working",
	idle: "Waiting",
	parked: "Finished",
	aborted: "Stopped",
};

function helpersOf(snapshot: GuestSnapshot): AgentSnapshot[] {
	return snapshot.agents.filter(agent => agent.kind === "sub");
}

/** The helper agents, one plain line each: what it is doing, how far it got. */
function HelpersSheet({ snapshot, onClose }: { snapshot: GuestSnapshot; onClose(): void }): ReactNode {
	const brand = useBrandName();
	const helpers = helpersOf(snapshot);
	return (
		<Sheet title="Helpers" label={`${brand}'s helpers`} onClose={onClose}>
			<p className="fd-tell-help">{brand} hands some jobs to helper agents. They report back here as they go.</p>
			<ul className="fd-helpers">
				{helpers.map(agent => {
					const payload = snapshot.progress.get(agent.id);
					const p = payload?.progress;
					const what = p?.lastIntent ?? p?.description ?? payload?.task ?? null;
					return (
						<li key={agent.id} className={`fd-helper fd-helper--${agent.status}`}>
							<span className="fd-helper-dot" aria-hidden="true" />
							<div className="fd-helper-text">
								<div className="fd-helper-name">
									{agent.displayName}
									<span className="fd-helper-status">{AGENT_WORDS[agent.status]}</span>
								</div>
								{what && <div className="fd-helper-what">{what}</div>}
								{p && (
									<div className="fd-helper-meta">
										{p.toolCount} steps · {seconds(p.durationMs)}
									</div>
								)}
							</div>
						</li>
					);
				})}
			</ul>
		</Sheet>
	);
}

function FeedApp({ client, snapshot, onRejoin }: DirectionProps): ReactNode {
	useDirectionFont("Oz Nunito", VOICE);
	const brand = useBrandName();
	const run = useRun(snapshot);
	const turns = useMemo(() => groupTurns(run.timeline), [run.timeline]);
	const [detail, setDetail] = useState<ToolCallView[] | null>(null);
	const [telling, setTelling] = useState(false);
	const [helpersOpen, setHelpersOpen] = useState(false);
	const helpers = helpersOf(snapshot);
	const helpersBusy = helpers.filter(a => a.status === "running").length;
	const scrollRef = useRef<HTMLDivElement | null>(null);
	const { away, jump } = useFollowTail(scrollRef, [
		snapshot.entries,
		snapshot.stream,
		snapshot.activeTools,
		snapshot.working,
	]);
	const { visible: toasts, dismiss } = useToasts(snapshot.notices, 2);
	const steer = steerState(snapshot);
	const joining = snapshot.phase === "connecting" || (snapshot.phase === "waiting" && snapshot.entries.length === 0);
	const pct = loadingPercent(snapshot);
	const guests = guestsLine(snapshot);
	const title = sessionTitle(snapshot);
	const reason = endedReason(snapshot);
	useEscape(
		() => client.sendAbort(),
		steer.canInterrupt && !telling && !helpersOpen && detail === null && snapshot.uiRequest === null,
	);

	return (
		<div className="fd-app">
			<header className="fd-head">
				<div className="fd-head-row">
					<BrandMark size={22} className="fd-mark" />
					<div className="fd-head-text">
						<h1 className="fd-title">{title}</h1>
						<div className="fd-meta">
							{snapshot.readOnly ? "You're watching" : "You can steer"}
							{guests ? ` · ${guests}` : ""}
						</div>
					</div>
					<ThemeButton className="fd-round" size={17} />
				</div>
				{!joining && (
					<div className="fd-progress-row">
						<Progress snapshot={snapshot} run={run} />
						{helpers.length > 0 && (
							<button
								type="button"
								className="fd-helpers-btn"
								onClick={() => setHelpersOpen(true)}
								aria-label={`${helpers.length} helper${helpers.length === 1 ? "" : "s"}, ${helpersBusy} working. Show them`}
							>
								<Users size={16} aria-hidden="true" />
								<span className="fd-helpers-count">{helpers.length}</span>
								{helpersBusy > 0 && <span className="fd-helpers-live" aria-hidden="true" />}
							</button>
						)}
					</div>
				)}
			</header>
			{toasts.length > 0 && (
				<div className="fd-toasts" aria-live="polite">
					{toasts.map(n => (
						<div
							key={n.id}
							className={`fd-toast fd-toast--${n.level}`}
							role={n.level === "error" ? "alert" : "status"}
						>
							<span>{n.message}</span>
							<button
								type="button"
								className="fd-round fd-round--sm"
								onClick={() => dismiss(n.id)}
								aria-label="Dismiss"
							>
								<X size={14} aria-hidden="true" />
							</button>
						</div>
					))}
				</div>
			)}
			<main className="fd-scroll" ref={scrollRef}>
				<div className="fd-col">
					{snapshot.phase === "reconnecting" && (
						<p className="fd-banner" role="status">
							{joinHeadline(snapshot, brand)}. {joinDetail(snapshot)}
						</p>
					)}
					{joining ? (
						<div className="fd-join" role="status" aria-live="polite">
							<BrandMark size={44} className="fd-join-mark" />
							<h2 className="fd-join-title">{joinHeadline(snapshot, brand)}</h2>
							<p className="fd-join-text">{joinDetail(snapshot)}</p>
							<div className="fd-join-bar" aria-hidden="true">
								<span
									className={pct === null ? "fd-join-indet" : undefined}
									style={pct === null ? undefined : { width: `${pct}%` }}
								/>
							</div>
						</div>
					) : turns.length === 0 ? (
						<p className="fd-empty">{EMPTY_RUN}</p>
					) : (
						turns.map(turn => (
							<TurnSection key={turn.id} turn={turn} run={run} snapshot={snapshot} onOpen={setDetail} />
						))
					)}
					{snapshot.phase === "ended" && (
						<section className="fd-ended" data-shot="ended">
							<h2 className="fd-ended-title">{ENDED_TITLE}</h2>
							<p>
								{reason ? `${reason} ` : ""}
								{ENDED_HELP}
							</p>
							<button type="button" className="fd-btn fd-btn--quiet" onClick={onRejoin}>
								<RotateCw size={15} aria-hidden="true" /> {ENDED_RETRY}
							</button>
						</section>
					)}
				</div>
			</main>
			{away && (
				<button type="button" className="fd-latest" onClick={jump}>
					See the latest
				</button>
			)}
			{!joining && snapshot.phase !== "ended" && (
				<footer className="fd-foot">
					<div className="fd-col fd-col--foot">
						{snapshot.uiRequest && steer.canSteer && (
							<QuestionCard key={snapshot.uiRequest.reqId} client={client} snapshot={snapshot} />
						)}
						{steer.block === "view-only" ? (
							<div className="fd-watch" data-shot="composer">
								<Eye size={20} aria-hidden="true" />
								<p>{BLOCK_WORDS["view-only"]}</p>
							</div>
						) : (
							<div className="fd-cta-row">
								<button
									type="button"
									className="fd-cta"
									onClick={() => setTelling(true)}
									disabled={!steer.canSteer}
									data-shot="open-composer"
								>
									<MessageCircle size={20} aria-hidden="true" />
									Tell {brand} something
								</button>
								{steer.canInterrupt && (
									<button
										type="button"
										className="fd-stop"
										onClick={() => client.sendAbort()}
										aria-label={`Stop ${brand} (Esc)`}
										title="Stop (Esc)"
									>
										<Square size={16} fill="currentColor" aria-hidden="true" />
									</button>
								)}
							</div>
						)}
						{!steer.canSteer && steer.block === "not-live" && (
							<p className="fd-foot-note">{BLOCK_WORDS["not-live"]}</p>
						)}
					</div>
				</footer>
			)}
			{telling && <TellSheet client={client} snapshot={snapshot} onClose={() => setTelling(false)} />}
			{detail && <DetailSheet calls={detail} onClose={() => setDetail(null)} />}
			{helpersOpen && <HelpersSheet snapshot={snapshot} onClose={() => setHelpersOpen(false)} />}
		</div>
	);
}

export const feed: Direction = {
	id: "feed",
	name: "Feed",
	pitch: 'For people who don\'t read code: the run as plain steps ("Changed README.md"), progress on top, one big "Tell Oz something" button.',
	tokens: { light, dark },
	App: FeedApp,
};

/**
 * `slack`: the run looks like the chat thread it was opened from, so the jump
 * from Slack feels like staying there. A narrow workspace sidebar (the run,
 * who is here, helper agents), the thread as compact messages with square
 * avatars, consecutive messages from one author collapsed under one name,
 * tool calls as attachment cards with buttons that expand their detail, a
 * question as a message with buttons, and a chat-style composer with a
 * "typing" line under it. The ended state is a private note from the system,
 * the way a chat app tells only you something.
 *
 * Mechanism, not expression: its own palette, the Oz mark, no chat-app logo
 * or asset.
 */
import type { AssistantMessage } from "@oh-my-pi/pi-wire";
import { ChevronDown, Eye, Hash, Lock, RotateCw, Send, Square, X } from "lucide-react";
import type { ReactNode } from "react";
import { memo, useCallback, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { GuestClient, GuestSnapshot } from "../../lib/client";
import { BrandMark, useBrandName } from "../kit/brand";
import { useEscape, useFollowTail, useNarrow, useNow, useToasts } from "../kit/hooks";
import type { RunView } from "../kit/run";
import { useRun } from "../kit/run";
import type { TimelineItem } from "../kit/session";
import { PHASE_WORDS, sessionTitle } from "../kit/session";
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
	initials,
	joinDetail,
	joinHeadline,
	loadingPercent,
	seconds,
	splitPath,
} from "../kit/words";
import type { Direction, DirectionProps } from "../types";
import { dark, light } from "./tokens";
import "./slack.css";

/** Square avatars in four tones, picked by name so a person keeps their colour. */
function tone(name: string): number {
	let h = 0;
	for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
	return (h % 4) + 1;
}

function Avatar({ name, size = 36 }: { name: string; size?: number }): ReactNode {
	return (
		<span className={`sl-av sl-av--${tone(name)}`} style={{ width: size, height: size }} aria-hidden="true">
			{initials(name)}
		</span>
	);
}

function OzAvatar({ size = 36 }: { size?: number }): ReactNode {
	return (
		<span className="sl-av sl-av--oz" style={{ width: size, height: size }} aria-hidden="true">
			<BrandMark size={Math.round(size * 0.58)} />
		</span>
	);
}

/** A message in the thread: one author, and everything they said until someone else spoke. */
type Message =
	| { kind: "person"; id: string; author: string; byGuest: boolean; at: number; texts: string[] }
	| { kind: "oz"; id: string; at: number; replies: Extract<TimelineItem, { kind: "reply" }>[] }
	| { kind: "note"; id: string; at: number; text: string };

function messagesOf(timeline: readonly TimelineItem[]): Message[] {
	const out: Message[] = [];
	for (const item of timeline) {
		const last = out[out.length - 1];
		if (item.kind === "reply") {
			if (last?.kind === "oz") last.replies.push(item);
			else out.push({ kind: "oz", id: item.id, at: item.at, replies: [item] });
		} else if (item.kind === "prompt") {
			if (last?.kind === "person" && last.author === item.author) last.texts.push(item.text);
			else
				out.push({
					kind: "person",
					id: item.id,
					author: item.author,
					byGuest: item.byGuest,
					at: item.at,
					texts: [item.text],
				});
		} else {
			out.push({ kind: "note", id: item.id, at: item.at, text: item.text });
		}
	}
	return out;
}

function Stamp({ at }: { at: number }): ReactNode {
	if (!Number.isFinite(at)) return null;
	return (
		<time className="sl-time" dateTime={new Date(at).toISOString()}>
			{clock(at)}
		</time>
	);
}

// ---- attachments (tool calls) ----

const KIND_NOUN: Record<ToolCallView["kind"], string> = {
	shell: "Command",
	read: "File",
	edit: "Change",
	write: "New file",
	search: "Search",
	browser: "Browser",
	web: "Web",
	agent: "Helper",
	ask: "Question",
	wait: "Wait",
	todo: "Plan",
	other: "Tool",
};

const Attachment = memo(function Attachment({ call }: { call: ToolCallView }): ReactNode {
	const [open, setOpen] = useState(false);
	const id = useId();
	const now = useNow(1000, call.status === "running");
	const path = toolPath(call);
	const diff = call.kind === "edit" ? toolDiff(call) : null;
	const stats = diff ? diffStats(diff) : null;
	const subject =
		call.kind === "read" || call.kind === "edit" || call.kind === "write" ? null : toolSubject(call).split("\n")[0];
	const fields: { label: string; value: string }[] = [];
	if (path) fields.push({ label: "File", value: splitPath(path).dir + splitPath(path).name });
	if (stats) fields.push({ label: "Lines", value: `+${stats.added}  −${stats.removed}` });
	if (call.status === "running") fields.push({ label: "Running for", value: seconds(now - call.at) });
	const status = call.status === "running" ? "Running" : call.status === "failed" ? "Failed" : "Done";
	return (
		<div className={`sl-att sl-att--${call.status}`} data-shot={call.status === "running" ? "running" : undefined}>
			<div className="sl-att-head">
				<span className="sl-att-kind">{KIND_NOUN[call.kind]}</span>
				<span className={`sl-att-status sl-att-status--${call.status}`}>
					<span className="sl-att-dot" aria-hidden="true" />
					{status}
				</span>
			</div>
			<div className="sl-att-title">{plainStep(call)}</div>
			{call.intent && <div className="sl-att-why">{call.intent}</div>}
			{subject && <code className="sl-att-code">{subject}</code>}
			{fields.length > 0 && (
				<dl className="sl-att-fields">
					{fields.map(field => (
						<div key={field.label} className="sl-att-field">
							<dt>{field.label}</dt>
							<dd>{field.value}</dd>
						</div>
					))}
				</dl>
			)}
			<div className="sl-att-actions">
				<button
					type="button"
					className="sl-bk-btn"
					aria-expanded={open}
					aria-controls={id}
					onClick={() => setOpen(v => !v)}
					data-shot={diff ? "open-diff" : undefined}
				>
					{open ? "Hide" : diff ? "View diff" : call.kind === "shell" ? "View output" : "View details"}
				</button>
			</div>
			{open && (
				<div className="sl-att-body" id={id}>
					<ToolDetail call={call} compact />
				</div>
			)}
		</div>
	);
});

/** A run of quick, finished calls folds into one line, like a chat app collapsing bot noise. */
function CallStack({ calls }: { calls: ToolCallView[] }): ReactNode {
	const [open, setOpen] = useState(false);
	const id = useId();
	const interesting = (c: ToolCallView): boolean =>
		c.status !== "done" || c.kind === "edit" || c.kind === "write" || c.kind === "agent";
	const quiet = calls.filter(c => !interesting(c));
	if (quiet.length < 3 || open)
		return (
			<div className="sl-atts">
				{calls.map(call => (
					<Attachment key={call.id} call={call} />
				))}
				{open && (
					<button type="button" className="sl-link-btn" onClick={() => setOpen(false)}>
						Show fewer
					</button>
				)}
			</div>
		);
	const loud = calls.filter(interesting);
	return (
		<div className="sl-atts">
			<button
				type="button"
				className="sl-fold"
				aria-expanded={false}
				aria-controls={id}
				onClick={() => setOpen(true)}
			>
				<ChevronDown size={14} aria-hidden="true" />
				{quiet.length} more steps: {[...new Set(quiet.map(c => plainStep(c)))].slice(0, 3).join(", ")}
			</button>
			<div id={id} className="sl-atts">
				{loud.map(call => (
					<Attachment key={call.id} call={call} />
				))}
			</div>
		</div>
	);
}

function Thought({ text, streaming }: { text: string; streaming: boolean }): ReactNode {
	const [open, setOpen] = useState(false);
	const id = useId();
	return (
		<div className="sl-thought">
			<button
				type="button"
				className="sl-link-btn"
				aria-expanded={open}
				aria-controls={id}
				onClick={() => setOpen(v => !v)}
			>
				{open ? "Hide thinking" : streaming ? "Thinking…" : "Show thinking"}
			</button>
			{open && (
				<div className="sl-quote" id={id}>
					<Prose text={text} streaming={streaming} />
				</div>
			)}
		</div>
	);
}

type Piece =
	| { kind: "text"; key: string; text: string; streaming: boolean }
	| { kind: "think"; key: string; text: string; streaming: boolean }
	| { kind: "calls"; key: string; calls: ToolCallView[] }
	| { kind: "stop"; key: string; message: AssistantMessage };

function piecesOf(
	replies: readonly Extract<TimelineItem, { kind: "reply" }>[],
	run: RunView,
	snapshot: GuestSnapshot,
): Piece[] {
	const pieces: Piece[] = [];
	for (const item of replies) {
		const m = item.message;
		m.content.forEach((block, i) => {
			const tail = item.streaming && i === m.content.length - 1;
			if (block.type === "text" && block.text.trim())
				pieces.push({ kind: "text", key: `${item.id}x${i}`, text: block.text, streaming: tail });
			else if (block.type === "thinking" && block.thinking.trim())
				pieces.push({ kind: "think", key: `${item.id}t${i}`, text: block.thinking, streaming: tail });
			else if (block.type === "toolCall") {
				const call = toolCallView(
					block,
					run.results.get(block.id),
					snapshot.activeTools.get(block.id),
					item.streaming,
					m.timestamp,
				);
				const last = pieces[pieces.length - 1];
				if (last?.kind === "calls") last.calls.push(call);
				else pieces.push({ kind: "calls", key: block.id, calls: [call] });
			}
		});
		if (!item.streaming && (m.stopReason === "aborted" || m.stopReason === "error"))
			pieces.push({ kind: "stop", key: `${item.id}stop`, message: m });
	}
	return pieces;
}

const OzMessage = memo(function OzMessage({
	message,
	run,
	snapshot,
}: {
	message: Extract<Message, { kind: "oz" }>;
	run: RunView;
	snapshot: GuestSnapshot;
}): ReactNode {
	const brand = useBrandName();
	const pieces = piecesOf(message.replies, run, snapshot);
	return (
		<article className="sl-msg">
			<OzAvatar />
			<div className="sl-msg-main">
				<header className="sl-msg-h">
					<span className="sl-name">{brand}</span>
					<span className="sl-badge">App</span>
					<Stamp at={message.at} />
				</header>
				{pieces.map(piece => {
					if (piece.kind === "text")
						return (
							<div key={piece.key} className="sl-text">
								<Prose text={piece.text} streaming={piece.streaming} />
							</div>
						);
					if (piece.kind === "think")
						return <Thought key={piece.key} text={piece.text} streaming={piece.streaming} />;
					if (piece.kind === "stop")
						return (
							<p key={piece.key} className="sl-stopped">
								{piece.message.stopReason === "aborted"
									? "Stopped here, as someone asked."
									: "Something went wrong and this step stopped."}
							</p>
						);
					return <CallStack key={piece.key} calls={piece.calls} />;
				})}
			</div>
		</article>
	);
});

function PersonMessage({ message }: { message: Extract<Message, { kind: "person" }> }): ReactNode {
	return (
		<article className="sl-msg">
			<Avatar name={message.author} />
			<div className="sl-msg-main">
				<header className="sl-msg-h">
					<span className="sl-name">{message.author}</span>
					{!message.byGuest && <span className="sl-role">started the run</span>}
					<Stamp at={message.at} />
				</header>
				{message.texts.map((text, i) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: one author's consecutive messages, in order
					<div key={i} className="sl-text">
						<Prose text={text} />
					</div>
				))}
			</div>
		</article>
	);
}

// ---- question, composer, typing ----

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
	useLayoutEffect(() => autosize(ref.current, 160), [draft]);
	const answer = useCallback(() => client.sendUiResponse(request.reqId, draft), [client, request.reqId, draft]);
	const keys = useEnterToSend(answer);
	const titleId = useId();
	return (
		<article className="sl-msg sl-msg--ask" aria-labelledby={titleId} data-shot="ask">
			<OzAvatar />
			<div className="sl-msg-main">
				<header className="sl-msg-h">
					<span className="sl-name">{brand}</span>
					<span className="sl-badge">App</span>
					<span className="sl-role">needs an answer to keep going</span>
				</header>
				<div className="sl-ask">
					<p className="sl-ask-title" id={titleId}>
						{request.title}
					</p>
					{request.kind === "select" ? (
						<div className="sl-ask-options">
							{request.options.map((option, index) => (
								// biome-ignore lint/suspicious/noArrayIndexKey: options are positional
								<div key={index} className="sl-ask-option">
									<button
										type="button"
										className={`sl-bk-btn${index === 0 ? " sl-bk-btn--primary" : ""}`}
										onClick={() => client.sendUiResponse(request.reqId, optionLabel(option))}
									>
										{optionLabel(option)}
									</button>
									{optionDescription(option) && (
										<span className="sl-ask-desc">{optionDescription(option)}</span>
									)}
								</div>
							))}
						</div>
					) : (
						<div className="sl-ask-text">
							<textarea
								ref={ref}
								className="sl-input sl-input--boxed"
								rows={2}
								value={draft}
								aria-label="Your answer"
								onChange={e => setDraft(e.target.value)}
								{...keys}
							/>
							<button type="button" className="sl-bk-btn sl-bk-btn--primary" onClick={answer}>
								Submit
							</button>
						</div>
					)}
					<button type="button" className="sl-link-btn" onClick={() => client.sendUiResponse(request.reqId)}>
						Let {brand} decide
					</button>
				</div>
			</div>
		</article>
	);
}

function typingLine(snapshot: GuestSnapshot, run: RunView, brand: string): string | null {
	if (snapshot.phase !== "live" || !snapshot.working) return null;
	if (run.current) return `${brand} is ${plainStep(run.current).replace(/^[A-Z]/, c => c.toLowerCase())}…`;
	const tail = snapshot.stream?.content[snapshot.stream.content.length - 1];
	if (tail?.type === "thinking") return `${brand} is thinking…`;
	return `${brand} is typing…`;
}

function Composer({
	client,
	snapshot,
	run,
}: {
	client: GuestClient;
	snapshot: GuestSnapshot;
	run: RunView;
}): ReactNode {
	const brand = useBrandName();
	const steer = steerState(snapshot);
	const [text, setText] = useState("");
	const ref = useRef<HTMLTextAreaElement | null>(null);
	useLayoutEffect(() => autosize(ref.current, 180), [text]);
	const send = useCallback(() => {
		if (sendPrompt(client, snapshot, text)) setText("");
	}, [client, snapshot, text]);
	const keys = useEnterToSend(send);
	const typing = typingLine(snapshot, run, brand);
	if (steer.block === "view-only") {
		return (
			<div className="sl-dock">
				<div className="sl-readonly" data-shot="composer">
					<Lock size={16} aria-hidden="true" />
					<div>
						<strong>You can read this thread but not reply.</strong>
						<p>{BLOCK_WORDS["view-only"].replace("You're watching. ", "")}</p>
					</div>
				</div>
				<div className="sl-typing" aria-live="polite">
					{typing ?? ""}
				</div>
			</div>
		);
	}
	return (
		<div className="sl-dock">
			<div className="sl-composer" data-shot="composer">
				<textarea
					ref={ref}
					className="sl-input"
					rows={1}
					value={text}
					disabled={!steer.canSteer}
					aria-label={`Reply to ${brand}`}
					placeholder={steer.canSteer ? `Reply to ${brand}…` : BLOCK_WORDS["not-live"]}
					onChange={e => setText(e.target.value)}
					{...keys}
				/>
				<div className="sl-composer-row">
					<span className="sl-composer-hint">
						{steer.working && steer.canSteer
							? steer.queued > 0
								? `${steer.queued} waiting for ${brand}`
								: `${brand} reads it after this step`
							: ""}
					</span>
					{steer.canInterrupt && (
						<button
							type="button"
							className="sl-stop"
							onClick={() => client.sendAbort()}
							title="Stop (Esc)"
							aria-label={`Stop ${brand} (Esc)`}
						>
							<Square size={11} fill="currentColor" aria-hidden="true" />
							<span>Stop</span>
						</button>
					)}
					<button
						type="button"
						className="sl-send"
						onClick={send}
						disabled={!steer.canSteer || !text.trim()}
						aria-label="Send"
					>
						<Send size={15} aria-hidden="true" />
					</button>
				</div>
			</div>
			<div className="sl-typing" aria-live="polite">
				{typing ?? ""}
			</div>
		</div>
	);
}

// ---- the sidebar ----

function Sidebar({ snapshot, title }: { snapshot: GuestSnapshot; title: string }): ReactNode {
	const brand = useBrandName();
	const people = snapshot.state?.participants ?? [];
	const helpers = snapshot.agents.filter(a => a.kind === "sub");
	return (
		<nav className="sl-side" aria-label="Workspace">
			<div className="sl-side-ws">
				<BrandMark size={18} />
				<span>{brand} live</span>
			</div>
			<div className="sl-side-sec">
				<h2 className="sl-side-h">Threads</h2>
				<div className="sl-side-item" aria-current="true">
					<Hash size={15} aria-hidden="true" />
					<span className="sl-side-label">{title}</span>
				</div>
			</div>
			<div className="sl-side-sec">
				<h2 className="sl-side-h">Here now</h2>
				<ul className="sl-side-list">
					{people.map((person, i) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: names can repeat
						<li key={i} className="sl-side-item">
							<span className="sl-presence" aria-hidden="true" />
							<span className="sl-side-label">{person.name}</span>
							<span className="sl-side-meta">
								{person.role === "host" ? "started it" : person.readOnly ? "watching" : "can steer"}
							</span>
						</li>
					))}
				</ul>
			</div>
			{helpers.length > 0 && (
				<div className="sl-side-sec">
					<h2 className="sl-side-h">Helpers</h2>
					<ul className="sl-side-list">
						{helpers.map(agent => {
							const p = snapshot.progress.get(agent.id)?.progress;
							return (
								<li key={agent.id} className={`sl-side-item sl-side-item--${agent.status}`}>
									<span className="sl-presence" aria-hidden="true" />
									<span className="sl-side-label">{agent.displayName}</span>
									<span className="sl-side-meta">
										{agent.status === "running"
											? p
												? `${p.toolCount} steps`
												: "working"
											: agent.status === "parked"
												? "done"
												: agent.status}
									</span>
								</li>
							);
						})}
					</ul>
				</div>
			)}
		</nav>
	);
}

/** The helpers, for phone widths: one line under the header, expanding to the list. */
function HelpersLine({ snapshot }: { snapshot: GuestSnapshot }): ReactNode {
	const [open, setOpen] = useState(false);
	const id = useId();
	const helpers = snapshot.agents.filter(a => a.kind === "sub");
	if (helpers.length === 0) return null;
	const busy = helpers.filter(a => a.status === "running").length;
	return (
		<div className="sl-helpers-line">
			<button
				type="button"
				className="sl-link-btn"
				aria-expanded={open}
				aria-controls={id}
				onClick={() => setOpen(v => !v)}
			>
				{helpers.length} helper{helpers.length === 1 ? "" : "s"}
				{busy > 0 ? `, ${busy} working` : ""}
				<ChevronDown size={14} className={open ? "sl-flip" : undefined} aria-hidden="true" />
			</button>
			{open && (
				<ul id={id} className="sl-helpers-list">
					{helpers.map(agent => {
						const p = snapshot.progress.get(agent.id)?.progress;
						return (
							<li key={agent.id}>
								<strong>{agent.displayName}</strong>{" "}
								{agent.status === "running"
									? (p?.lastIntent ?? "working")
									: agent.status === "parked"
										? "done"
										: agent.status}
							</li>
						);
					})}
				</ul>
			)}
		</div>
	);
}

// ---- the page ----

function SlackApp({ client, snapshot, onRejoin }: DirectionProps): ReactNode {
	const brand = useBrandName();
	const run = useRun(snapshot);
	const messages = useMemo(() => messagesOf(run.timeline), [run.timeline]);
	const steer = steerState(snapshot);
	const wide = !useNarrow(899);
	const scrollRef = useRef<HTMLDivElement | null>(null);
	const { away, jump } = useFollowTail(scrollRef, [
		snapshot.entries,
		snapshot.stream,
		snapshot.activeTools,
		snapshot.uiRequest,
	]);
	const { visible: toasts, dismiss } = useToasts(snapshot.notices, 2);
	const joining = snapshot.phase === "connecting" || (snapshot.phase === "waiting" && snapshot.entries.length === 0);
	const title = sessionTitle(snapshot);
	const reason = endedReason(snapshot);
	const pct = loadingPercent(snapshot);
	const replies = Math.max(0, messages.length - 1);
	const people = snapshot.state?.participants.length ?? 0;
	useEscape(() => client.sendAbort(), steer.canInterrupt && snapshot.uiRequest === null);

	const [first, ...rest] = messages;

	return (
		<div className={`sl-app${wide ? " sl-app--wide" : ""}`}>
			{wide && <Sidebar snapshot={snapshot} title={title} />}
			<main className="sl-main">
				<header className="sl-head">
					<div className="sl-head-text">
						<h1 className="sl-head-title">Thread</h1>
						<div className="sl-head-sub">
							<Hash size={13} aria-hidden="true" />
							<span className="sl-head-run">{title}</span>
						</div>
					</div>
					<span className={`sl-live sl-live--${snapshot.phase}`}>
						<span className="sl-live-dot" aria-hidden="true" />
						{PHASE_WORDS[snapshot.phase]}
					</span>
					{!wide && people > 0 && (
						<span className="sl-head-people" title={`${people} here`}>
							{people} here
						</span>
					)}
					<span className={`sl-access${snapshot.readOnly ? " sl-access--view" : ""}`}>
						{snapshot.readOnly ? <Eye size={13} aria-hidden="true" /> : null}
						{snapshot.readOnly ? "Watching" : "Can steer"}
					</span>
					<ThemeButton className="sl-icon-btn" size={16} />
				</header>
				{!wide && <HelpersLine snapshot={snapshot} />}
				{(toasts.length > 0 || snapshot.phase === "reconnecting") && (
					<div className="sl-banners" aria-live="polite">
						{snapshot.phase === "reconnecting" && (
							<div className="sl-banner sl-banner--warn" role="status">
								{joinHeadline(snapshot, brand)}. {joinDetail(snapshot)}
							</div>
						)}
						{toasts.map(n => (
							<div
								key={n.id}
								className={`sl-banner sl-banner--${n.level}`}
								role={n.level === "error" ? "alert" : "status"}
							>
								<span>{n.message}</span>
								<button
									type="button"
									className="sl-icon-btn sl-icon-btn--sm"
									onClick={() => dismiss(n.id)}
									aria-label="Dismiss"
								>
									<X size={13} aria-hidden="true" />
								</button>
							</div>
						))}
					</div>
				)}
				<div className="sl-scroll" ref={scrollRef}>
					{joining ? (
						<div className="sl-join" role="status" aria-live="polite">
							<div className="sl-join-text">
								<strong>{joinHeadline(snapshot, brand)}</strong>
								<span>{joinDetail(snapshot)}</span>
								{pct !== null && (
									<span className="sl-join-bar" aria-hidden="true">
										<span style={{ width: `${pct}%` }} />
									</span>
								)}
							</div>
							{[0, 1, 2].map(i => (
								<div key={i} className="sl-skel" aria-hidden="true">
									<span className="sl-skel-av" />
									<span className="sl-skel-lines">
										<span style={{ width: "28%" }} />
										<span style={{ width: `${86 - i * 14}%` }} />
										<span style={{ width: `${62 + i * 9}%` }} />
									</span>
								</div>
							))}
						</div>
					) : messages.length === 0 ? (
						<p className="sl-empty">{EMPTY_RUN}</p>
					) : (
						<>
							{first && <MessageView message={first} run={run} snapshot={snapshot} />}
							{rest.length > 0 && (
								<div className="sl-divider">
									<span>
										{replies} {replies === 1 ? "reply" : "replies"}
									</span>
								</div>
							)}
							{rest.map(message => (
								<MessageView key={message.id} message={message} run={run} snapshot={snapshot} />
							))}
							{snapshot.uiRequest && steer.canSteer && (
								<Question key={snapshot.uiRequest.reqId} client={client} snapshot={snapshot} />
							)}
						</>
					)}
					{snapshot.phase === "ended" && (
						<article className="sl-msg sl-msg--private" data-shot="ended" role="status">
							<OzAvatar />
							<div className="sl-msg-main">
								<header className="sl-msg-h">
									<span className="sl-name">{brand}</span>
									<span className="sl-badge">App</span>
									<span className="sl-role">
										<Eye size={12} aria-hidden="true" /> Only visible to you
									</span>
								</header>
								<p className="sl-ended-title">{ENDED_TITLE}</p>
								<p className="sl-ended-text">
									{reason ? `${reason} ` : ""}
									{ENDED_HELP}
								</p>
								<div className="sl-att-actions">
									<button type="button" className="sl-bk-btn" onClick={onRejoin}>
										<RotateCw size={13} aria-hidden="true" /> {ENDED_RETRY}
									</button>
								</div>
							</div>
						</article>
					)}
				</div>
				{away && (
					<button type="button" className="sl-latest" onClick={jump}>
						Jump to latest
					</button>
				)}
				{!joining && snapshot.phase !== "ended" && <Composer client={client} snapshot={snapshot} run={run} />}
			</main>
		</div>
	);
}

function MessageView({
	message,
	run,
	snapshot,
}: {
	message: Message;
	run: RunView;
	snapshot: GuestSnapshot;
}): ReactNode {
	if (message.kind === "oz") return <OzMessage message={message} run={run} snapshot={snapshot} />;
	if (message.kind === "person") return <PersonMessage message={message} />;
	return <p className="sl-note">{message.text}</p>;
}

export const slack: Direction = {
	id: "slack",
	name: "Thread",
	pitch: "Looks like the chat thread you came from: avatars, compact messages, tool calls as cards with buttons, a chat composer. Nothing new to learn.",
	tokens: { light, dark },
	App: SlackApp,
};

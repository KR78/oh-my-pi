/**
 * Chamber's right-hand Session panel, after OpenChamber's context panel
 * (context %, cost, project, changed files with +/- counts, turn stats,
 * subagents with status icons). Only what the snapshot carries is shown:
 * the wire has no branch, no per-message timing and no cache-hit split, so
 * those OpenChamber rows are left out rather than estimated.
 *
 * Copyright (c) 2025 Bohdan Triapitsyn. MIT License; see
 * LICENSE-openchamber.txt in this folder.
 */
import type { AgentSnapshot, AssistantMessage, SessionEntry, SubagentProgressPayload } from "@oh-my-pi/pi-wire";
import {
	ArrowLeft,
	ChevronDown,
	ChevronRight,
	CircleCheck,
	CircleDashed,
	CircleX,
	Eye,
	FileDiff,
	FolderOpen,
	Gauge,
	LoaderCircle,
	Users,
	X,
} from "lucide-react";
import type { ReactNode } from "react";
import { memo, useMemo, useState } from "react";
import type { GuestClient, GuestSnapshot } from "../../lib/client";
import { fmtCost, fmtTokens } from "../../lib/format";
import { useNow } from "../kit/hooks";
import { groupTurns } from "../kit/run";
import type { TouchedFile } from "../kit/session";
import { buildTimeline, contextPercent, runUsage } from "../kit/session";
import { resultsById } from "../kit/tools";
import { useAgentTranscript } from "../kit/use-agent-transcript";
import { seconds, splitPath } from "../kit/words";
import { TurnView } from "./Messages";

function Section({
	icon,
	title,
	count,
	children,
	defaultOpen = true,
}: {
	icon: ReactNode;
	title: string;
	count?: ReactNode;
	children: ReactNode;
	defaultOpen?: boolean;
}): ReactNode {
	const [open, setOpen] = useState(defaultOpen);
	return (
		<section className="chp-section">
			<button type="button" className="chp-section-head" aria-expanded={open} onClick={() => setOpen(v => !v)}>
				{icon}
				<span className="chp-section-title">{title}</span>
				{open ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
				{count !== undefined && <span className="chp-count">{count}</span>}
			</button>
			{open && <div className="chp-section-body">{children}</div>}
		</section>
	);
}

function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: "ok" }): ReactNode {
	return (
		<div className="chp-stat">
			<span className="chp-stat-label">{label}</span>
			<span className={tone === "ok" ? "chp-stat-value chp-ok" : "chp-stat-value"}>{value}</span>
		</div>
	);
}

/** The latest turn's numbers, from the replies it has committed so far. */
function lastTurnStats(entries: readonly SessionEntry[]): {
	replies: number;
	tools: number;
	input: number;
	output: number;
	startedAt: number | null;
	elapsed: number | null;
} | null {
	let start = -1;
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i]!;
		if (
			(entry.type === "message" && entry.message.role === "user") ||
			(entry.type === "custom_message" && entry.customType === "collab-prompt")
		) {
			start = i;
			break;
		}
	}
	if (start < 0) return null;
	const startedAt = Date.parse(entries[start]!.timestamp);
	let replies = 0;
	let tools = 0;
	let input = 0;
	let output = 0;
	let last: AssistantMessage | null = null;
	for (let i = start + 1; i < entries.length; i++) {
		const entry = entries[i]!;
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const message = entry.message;
		replies++;
		last = message;
		for (const block of message.content) if (block.type === "toolCall") tools++;
		input += message.usage.input + message.usage.cacheRead;
		output += message.usage.output;
	}
	if (replies === 0) return null;
	const elapsed = last && Number.isFinite(startedAt) ? last.timestamp - startedAt : null;
	return {
		replies,
		tools,
		input,
		output,
		startedAt: Number.isFinite(startedAt) ? startedAt : null,
		elapsed: elapsed !== null && elapsed > 0 ? elapsed : null,
	};
}

function AgentStatusIcon({ status }: { status: AgentSnapshot["status"] }): ReactNode {
	switch (status) {
		case "running":
			return <LoaderCircle size={14} className="chp-spin chp-info" aria-label="running" />;
		case "aborted":
			return <CircleX size={14} className="chp-err" aria-label="stopped" />;
		case "parked":
			return <CircleCheck size={14} className="chp-ok" aria-label="finished" />;
		default:
			return <CircleDashed size={14} className="chp-muted" aria-label="idle" />;
	}
}

function AgentList({ snapshot, onOpen }: { snapshot: GuestSnapshot; onOpen(id: string): void }): ReactNode {
	const subs = snapshot.agents.filter(agent => agent.kind === "sub");
	if (subs.length === 0) return <p className="chp-empty">No helper agents in this run.</p>;
	return (
		<ul className="chp-list">
			{subs.map(agent => {
				const progress = snapshot.progress.get(agent.id)?.progress;
				const line =
					progress?.description ?? progress?.task ?? snapshot.progress.get(agent.id)?.task ?? agent.displayName;
				return (
					<li key={agent.id}>
						<button type="button" className="chp-agent" onClick={() => onOpen(agent.id)}>
							<AgentStatusIcon status={agent.status} />
							<span className="chp-agent-text">
								<span className="chp-agent-name">{agent.displayName}</span>
								<span className="chp-agent-line">{line}</span>
							</span>
							{progress && <span className="chp-agent-meta">{progress.toolCount} tools</span>}
						</button>
					</li>
				);
			})}
		</ul>
	);
}

function FileList({ files }: { files: readonly TouchedFile[] }): ReactNode {
	const changed = files.filter(file => file.change !== "read");
	if (changed.length === 0) return <p className="chp-empty">No files changed yet.</p>;
	return (
		<ul className="chp-list">
			{changed.map(file => {
				const { dir, name } = splitPath(file.path);
				return (
					<li key={file.path} className="chp-file" title={file.path}>
						<span className="chp-file-path">
							<span className="chp-file-dir">{dir}</span>
							<span className="chp-file-name">{name}</span>
						</span>
						{file.stats && (
							<span className="chp-file-stats">
								<span className="chp-ok">+{file.stats.added}</span>
								<span className="chp-muted">/</span>
								<span className="chp-err">−{file.stats.removed}</span>
							</span>
						)}
					</li>
				);
			})}
		</ul>
	);
}

const AgentView = memo(function AgentView({
	client,
	agent,
	progress,
	onBack,
}: {
	client: GuestClient;
	agent: AgentSnapshot;
	progress: SubagentProgressPayload | undefined;
	onBack(): void;
}): ReactNode {
	const { entries, error } = useAgentTranscript(client, agent, progress, undefined);
	const turns = useMemo(() => groupTurns(buildTimeline(entries, null, false, "Oz")), [entries]);
	const results = useMemo(() => resultsById(entries), [entries]);
	const p = progress?.progress;
	return (
		<div className="chp-agent-view">
			<button type="button" className="chp-back" onClick={onBack}>
				<ArrowLeft size={14} aria-hidden="true" /> Session
			</button>
			<div className="chp-agent-head">
				<AgentStatusIcon status={agent.status} />
				<span className="chp-agent-name">{agent.displayName}</span>
			</div>
			{p && (
				<div className="chp-stats">
					{p.currentTool && <Stat label="Now" value={p.currentTool} />}
					<Stat label="Tools" value={p.toolCount} />
					<Stat label="Tokens" value={fmtTokens(p.tokens)} />
					<Stat label="Cost" value={fmtCost(p.cost)} />
					<Stat label="Elapsed" value={seconds(p.durationMs)} />
				</div>
			)}
			<div className="chp-agent-transcript">
				{!agent.hasSessionFile && <p className="chp-empty">This agent has no transcript to show.</p>}
				{error && <p className="chp-empty">Transcript unavailable: {error}</p>}
				{agent.hasSessionFile && !error && entries.length === 0 && (
					<p className="chp-empty">Loading its transcript…</p>
				)}
				{turns.map(turn => (
					<TurnView key={turn.id} turn={turn} results={results} active={EMPTY_ACTIVE} diffHookId={null} />
				))}
			</div>
		</div>
	);
});

const EMPTY_ACTIVE = new Map();

export const SessionPanel = memo(function SessionPanel({
	client,
	snapshot,
	files,
	onClose,
}: {
	client: GuestClient;
	snapshot: GuestSnapshot;
	files: readonly TouchedFile[];
	onClose(): void;
}): ReactNode {
	const [agentId, setAgentId] = useState<string | null>(null);
	const agent = agentId ? snapshot.agents.find(a => a.id === agentId) : undefined;
	const pct = contextPercent(snapshot.state);
	const usage = useMemo(() => runUsage(snapshot.entries), [snapshot.entries]);
	const turn = useMemo(() => lastTurnStats(snapshot.entries), [snapshot.entries]);
	const now = useNow(1000, snapshot.working);
	const changed = files.filter(f => f.change !== "read");
	const totals = changed.reduce(
		(acc, f) => ({ added: acc.added + (f.stats?.added ?? 0), removed: acc.removed + (f.stats?.removed ?? 0) }),
		{ added: 0, removed: 0 },
	);
	const cwd = snapshot.state?.cwd ?? snapshot.header?.cwd ?? null;
	const people = snapshot.state?.participants ?? [];
	const subs = snapshot.agents.filter(a => a.kind === "sub").length;

	return (
		<aside className="chp" aria-label="Session details">
			<div className="chp-head">
				<span className="chp-title">Session</span>
				<button type="button" className="ch-icon-btn" onClick={onClose} aria-label="Close session details">
					<X size={15} aria-hidden="true" />
				</button>
			</div>
			{agent ? (
				<AgentView
					client={client}
					agent={agent}
					progress={snapshot.progress.get(agent.id)}
					onBack={() => setAgentId(null)}
				/>
			) : (
				<div className="chp-scroll">
					{(pct !== null || usage.replies > 0) && (
						<div className="chp-context">
							<div className="chp-context-row">
								<Gauge size={14} aria-hidden="true" />
								<span>Context</span>
								<span className="chp-context-num">
									{pct !== null && <span>{pct.toFixed(1)}%</span>}
									{usage.cost > 0 && <span>{fmtCost(usage.cost)}</span>}
								</span>
							</div>
							{pct !== null && (
								<div
									className="chp-bar"
									role="progressbar"
									aria-label="Context used"
									aria-valuenow={Math.round(pct)}
									aria-valuemin={0}
									aria-valuemax={100}
								>
									<span style={{ width: `${Math.min(100, pct)}%` }} />
								</div>
							)}
						</div>
					)}
					<Section
						icon={<FolderOpen size={14} aria-hidden="true" />}
						title="Project"
						count={changed.length > 0 ? `${changed.length} changed` : undefined}
					>
						{cwd && (
							<div className="chp-cwd" title={cwd}>
								{cwd}
							</div>
						)}
						{changed.length > 0 && (
							<div className="chp-diffline">
								<FileDiff size={14} aria-hidden="true" />
								<span>
									{changed.length} file{changed.length === 1 ? "" : "s"} changed
								</span>
								<span className="chp-file-stats">
									<span className="chp-ok">+{totals.added}</span>
									<span className="chp-muted">/</span>
									<span className="chp-err">−{totals.removed}</span>
								</span>
							</div>
						)}
						<FileList files={files} />
					</Section>
					{turn && (
						<Section icon={<Gauge size={14} aria-hidden="true" />} title="Turn stats">
							<div className="chp-stats">
								{snapshot.working && turn.startedAt !== null ? (
									<Stat label="Elapsed" value={seconds(now - turn.startedAt)} />
								) : (
									turn.elapsed !== null && <Stat label="Elapsed" value={seconds(turn.elapsed)} />
								)}
								<Stat label="Steps" value={turn.replies} />
								<Stat label="Tool calls" value={turn.tools} />
								<Stat label="Tokens" value={`${fmtTokens(turn.input)} ↑ · ${fmtTokens(turn.output)} ↓`} />
								{snapshot.state?.model && <Stat label="Model" value={snapshot.state.model.name} />}
							</div>
						</Section>
					)}
					<Section icon={<Users size={14} aria-hidden="true" />} title="People" count={people.length}>
						<ul className="chp-list">
							{people.map((person, i) => (
								// biome-ignore lint/suspicious/noArrayIndexKey: names can repeat across guests
								<li key={`${person.name}-${i}`} className="chp-person">
									<span className="chp-avatar" aria-hidden="true">
										{(person.name[0] ?? "?").toUpperCase()}
									</span>
									<span className="chp-person-name">{person.name}</span>
									<span className="chp-person-role">
										{person.role === "host" ? (
											"started the run"
										) : person.readOnly ? (
											<>
												<Eye size={12} aria-hidden="true" /> watching
											</>
										) : (
											"can steer"
										)}
									</span>
								</li>
							))}
						</ul>
					</Section>
					<Section icon={<LoaderCircle size={14} aria-hidden="true" />} title="Subagents" count={subs}>
						<AgentList snapshot={snapshot} onOpen={setAgentId} />
					</Section>
				</div>
			)}
		</aside>
	);
});

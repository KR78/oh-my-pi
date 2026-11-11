/**
 * `chamber`: OpenChamber's chat, adapted to a guest watching one Oz run. A
 * centred 48rem column of turns, tool rows that fold, a floating composer,
 * and OpenChamber's right-hand Session panel. The left sessions sidebar is
 * left out: a guest sees one session.
 *
 * Layout, tool rows, composer and palette are adapted from OpenChamber
 * (https://github.com/openchamber/openchamber).
 * Copyright (c) 2025 Bohdan Triapitsyn. MIT License; see
 * LICENSE-openchamber.txt in this folder.
 */
import { ArrowDown, CircleAlert, Info, PanelRight, RotateCw, TriangleAlert, WifiOff, X } from "lucide-react";
import type { ReactNode } from "react";
import { useMemo, useRef, useState } from "react";
import { BrandMark, useBrandName } from "../kit/brand";
import { useFollowTail, useNarrow, useToasts } from "../kit/hooks";
import { groupTurns, useRun } from "../kit/run";
import { contextPercent, sessionTitle } from "../kit/session";
import { ThemeButton } from "../kit/theme-button";
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
} from "../kit/words";
import type { Direction, DirectionProps } from "../types";
import { Composer } from "./Composer";
import { lastDiffCallId, TurnView } from "./Messages";
import { SessionPanel } from "./SessionPanel";
import { dark, light } from "./tokens";
import "./chamber.css";

function JoinState({ snapshot }: DirectionProps): ReactNode {
	const brand = useBrandName();
	const pct = loadingPercent(snapshot);
	return (
		<div className="ch-join" role="status" aria-live="polite">
			<BrandMark size={28} className="ch-join-mark" />
			<div className="ch-join-title">{joinHeadline(snapshot, brand)}</div>
			<div className="ch-join-detail">{joinDetail(snapshot)}</div>
			<div className="ch-join-bar" aria-hidden="true">
				<span
					className={pct === null ? "ch-join-bar-indet" : undefined}
					style={pct === null ? undefined : { width: `${pct}%` }}
				/>
			</div>
		</div>
	);
}

function EndedCard({ snapshot, onRejoin }: DirectionProps): ReactNode {
	const reason = endedReason(snapshot);
	return (
		<div
			className="ch-ended"
			role="alertdialog"
			aria-modal="false"
			aria-labelledby="ch-ended-title"
			data-shot="ended"
		>
			<div className="ch-ended-title" id="ch-ended-title">
				{ENDED_TITLE}
			</div>
			{reason && <div className="ch-ended-reason">{reason}</div>}
			<div className="ch-ended-help">{ENDED_HELP}</div>
			<button type="button" className="ch-btn ch-btn--ghost" onClick={onRejoin}>
				<RotateCw size={13} aria-hidden="true" /> {ENDED_RETRY}
			</button>
		</div>
	);
}

function Toasts({ snapshot }: DirectionProps): ReactNode {
	const { visible, dismiss } = useToasts(snapshot.notices);
	if (visible.length === 0) return null;
	return (
		<div className="ch-toasts" aria-live="polite">
			{visible.map(notice => (
				<div
					key={notice.id}
					className={`ch-toast ch-toast--${notice.level}`}
					role={notice.level === "error" ? "alert" : "status"}
				>
					{notice.level === "error" ? (
						<CircleAlert size={14} aria-hidden="true" />
					) : notice.level === "warning" ? (
						<TriangleAlert size={14} aria-hidden="true" />
					) : (
						<Info size={14} aria-hidden="true" />
					)}
					<span className="ch-toast-text">{notice.message}</span>
					<button type="button" className="ch-toast-x" onClick={() => dismiss(notice.id)} aria-label="Dismiss">
						<X size={13} aria-hidden="true" />
					</button>
				</div>
			))}
		</div>
	);
}

function ChamberApp(props: DirectionProps): ReactNode {
	const { client, snapshot } = props;
	const narrow = useNarrow(1100);
	const [panelPref, setPanelPref] = useState<boolean | null>(null);
	const panelOpen = panelPref ?? !narrow;
	const run = useRun(snapshot);
	const turns = useMemo(() => groupTurns(run.timeline), [run.timeline]);
	const diffHookId = useMemo(() => lastDiffCallId(turns, run.results), [turns, run.results]);
	const scrollRef = useRef<HTMLDivElement | null>(null);
	const { away, jump } = useFollowTail(scrollRef, [
		snapshot.entries,
		snapshot.stream,
		snapshot.activeTools,
		snapshot.working,
	]);
	const title = sessionTitle(snapshot);
	const pct = contextPercent(snapshot.state);
	const guests = guestsLine(snapshot);
	const joining = snapshot.phase === "connecting" || (snapshot.phase === "waiting" && snapshot.entries.length === 0);
	const hasContent = run.timeline.length > 0;

	return (
		<div className={panelOpen ? "ch-app ch-app--panel" : "ch-app"}>
			<header className="ch-header">
				<div className="ch-header-left">
					<BrandMark size={18} className="ch-brand" />
					<div className="ch-title-block">
						<h1 className="ch-title" title={title}>
							{title}
						</h1>
						<div className="ch-subtitle">
							{snapshot.phase === "live" ? (
								<span className="ch-live">
									<span className="ch-live-dot" aria-hidden="true" />
									{snapshot.working ? "Working" : "Live"}
								</span>
							) : (
								<span className="ch-phase">
									{snapshot.phase === "ended"
										? "Ended"
										: snapshot.phase === "reconnecting"
											? "Reconnecting"
											: "Joining"}
								</span>
							)}
							<span className="ch-access">{snapshot.readOnly ? "Watching" : "Can steer"}</span>
							{guests && <span className="ch-guests">{guests}</span>}
						</div>
					</div>
				</div>
				<div className="ch-header-right">
					{pct !== null && (
						<span className="ch-ctx" title="Context used">
							<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
								<circle cx="8" cy="8" r="6" className="ch-ctx-track" />
								<circle
									cx="8"
									cy="8"
									r="6"
									className="ch-ctx-fill"
									strokeDasharray={`${(Math.min(100, pct) / 100) * 37.7} 37.7`}
								/>
							</svg>
							{pct.toFixed(1)}%
						</span>
					)}
					<ThemeButton className="ch-icon-btn" />
					<button
						type="button"
						className="ch-icon-btn"
						aria-pressed={panelOpen}
						aria-label={panelOpen ? "Hide session details" : "Show session details"}
						onClick={() => setPanelPref(!panelOpen)}
					>
						<PanelRight size={16} aria-hidden="true" />
					</button>
				</div>
			</header>
			{snapshot.phase === "reconnecting" && (
				<div className="ch-banner" role="status">
					<WifiOff size={14} aria-hidden="true" /> {joinHeadline(snapshot, "Oz")}. {joinDetail(snapshot)}
				</div>
			)}
			<div className="ch-body-grid">
				<main className="ch-main">
					<div className="ch-scroll" ref={scrollRef}>
						<div className="ch-column">
							{joining ? (
								<JoinState {...props} />
							) : hasContent ? (
								turns.map(turn => (
									<TurnView
										key={turn.id}
										turn={turn}
										results={run.results}
										active={snapshot.activeTools}
										diffHookId={diffHookId}
										modelName={snapshot.state?.model?.name ?? null}
									/>
								))
							) : (
								<div className="ch-empty">{EMPTY_RUN}</div>
							)}
							{snapshot.working && !snapshot.stream && run.current === null && (
								<div className="ch-working" aria-live="polite">
									<span className="ch-shine">Working</span>
								</div>
							)}
						</div>
					</div>
					{away && hasContent && (
						<button type="button" className="ch-jump" onClick={jump} aria-label="Jump to the latest">
							<ArrowDown size={15} aria-hidden="true" />
						</button>
					)}
					<div className="ch-dock">
						<div className="ch-column ch-column--dock">
							{snapshot.phase === "ended" ? (
								<EndedCard {...props} />
							) : joining ? null : (
								<Composer client={client} snapshot={snapshot} />
							)}
						</div>
					</div>
					<Toasts {...props} />
				</main>
				{panelOpen && (
					<>
						{narrow && (
							<button
								type="button"
								className="ch-scrim"
								aria-label="Close session details"
								onClick={() => setPanelPref(false)}
							/>
						)}
						<SessionPanel
							client={client}
							snapshot={snapshot}
							files={run.files}
							onClose={() => setPanelPref(false)}
						/>
					</>
				)}
			</div>
		</div>
	);
}

export const chamber: Direction = {
	id: "chamber",
	name: "Chamber",
	pitch: "OpenChamber's chat, as is: a calm centred column, folding tool rows, and a Session panel with the numbers on the right.",
	tokens: { light, dark },
	App: ChamberApp,
};

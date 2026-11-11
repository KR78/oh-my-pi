/**
 * The page's words, shared by every direction so a person who sees two of
 * them reads the same thing. Directions own layout and tone of voice in
 * their own small labels; these are the sentences that must not drift.
 */
import type { GuestSnapshot } from "../../lib/client";

export function joinHeadline(snapshot: GuestSnapshot, brand: string): string {
	switch (snapshot.phase) {
		case "connecting":
			return "Connecting";
		case "waiting":
			return snapshot.loading ? `Catching up on what ${brand} has done` : `Waiting for ${brand}'s run to answer`;
		case "reconnecting":
			return "Connection dropped. Reconnecting";
		default:
			return "";
	}
}

export function joinDetail(snapshot: GuestSnapshot): string {
	switch (snapshot.phase) {
		case "connecting":
			return "Opening an encrypted link to the run.";
		case "waiting":
			if (snapshot.loading && snapshot.loading.total > 0) {
				return `Loaded ${snapshot.loading.received.toLocaleString("en-US")} of ${snapshot.loading.total.toLocaleString("en-US")} steps.`;
			}
			return "The run is starting up. This page fills in as soon as it answers.";
		case "reconnecting":
			return "What you see stays on screen. New activity appears once the link is back.";
		default:
			return "";
	}
}

export function loadingPercent(snapshot: GuestSnapshot): number | null {
	const loading = snapshot.loading;
	if (!loading || loading.total <= 0) return null;
	return Math.min(100, Math.round((loading.received / loading.total) * 100));
}

export const ENDED_TITLE = "This session isn't live any more";
export const ENDED_HELP = "To watch it again, click the button in Slack again.";
export const ENDED_RETRY = "Try again";

/** The host's reason, worded for a person ("the run finished" stays; protocol text is softened). */
export function endedReason(snapshot: GuestSnapshot): string | null {
	const reason = snapshot.endedReason?.trim();
	if (!reason) return null;
	if (/timed out waiting for the host/.test(reason)) return "The run didn't answer in time.";
	if (/room closed|no such room/.test(reason)) return "The run has closed its live view.";
	if (/refused|4003/.test(reason)) return "This link was refused. It may have expired.";
	if (/bad key|corrupted frame/.test(reason)) return "This link doesn't open this run.";
	return reason[0]!.toUpperCase() + reason.slice(1).replace(/\.?$/, ".");
}

export const EMPTY_RUN = "Nothing has happened in this run yet.";

/** "Ama and Kofi are here", "Ama and 3 others are here". Guests only; the host is named separately. */
export function guestsLine(snapshot: GuestSnapshot): string | null {
	const guests = snapshot.state?.participants.filter(p => p.role === "guest") ?? [];
	if (guests.length === 0) return null;
	const names = guests.map(g => g.name);
	if (names.length === 1) return `${names[0]} is here`;
	if (names.length === 2) return `${names[0]} and ${names[1]} are here`;
	return `${names[0]} and ${names.length - 1} others are here`;
}

export function initials(name: string): string {
	const parts = name.trim().split(/\s+/);
	const first = parts[0]?.[0] ?? "?";
	const second = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
	return (first + second).toUpperCase();
}

export function clock(ms: number): string {
	return new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

export function seconds(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "0s";
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/** Last path segment, and the folder it sits in, for a long path shown in little room. */
export function splitPath(path: string): { dir: string; name: string } {
	const trimmed = path.replace(/^\/work\/[^/]+\//, "").replace(/^\/(?:Users|home)\/[^/]+\//, "~/");
	const i = trimmed.lastIndexOf("/");
	return i < 0 ? { dir: "", name: trimmed } : { dir: trimmed.slice(0, i + 1), name: trimmed.slice(i + 1) };
}

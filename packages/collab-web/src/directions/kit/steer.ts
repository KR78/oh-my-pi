/**
 * Steering logic shared by every composer: what a guest may do right now and
 * why not, and the Enter/Esc/IME rules. Each direction draws its own
 * composer; none of them re-decides these rules.
 */
import type { KeyboardEvent } from "react";
import { useCallback, useRef } from "react";
import type { GuestClient, GuestSnapshot } from "../../lib/client";

export type SteerBlock = "view-only" | "not-live" | null;

export interface SteerState {
	/** The guest may send prompts and answers. */
	canSteer: boolean;
	/** Why not, when not; a direction words it, never guesses it. */
	block: SteerBlock;
	/** A turn is running and the guest may stop it. */
	canInterrupt: boolean;
	working: boolean;
	queued: number;
}

export function steerState(snapshot: GuestSnapshot): SteerState {
	const live = snapshot.phase === "live";
	const block: SteerBlock = snapshot.readOnly ? "view-only" : live ? null : "not-live";
	return {
		canSteer: block === null,
		block,
		canInterrupt: block === null && snapshot.working,
		working: snapshot.working,
		queued: snapshot.state?.queuedMessageCount ?? 0,
	};
}

/** Plain words for why the composer is closed. */
export const BLOCK_WORDS: Record<Exclude<SteerBlock, null>, string> = {
	"view-only":
		"You're watching. This link lets you follow the run but not steer it; ask whoever started it for a steer link.",
	"not-live": "The run isn't connected right now. You can type again once it's back.",
};

/**
 * Enter sends, Shift+Enter breaks the line, and an Enter that confirms an
 * IME composition does neither (WebKit fires it after `compositionend`, so
 * the flag is cleared a tick late).
 */
export function useEnterToSend(onSend: () => void): {
	onKeyDown(e: KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>): void;
	onCompositionStart(): void;
	onCompositionEnd(): void;
} {
	const composing = useRef(false);
	const onKeyDown = useCallback(
		(e: KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>) => {
			if (e.key !== "Enter" || e.shiftKey) return;
			if (e.nativeEvent.isComposing || composing.current) return;
			e.preventDefault();
			onSend();
		},
		[onSend],
	);
	const onCompositionStart = useCallback(() => {
		composing.current = true;
	}, []);
	const onCompositionEnd = useCallback(() => {
		setTimeout(() => {
			composing.current = false;
		}, 0);
	}, []);
	return { onKeyDown, onCompositionStart, onCompositionEnd };
}

/** Sends a trimmed prompt when allowed; returns whether it went. */
export function sendPrompt(client: GuestClient, snapshot: GuestSnapshot, text: string): boolean {
	const trimmed = text.trim();
	if (!trimmed || !steerState(snapshot).canSteer) return false;
	client.sendPrompt(trimmed);
	return true;
}

/** Label of a select option, whichever shape it arrived in. */
export function optionLabel(option: string | { label: string; description?: string }): string {
	return typeof option === "string" ? option : option.label;
}

export function optionDescription(option: string | { label: string; description?: string }): string | null {
	return typeof option === "string" ? null : (option.description ?? null);
}

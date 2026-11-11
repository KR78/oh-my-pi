/**
 * The contract every design direction of the live session page implements.
 *
 * A direction is design only: it renders from the same {@link GuestSnapshot}
 * and acts through the same {@link GuestClient} calls as every other
 * direction (prompt, interrupt, answer, rejoin). It never touches the socket,
 * the codec, the link or the URL fragment; the shell in `app.tsx` owns those.
 */
import type { ReactNode } from "react";
import type { GuestClient, GuestSnapshot } from "../lib/client";

/** CSS custom properties without the leading `--`, e.g. `{ accent: "#b4532a" }`. */
export type TokenMap = Readonly<Record<string, string>>;

export interface DirectionProps {
	client: GuestClient;
	snapshot: GuestSnapshot;
	/**
	 * Reconnect with the same link. The ended state offers it as "Try again";
	 * it cannot mint a new link (only the Slack button can), so no direction
	 * offers one.
	 */
	onRejoin(): void;
	/** Close the session and return to the paste-a-link screen. */
	onLeave(): void;
}

export interface Direction {
	id: string;
	name: string;
	/** One line, plain words, for the gallery. */
	pitch: string;
	/**
	 * Every colour, radius and font a direction's components use. Components
	 * read only `var(--…)`; a customer theme overrides the named seam tokens
	 * (see `theme-seam.ts`) on top of these.
	 */
	tokens: { light: TokenMap; dark: TokenMap };
	App(props: DirectionProps): ReactNode;
}

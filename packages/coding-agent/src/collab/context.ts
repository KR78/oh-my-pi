/**
 * The slice of a host process that collab hosting depends on.
 *
 * `CollabHost` and `CollabController` were written against the whole
 * interactive TUI context, but they only read the session, its manager and
 * settings, and poke four UI hooks (status segment, render, status line text,
 * pending-message display). Naming that slice lets a non-interactive runner
 * (`--mode json`, `--mode rpc`) host a room with no-op hooks, while the
 * interactive mode keeps passing itself unchanged: it satisfies this type
 * structurally, so no interactive call site changed.
 */
import type { StatusLineComponent } from "@oh-my-pi/pi-tui/status-line";
import type { InteractiveModeContext } from "../modes/types";

export type CollabHostContext = Pick<
	InteractiveModeContext,
	| "session"
	| "sessionManager"
	| "settings"
	| "collabHost"
	| "collabGuest"
	| "eventBus"
	| "subagentEventBus"
	| "showStatus"
	| "updatePendingMessagesDisplay"
> & {
	statusLine: Pick<StatusLineComponent, "setCollabStatus" | "invalidate" | "getCachedContextBreakdown">;
	ui: Pick<InteractiveModeContext["ui"], "requestRender">;
};

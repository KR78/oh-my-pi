/**
 * Collab hosting for non-interactive runs (`--mode json`, `-p`, `--mode rpc`).
 *
 * The same `CollabController` the TUI uses, driven by the same
 * `collab.autoStart` policy, over a {@link CollabHostContext} whose UI hooks do
 * nothing: there is no status line, transcript, or pending-message area to
 * update. Guests prompt and interrupt through the host exactly as they do in
 * the TUI, because the host calls the session directly.
 *
 * Since nothing on screen can show the link, each room the relay opens is
 * reported once through {@link HeadlessCollabOptions.emit} — a `collab_room`
 * line in the caller's own output stream — and, when `OMP_COLLAB_LINK_FILE` is
 * set, mirrored into that file (owner-only, replaced on rotation, removed
 * when the room closes). That file exists because an embedder such as a
 * sandbox runner can read a file mid-run when it cannot see stdout until the
 * process ends. The link is a capability: it is written to those two places
 * and nowhere else — not to the logger, not to stderr.
 *
 * A relay that is down never holds the run: the controller connects in the
 * background and retries on its own backoff, and {@link HeadlessCollab.shutdown}
 * aborts a pending connection instead of waiting for it.
 */
import * as fs from "node:fs/promises";
import { $env, logger, postmortem } from "@oh-my-pi/pi-utils";
import type { AgentSession } from "../session/agent-session";
import type { EventBus } from "../utils/event-bus";
import type { CollabHostContext } from "./context";
import { CollabController } from "./controller";
import type { CollabHost } from "./host";
import { parseCollabLink } from "./protocol";
import type { CollabAccess } from "./registry";
import { cfgCollabAutoStart } from "./settings";

/**
 * Announcement of a live room. `webLink`/`link` carry the highest access the
 * room was started with (`access`); a view room never exposes its write token.
 * `roomId`, `relayUrl`, `viewSecret` and `controlSecret` are the parts those
 * links are built from (`<relayUrl>/r/<roomId>.<secret>`), for embedders that
 * mint their own per-user URLs instead of handing this one out.
 */
export interface CollabRoomEvent {
	type: "collab_room";
	access: CollabAccess;
	/** Browser deep link at `access`. */
	webLink: string;
	/** Terminal link (`omp join`) at `access`. */
	link: string;
	viewWebLink: string;
	viewLink: string;
	/** Registry generation; a replacement room in the same run has a higher one. */
	generation: number;
	roomId: string;
	/** WebSocket relay origin the room lives on (`ws(s)://host[:port]`). */
	relayUrl: string;
	/** base64url of the 32-byte room key: a view-only link's secret. */
	viewSecret: string;
	/** base64url of key ∥ write token: a control link's secret. Absent for view rooms. */
	controlSecret?: string;
}

export interface HeadlessCollabOptions {
	/** Report a room on the run's own machine-readable channel. Omit for none (link file only). */
	emit?: (event: CollabRoomEvent) => void;
	eventBus?: EventBus;
	subagentEventBus?: EventBus;
}

export interface HeadlessCollab {
	/** Startup has finished: guests may now prompt and interrupt. */
	startupComplete(): void;
	/** Say goodbye to guests, withdraw the room, and remove the link file. Idempotent. */
	shutdown(reason: string): Promise<void>;
}

/** Link file the room is mirrored into; see the module header. */
export const COLLAB_LINK_FILE_ENV = "OMP_COLLAB_LINK_FILE";

function roomEvent(host: CollabHost): CollabRoomEvent {
	const control = host.access === "control";
	const parsed = parseCollabLink(host.link);
	if ("error" in parsed) throw new Error(parsed.error);
	const event: CollabRoomEvent = {
		type: "collab_room",
		access: host.access,
		webLink: control ? host.webLink : host.webViewLink,
		link: control ? host.link : host.viewLink,
		viewWebLink: host.webViewLink,
		viewLink: host.viewLink,
		generation: host.generation,
		roomId: parsed.roomId,
		relayUrl: parsed.wsUrl.slice(0, parsed.wsUrl.length - `/r/${parsed.roomId}`.length),
		viewSecret: Buffer.from(parsed.key).toString("base64url"),
	};
	if (control && parsed.writeToken) {
		event.controlSecret = Buffer.concat([parsed.key, parsed.writeToken]).toString("base64url");
	}
	return event;
}

/**
 * Write via a sibling temp file created 0600 and renamed into place, so a
 * reader never sees a partial file and the secret never sits in a file with
 * broader permissions, even for a moment.
 */
async function writeLinkFile(file: string, event: CollabRoomEvent): Promise<void> {
	const tmp = `${file}.${process.pid}.tmp`;
	await fs.writeFile(tmp, `${JSON.stringify(event)}\n`, { mode: 0o600 });
	await fs.rename(tmp, file);
}

/**
 * Start hosting per `collab.autoStart`, or return `undefined` when it is off.
 * Call before extension `session_start` hooks run, then
 * {@link HeadlessCollab.startupComplete} once startup is done.
 */
export function startHeadlessCollab(
	session: AgentSession,
	options: HeadlessCollabOptions = {},
): HeadlessCollab | undefined {
	if (cfgCollabAutoStart.get(session.settings) === "off") return undefined;
	const linkFile = $env[COLLAB_LINK_FILE_ENV]?.trim() || undefined;
	// File writes are serialized so a rotation's delete can never overtake the
	// previous room's write, and shutdown can wait for the last one.
	let fileOps: Promise<void> = Promise.resolve();
	const fileOp = (op: () => Promise<void>): void => {
		fileOps = fileOps.then(op).catch(err => logger.warn("Collab link file update failed", { error: String(err) }));
	};

	const ctx: CollabHostContext = {
		session,
		sessionManager: session.sessionManager,
		settings: session.settings,
		eventBus: options.eventBus,
		subagentEventBus: options.subagentEventBus,
		showStatus: () => {},
		updatePendingMessagesDisplay: () => {},
		ui: { requestRender: () => {} },
		statusLine: {
			setCollabStatus: () => {},
			invalidate: () => {},
			getCachedContextBreakdown: () => {
				const breakdown = session.getContextBreakdown();
				return {
					usedTokens: breakdown?.usedTokens ?? 0,
					contextWindow: breakdown?.contextWindow ?? session.model?.contextWindow ?? 0,
				};
			},
		},
	};
	const controller = new CollabController(ctx, {
		onRoomOpened: host => {
			let event: CollabRoomEvent;
			try {
				event = roomEvent(host);
			} catch (err) {
				logger.warn("Collab room could not be reported", { error: String(err) });
				return;
			}
			// File first, then the line: a reader that sees the line can rely on the file.
			fileOp(async () => {
				if (linkFile) await writeLinkFile(linkFile, event);
				options.emit?.(event);
			});
		},
		onRoomClosed: () => {
			if (linkFile) fileOp(() => fs.rm(linkFile, { force: true }));
		},
	});

	let shutdownDone: Promise<void> | undefined;
	const shutdown = (reason: string): Promise<void> => {
		shutdownDone ??= (async () => {
			cancelSignalTeardown();
			try {
				await controller.shutdown(reason);
			} catch (err) {
				logger.warn("Collab shutdown failed", { error: String(err) });
			}
			await fileOps;
			// A room that never reported closed (teardown threw) must not leave its link behind.
			if (linkFile) await fs.rm(linkFile, { force: true }).catch(() => {});
		})();
		return shutdownDone;
	};
	// A signal ends the run without reaching the caller's shutdown: guests still
	// get their goodbye and the link file is still removed.
	const cancelSignalTeardown = postmortem.register("headless-collab", () => shutdown("host exited"));

	controller.autoStart();
	return { startupComplete: () => controller.startupComplete(), shutdown };
}

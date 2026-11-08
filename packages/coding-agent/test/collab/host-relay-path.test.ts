/**
 * Contract: a path on `collab.relayUrl` (e.g. an authenticating relay's
 * `/h/<host-token>`) is kept on the HOST's own connection — `<origin><path>/r/<room>`
 * — and appears in no link a guest is given: guest links stay
 * `<host>/r/<room>.<secret>`, since the token is the host's credential, not
 * the room's. Real CollabHost/CollabSocket over the in-memory relay, which
 * records every URL dialled.
 */
import { afterEach, beforeEach, expect, it } from "bun:test";
import { importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import type { CollabHostContext } from "@oh-my-pi/pi-coding-agent/collab/context";
import { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import { COLLAB_PROTO, parseCollabLink } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { FakeWebSocket, installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";

const TOKEN = "hosttoken_Zx9-secretpart";
let dialed: string[];
let host: CollabHost | undefined;

beforeEach(() => {
	installInMemoryRelay();
	dialed = [];
	globalThis.WebSocket = class extends FakeWebSocket {
		constructor(url: string) {
			super(url);
			dialed.push(url);
		}
	} as unknown as typeof WebSocket;
});

afterEach(async () => {
	uninstallInMemoryRelay();
	await host?.stop("test done");
	host = undefined;
});

function context(): CollabHostContext {
	return {
		settings: Settings.isolated(),
		sessionManager: {
			getSessionId: () => "sess-path",
			getCwd: () => "/tmp",
			snapshotForReplication: () => ({
				header: { type: "session", id: "sess-path", timestamp: new Date().toISOString(), cwd: "/tmp" },
				entries: [],
			}),
			onEntryAppended: undefined,
		},
		session: {
			isStreaming: false,
			isSessionTransitioning: false,
			queuedMessageCount: 0,
			subscribe: () => () => {},
			emitNotice: () => {},
		},
		statusLine: {
			setCollabStatus: () => {},
			invalidate: () => {},
			getCachedContextBreakdown: () => ({ usedTokens: 0, contextWindow: 0 }),
		},
		ui: { requestRender: () => {} },
		showStatus: () => {},
		updatePendingMessagesDisplay: () => {},
	} as unknown as CollabHostContext;
}

it.each([
	["wss://relay.example/h/TOKEN", "wss://relay.example"],
	["wss://relay.example:8443/h/TOKEN/", "wss://relay.example:8443"],
	["ws://localhost:8787/h/TOKEN", "ws://localhost:8787"],
])("dials %s with the path kept, and keeps it out of every guest link", async (relayTemplate, origin) => {
	const relayUrl = relayTemplate.replace("TOKEN", TOKEN);
	host = new CollabHost(context());
	await host.start(relayUrl);

	const roomId = (parseCollabLink(host.link) as { roomId: string }).roomId;
	expect(dialed).toEqual([`${origin}/h/${TOKEN}/r/${roomId}?role=host`]);
	for (const link of [host.link, host.webLink, host.viewLink, host.webViewLink]) {
		expect(link).not.toContain(TOKEN);
		expect(link).not.toContain("/h/");
		const parsed = parseCollabLink(link);
		if ("error" in parsed) throw new Error(parsed.error);
		expect(parsed.wsUrl).toBe(`${origin}/r/${roomId}`);
	}
});

it("a guest joins through the token-free link", async () => {
	host = new CollabHost(context());
	await host.start(`ws://localhost:8787/h/${TOKEN}`);
	const parsed = parseCollabLink(host.link);
	if ("error" in parsed) throw new Error(parsed.error);
	const guest = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key: await importRoomKey(parsed.key) });
	const welcomed = Promise.withResolvers<void>();
	guest.onFrame = frame => {
		if (frame.t === "welcome") welcomed.resolve();
	};
	guest.onOpen = () => guest.send({ t: "hello", proto: COLLAB_PROTO, name: "g" });
	guest.connect();
	try {
		await welcomed.promise;
		expect(dialed.at(-1)).toBe(`ws://localhost:8787/r/${parsed.roomId}?role=guest`);
	} finally {
		guest.close();
	}
});

it("a relay URL without a path dials /r/<room> as before", async () => {
	host = new CollabHost(context());
	await host.start("ws://localhost:8787");
	const roomId = (parseCollabLink(host.link) as { roomId: string }).roomId;
	expect(dialed).toEqual([`ws://localhost:8787/r/${roomId}?role=host`]);
});

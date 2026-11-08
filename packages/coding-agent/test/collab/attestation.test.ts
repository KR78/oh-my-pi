/**
 * Contract: when the relay attests who joined (`peer-joined` carrying `user`,
 * `name`, `access`), that attestation — not the link and not the guest's own
 * hello — decides a guest's write permission and display name. A control
 * link is still required to write; an attested `view` caps it read-only. With
 * `collab.requireAttestation`, an unattested guest is read-only and shown as
 * `unverified-<peer>`. Without attestation and without the setting, nothing
 * changes. Guest prompts carry the attested identity in their details, never
 * in the text the model reads.
 *
 * Real CollabHost/CollabSocket with real sealing over the in-memory relay;
 * only the host's session and UI are stubbed.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import { COLLAB_PROTO, type CollabFrame, parseCollabLink } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { CollabHostContext } from "@oh-my-pi/pi-coding-agent/collab/context";
import { type InMemoryRelay, installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";

interface Prompted {
	content: unknown;
	details: Record<string, unknown>;
}

let relay: InMemoryRelay;
let host: CollabHost | undefined;
let prompts: Prompted[];
let promptWaiters: ((prompt: Prompted) => void)[];
const cleanups: (() => void)[] = [];

function makeContext(settings: Record<string, unknown> = {}): CollabHostContext {
	return {
		settings: Settings.isolated(settings),
		sessionManager: {
			getSessionId: () => "sess-attest",
			getCwd: () => "/tmp",
			snapshotForReplication: () => ({
				header: { type: "session", id: "sess-attest", timestamp: new Date().toISOString(), cwd: "/tmp" },
				entries: [],
			}),
			onEntryAppended: undefined,
		},
		session: {
			isStreaming: false,
			isSessionTransitioning: false,
			queuedMessageCount: 0,
			sessionName: "attest",
			model: undefined,
			thinkingLevel: undefined,
			subscribe: () => () => {},
			emitNotice: () => {},
			promptCustomMessage: (message: { content: unknown; details?: Record<string, unknown> }) => {
				const prompted = { content: message.content, details: message.details ?? {} };
				prompts.push(prompted);
				for (const waiter of promptWaiters.splice(0)) waiter(prompted);
				return Promise.resolve(true);
			},
			abort: () => Promise.resolve(),
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

async function startHost(settings: Record<string, unknown> = {}): Promise<CollabHost> {
	host = new CollabHost(makeContext(settings));
	await host.start("ws://localhost:8787");
	return host;
}

const BROADCAST: Record<string, true> = {
	state: true,
	agents: true,
	entry: true,
	event: true,
	bus: true,
	"snapshot-chunk": true,
};

/** Join with `link`, saying hello as `name`; resolves with the welcome and a directed-frame reader. */
async function join(link: string, name: string) {
	const parsed = parseCollabLink(link);
	if ("error" in parsed) throw new Error(parsed.error);
	const writeToken = parsed.writeToken ? Buffer.from(parsed.writeToken).toString("base64url") : undefined;
	const socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key: await importRoomKey(parsed.key) });
	cleanups.push(() => socket.close());
	const queue: CollabFrame[] = [];
	const waiters: ((frame: CollabFrame) => void)[] = [];
	socket.onFrame = frame => {
		if (BROADCAST[frame.t]) return;
		const waiter = waiters.shift();
		if (waiter) waiter(frame);
		else queue.push(frame);
	};
	socket.onOpen = () => socket.send({ t: "hello", proto: COLLAB_PROTO, name, writeToken });
	socket.connect();
	const next = (): Promise<CollabFrame> => {
		const queued = queue.shift();
		if (queued) return Promise.resolve(queued);
		const { promise, resolve } = Promise.withResolvers<CollabFrame>();
		waiters.push(resolve);
		return promise;
	};
	const welcome = await next();
	if (welcome.t !== "welcome") throw new Error(`expected welcome, got ${welcome.t}`);
	return { socket, welcome, next };
}

function nextPrompt(): Promise<Prompted> {
	const { promise, resolve } = Promise.withResolvers<Prompted>();
	promptWaiters.push(resolve);
	return promise;
}

function guestNames(): string[] {
	return (host?.participants ?? []).filter(p => p.role === "guest").map(p => p.name);
}

beforeEach(() => {
	relay = installInMemoryRelay();
	prompts = [];
	promptWaiters = [];
});

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
	uninstallInMemoryRelay();
	await host?.stop("test done");
	host = undefined;
});

describe("relay-attested guest identity", () => {
	it("an attested control guest with a control link can prompt, under its attested name", async () => {
		relay.attest = () => ({ user: "U0AAA", name: "Ada Lovelace", access: "control" });
		const room = await startHost();
		const guest = await join(room.link, "self-declared");
		expect(guest.welcome.readOnly).toBeUndefined();
		expect(guestNames()).toEqual(["Ada Lovelace"]);

		const prompted = nextPrompt();
		guest.socket.send({ t: "prompt", text: "ship it" });
		const prompt = await prompted;
		expect(prompt.details).toEqual({ from: "Ada Lovelace", user: "U0AAA" });
		// The model reads the guest's text verbatim; identity rides only in details.
		expect(prompt.content).toBe("ship it");
	});

	it("an attested view guest is read-only even with a valid control link", async () => {
		relay.attest = () => ({ user: "U0BBB", name: "Viewer", access: "view" });
		const room = await startHost();
		const guest = await join(room.link, "viewer");
		expect(guest.welcome.readOnly).toBe(true);
		guest.socket.send({ t: "prompt", text: "let me in" });
		const reply = await guest.next();
		expect(reply).toMatchObject({ t: "error", message: "prompting is disabled on a read-only link" });
		expect(prompts).toEqual([]);
	});

	it("attested control does not substitute for the link's write token", async () => {
		relay.attest = () => ({ user: "U0CCC", name: "No Token", access: "control" });
		const room = await startHost();
		const guest = await join(room.viewLink, "no-token");
		expect(guest.welcome.readOnly).toBe(true);
	});

	it("falls back to the attested user id when the relay sends no name", async () => {
		relay.attest = () => ({ user: "U0DDD", access: "control" });
		const room = await startHost();
		await join(room.link, "self-declared");
		expect(guestNames()).toEqual(["U0DDD"]);
	});

	it("requireAttestation makes an unattested guest read-only and unverified", async () => {
		const room = await startHost({ "collab.requireAttestation": true });
		const guest = await join(room.link, "trust-me");
		expect(guest.welcome.readOnly).toBe(true);
		expect(guestNames()).toEqual([expect.stringMatching(/^unverified-\d+$/)]);
		guest.socket.send({ t: "prompt", text: "let me in" });
		expect(await guest.next()).toMatchObject({ t: "error" });
		expect(prompts).toEqual([]);
	});

	it("requireAttestation still admits an attested control guest", async () => {
		relay.attest = () => ({ user: "U0EEE", name: "Verified", access: "control" });
		const room = await startHost({ "collab.requireAttestation": true });
		const guest = await join(room.link, "trust-me");
		expect(guest.welcome.readOnly).toBeUndefined();
		expect(guestNames()).toEqual(["Verified"]);
	});

	it("without attestation or the setting, the link and hello decide as before", async () => {
		const room = await startHost();
		const guest = await join(room.link, "plain-guest");
		expect(guest.welcome.readOnly).toBeUndefined();
		expect(guestNames()).toEqual(["plain-guest"]);
		const prompted = nextPrompt();
		guest.socket.send({ t: "prompt", text: "hello" });
		expect((await prompted).details).toEqual({ from: "plain-guest" });
	});

	it("ignores a malformed attestation rather than trusting part of it", async () => {
		relay.attest = () => ({ user: "U0FFF", name: "Odd", access: "admin" });
		const room = await startHost({ "collab.requireAttestation": true });
		const guest = await join(room.link, "odd");
		expect(guest.welcome.readOnly).toBe(true);
		expect(guestNames()).toEqual([expect.stringMatching(/^unverified-\d+$/)]);
	});
});

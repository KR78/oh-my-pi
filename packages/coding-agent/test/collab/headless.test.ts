/**
 * Contract: a non-interactive run (`omp -p --mode json`) hosts a collab room
 * when `collab.autoStart` is `view` or `control`, exactly as an interactive
 * session would, and reports it through ONE `collab_room` JSON line on stdout
 * plus an optional owner-only link file (`OMP_COLLAB_LINK_FILE`). A guest
 * holding the control link steers and interrupts the run; the run ends by
 * saying goodbye to guests and removing the link file; an unreachable relay
 * never delays or fails the run. The link never reaches stderr.
 *
 * Real AgentSession (scripted mock model), real print mode, real CollabHost,
 * real local relay (`packages/collab-web/scripts/local-relay.ts`) over real
 * WebSockets. Only the registry directory is redirected into a temp dir.
 */
import { afterEach, beforeEach, describe, expect, it, type Mock, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockHandler, type MockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { COLLAB_PROTO, type CollabFrame, parseCollabLink } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import * as registry from "@oh-my-pi/pi-coding-agent/collab/registry";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runPrintMode } from "@oh-my-pi/pi-coding-agent/modes/print-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { type LocalRelay, startLocalRelay } from "../../../collab-web/scripts/local-relay";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";

interface CollabRoomLine {
	type: "collab_room";
	access: "view" | "control";
	webLink: string;
	link: string;
	viewWebLink: string;
	viewLink: string;
	generation: number;
	roomId: string;
	relayUrl: string;
	relayHost: string;
	viewSecret: string;
	controlSecret?: string;
}

let tmp: string;
let relay: LocalRelay | undefined;
let authStorage: AuthStorage | undefined;
let session: AgentSession | undefined;
let publishSpy: Mock<typeof registry.publishCollabHost>;
let stdoutLines: string[];
let stderrText: string;
let roomLineSeen: PromiseWithResolvers<CollabRoomLine>;
const guestCleanups: (() => void)[] = [];
const originalLinkFile = process.env.OMP_COLLAB_LINK_FILE;

beforeEach(async () => {
	tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-collab-headless-"));
	const real = registry.publishCollabHost;
	publishSpy = spyOn(registry, "publishCollabHost").mockImplementation((source, options) =>
		real(source, { ...options, dir: path.join(tmp, "registry") }),
	);
	stdoutLines = [];
	stderrText = "";
	roomLineSeen = Promise.withResolvers<CollabRoomLine>();
	let pending = "";
	spyOn(process.stdout, "write").mockImplementation((...args: unknown[]) => {
		const chunk = args[0];
		pending += typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString();
		let newline = pending.indexOf("\n");
		while (newline >= 0) {
			const line = pending.slice(0, newline);
			pending = pending.slice(newline + 1);
			stdoutLines.push(line);
			try {
				const parsed = JSON.parse(line) as { type?: string };
				if (parsed.type === "collab_room") roomLineSeen.resolve(parsed as CollabRoomLine);
			} catch {}
			newline = pending.indexOf("\n");
		}
		const cb = args[args.length - 1];
		if (typeof cb === "function") (cb as (err?: Error | null) => void)(null);
		return true;
	});
	spyOn(process.stderr, "write").mockImplementation((...args: unknown[]) => {
		const chunk = args[0];
		stderrText += typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString();
		const cb = args[args.length - 1];
		if (typeof cb === "function") (cb as (err?: Error | null) => void)(null);
		return true;
	});
});

afterEach(async () => {
	for (const cleanup of guestCleanups.splice(0).reverse()) cleanup();
	vi.restoreAllMocks();
	await session?.dispose().catch(() => {});
	session = undefined;
	authStorage?.close();
	authStorage = undefined;
	relay?.stop();
	relay = undefined;
	if (originalLinkFile === undefined) delete process.env.OMP_COLLAB_LINK_FILE;
	else process.env.OMP_COLLAB_LINK_FILE = originalLinkFile;
	await fs.rm(tmp, { recursive: true, force: true });
});

async function createSession(
	settings: Record<string, unknown>,
	responses: Iterable<MockHandler> | AsyncIterable<MockHandler>,
) {
	authStorage = await AuthStorage.create(":memory:");
	authStorage.keys.setRuntime("anthropic", "test-key");
	const mock: MockModel = createMockModel({ responses });
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model: getBundledModel("anthropic", "claude-sonnet-4-5")!, systemPrompt: ["Test"], tools: [] },
		streamFn: mock.stream,
		convertToLlm,
	});
	session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(tmp),
		settings: Settings.isolated({ "compaction.enabled": false, ...settings }),
		modelRegistry: new ModelRegistry(authStorage),
	});
	return { session, mock };
}

/** Join through a link as the given guest; resolves after `welcome`. */
async function joinGuest(link: string, name: string, frames: CollabFrame[] = []) {
	const parsed = parseCollabLink(link);
	if ("error" in parsed) throw new Error(parsed.error);
	const writeToken = parsed.writeToken ? Buffer.from(parsed.writeToken).toString("base64url") : undefined;
	const socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key: await importRoomKey(parsed.key) });
	guestCleanups.push(() => socket.close());
	const welcomed = Promise.withResolvers<CollabFrame & { t: "welcome" }>();
	const bye = Promise.withResolvers<string>();
	socket.onFrame = frame => {
		frames.push(frame);
		if (frame.t === "welcome") welcomed.resolve(frame);
		if (frame.t === "bye") bye.resolve(frame.reason);
	};
	socket.onOpen = () => socket.send({ t: "hello", proto: COLLAB_PROTO, name, writeToken });
	socket.connect();
	const welcome = await welcomed.promise;
	return { socket, welcome, bye: bye.promise };
}

function roomLines(): CollabRoomLine[] {
	return stdoutLines
		.map(line => {
			try {
				return JSON.parse(line) as { type?: string };
			} catch {
				return {};
			}
		})
		.filter((value): value is CollabRoomLine => value.type === "collab_room");
}

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map(part => (part && typeof part === "object" && "text" in part ? String(part.text) : "")).join("");
}

describe("headless collab hosting in --mode json", () => {
	it("announces the room once, lets a control guest steer the run, and says goodbye before the run ends", async () => {
		relay = startLocalRelay();
		const linkFile = path.join(tmp, "collab-link.json");
		process.env.OMP_COLLAB_LINK_FILE = linkFile;
		const guestPrompted = Promise.withResolvers<void>();
		const { session, mock } = await createSession(
			{ "collab.autoStart": "control", "collab.relayUrl": relay.url },
			(async function* () {
				// Hold the first turn open until the guest's prompt has been admitted,
				// so the guest steers a live run rather than racing its end.
				await guestPrompted.promise;
				yield { content: ["first answer"] };
				yield { content: ["answer to the guest"] };
			})(),
		);
		const promptCustomMessage = session.promptCustomMessage.bind(session);
		spyOn(session, "promptCustomMessage").mockImplementation((...args) => {
			const admitted = promptCustomMessage(...args);
			guestPrompted.resolve();
			return admitted;
		});

		const run = runPrintMode(session, { mode: "json", initialMessage: "hello" });
		const room = await roomLineSeen.promise;

		expect(room.access).toBe("control");
		expect(room.generation).toBe(1);
		expect(room.link.startsWith(`${relay.url}/r/${room.roomId}.`)).toBe(true);
		expect(room.viewLink.startsWith(`${relay.url}/r/${room.roomId}.`)).toBe(true);
		expect(room.relayUrl).toBe(relay.url);
		expect(room.relayHost).toBe(new URL(relay.url).host);
		expect(room.link.endsWith(`.${room.controlSecret}`)).toBe(true);
		expect(room.viewLink.endsWith(`.${room.viewSecret}`)).toBe(true);
		const linkParsed = parseCollabLink(room.webLink);
		if ("error" in linkParsed) throw new Error(linkParsed.error);
		expect(linkParsed.writeToken).toBeDefined();
		const viewParsed = parseCollabLink(room.viewWebLink);
		if ("error" in viewParsed) throw new Error(viewParsed.error);
		expect(viewParsed.writeToken).toBeUndefined();

		// The link file mirrors the event, owner-only.
		const stat = await fs.stat(linkFile);
		expect(stat.mode & 0o777).toBe(0o600);
		expect(JSON.parse(await fs.readFile(linkFile, "utf8"))).toEqual(room);

		const guest = await joinGuest(room.webLink, "steerer");
		expect(guest.welcome.readOnly).toBeUndefined();
		guest.socket.send({ t: "prompt", text: "please also say hi to the guest" });

		const exitCode = await run;
		expect(exitCode).toBe(0);
		expect(await guest.bye).toBeString();

		// The guest's prompt reached the model, verbatim and without the guest name.
		const seen = mock.calls.flatMap(call => call.context.messages.map(message => messageText(message.content)));
		expect(seen.some(text => text.includes("please also say hi to the guest"))).toBe(true);
		expect(seen.some(text => text.includes("steerer"))).toBe(false);

		expect(roomLines()).toHaveLength(1);
		await expect(fs.stat(linkFile)).rejects.toThrow();
		const secret = room.link.slice(room.link.lastIndexOf(".") + 1);
		expect(stderrText).not.toContain(room.roomId);
		expect(stderrText).not.toContain(secret);
		expect(stderrText).not.toContain(room.viewSecret);
	}, 20_000);

	it("lets a control guest interrupt the running turn", async () => {
		relay = startLocalRelay();
		const { session } = await createSession({ "collab.autoStart": "control", "collab.relayUrl": relay.url }, [
			{ content: ["never finishes"], delayMs: 60_000 },
		]);
		const run = runPrintMode(session, { mode: "json", initialMessage: "long task" });
		const room = await roomLineSeen.promise;
		const guest = await joinGuest(room.webLink, "interrupter");
		guest.socket.send({ t: "abort" });
		const exitCode = await run;
		const assistantEnds = stdoutLines
			.map(line => JSON.parse(line) as { type?: string; message?: { role?: string; stopReason?: string } })
			.filter(event => event.type === "message_end" && event.message?.role === "assistant");
		expect(assistantEnds.at(-1)?.message?.stopReason).toBe("aborted");
		// An aborted turn is a terminal failure for print mode; the point is that it ended.
		expect(exitCode).toBe(1);
	}, 20_000);

	it("view auto-start hands out only view links", async () => {
		relay = startLocalRelay();
		const { session } = await createSession({ "collab.autoStart": "view", "collab.relayUrl": relay.url }, [
			{ content: ["done"], delayMs: 300 },
		]);
		const run = runPrintMode(session, { mode: "json", initialMessage: "hello" });
		const room = await roomLineSeen.promise;
		expect(room.access).toBe("view");
		expect(room.controlSecret).toBeUndefined();
		for (const link of [room.webLink, room.link, room.viewWebLink, room.viewLink]) {
			const parsed = parseCollabLink(link);
			if ("error" in parsed) throw new Error(parsed.error);
			expect(parsed.writeToken).toBeUndefined();
		}
		expect(await run).toBe(0);
	}, 20_000);

	it("an unreachable relay neither delays nor fails the run, and announces nothing", async () => {
		const linkFile = path.join(tmp, "collab-link.json");
		process.env.OMP_COLLAB_LINK_FILE = linkFile;
		// Reserve a port, then close it: connections are refused.
		const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
		const deadUrl = `ws://127.0.0.1:${probe.port}`;
		probe.stop(true);
		const { session } = await createSession({ "collab.autoStart": "control", "collab.relayUrl": deadUrl }, [
			{ content: ["done"] },
		]);
		const startedAt = Date.now();
		const exitCode = await runPrintMode(session, { mode: "json", initialMessage: "hello" });
		expect(exitCode).toBe(0);
		expect(Date.now() - startedAt).toBeLessThan(5_000);
		expect(roomLines()).toHaveLength(0);
		await expect(fs.stat(linkFile)).rejects.toThrow();
		expect(stdoutLines.some(line => line.includes('"type":"agent_end"'))).toBe(true);
	}, 20_000);

	it("auto-start off hosts nothing", async () => {
		relay = startLocalRelay();
		const { session } = await createSession({ "collab.relayUrl": relay.url }, [{ content: ["done"] }]);
		expect(await runPrintMode(session, { mode: "json", initialMessage: "hello" })).toBe(0);
		expect(roomLines()).toHaveLength(0);
		expect(publishSpy).not.toHaveBeenCalled();
	}, 20_000);

	it("keeps a host token on the relay URL out of the event and the link file", async () => {
		installInMemoryRelay();
		try {
			const token = "hosttoken_Q7-verysecret";
			const linkFile = path.join(tmp, "collab-link.json");
			process.env.OMP_COLLAB_LINK_FILE = linkFile;
			const release = Promise.withResolvers<void>();
			const { session } = await createSession(
				{ "collab.autoStart": "control", "collab.relayUrl": `wss://relay.example:8443/h/${token}` },
				(async function* () {
					await release.promise;
					yield { content: ["done"] };
				})(),
			);
			const run = runPrintMode(session, { mode: "json", initialMessage: "hello" });
			const room = await roomLineSeen.promise;
			const fileText = await fs.readFile(linkFile, "utf8");
			release.resolve();
			expect(await run).toBe(0);

			expect(room.relayHost).toBe("relay.example:8443");
			expect(room.relayUrl).toBe("wss://relay.example:8443");
			expect(room.link).toBe(`relay.example:8443/r/${room.roomId}.${room.controlSecret}`);
			expect(room.viewLink).toBe(`relay.example:8443/r/${room.roomId}.${room.viewSecret}`);
			expect(JSON.stringify(room)).not.toContain(token);
			expect(fileText).not.toContain(token);
			expect(stdoutLines.join("\n")).not.toContain(token);
		} finally {
			uninstallInMemoryRelay();
		}
	}, 20_000);
});

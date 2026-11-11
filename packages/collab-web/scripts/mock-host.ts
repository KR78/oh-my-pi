/**
 * Offline mock collab host: starts the local relay, opens a room as host, and
 * serves the canned fixture session to any collab-web guest that joins.
 *
 *   bun scripts/mock-host.ts [--port 7466] [--session <file.jsonl>] [--stress] [--autoplay] [--dev-room]
 *
 * Replays a scripted streaming turn on every guest prompt, ticks subagent
 * progress on the bus every 2s, and answers fetch-transcript with byte slices
 * of the fixture JSONL — exactly the frames a real `omp /collab` host emits.
 *
 * - `--session` serves a real Oz session log instead of the fixture; its last
 *   turn is held back and replayed live on the next prompt (see
 *   `session-scenario.ts`).
 * - `--stress` appends a 2,000-line diff, a 3,000-line output and a
 *   200-character path.
 * - `--autoplay` starts the replay once the first guest joins, so a run is
 *   mid-stream without anyone typing.
 * - `--dev-room` opens the gallery's fixed test room so the gallery links
 *   straight to it.
 *
 * Two links are printed: the full (steer) link and the view link, which
 * carries the bare key so the host marks that guest read-only.
 *
 * Guest prompts that start with a slash drive states a real run reaches on
 * its own: `/ask` (a select question), `/ask text` (a free-text question) and
 * `/end` (this guest receives `bye`, as when the run finishes).
 */

import type { AgentSnapshot, HostFrame, SessionEntry, SessionState, WireFrame } from "@oh-my-pi/pi-wire";
import type { CollabUiRequestDraft } from "@oh-my-pi/pi-wire";
import { WRITE_TOKEN_BYTES } from "@oh-my-pi/pi-wire";
import { generateRoomKey, importRoomKey, open, seal } from "../src/lib/codec";
import {
	COLLAB_PROTO,
	encodeBase64Url,
	formatCollabLink,
	generateRoomId,
	packEnvelope,
	unpackEnvelope,
} from "../src/lib/link";
import {
	fixtureAgents,
	fixtureEntries,
	fixtureHeader,
	fixtureModel,
	HOST_DISPLAY_NAME,
	makeProbeProgress,
	makeScriptedTurn,
	type ScriptedStep,
	subagentTranscriptJsonl,
} from "./fixture";
import { startLocalRelay } from "./local-relay";
import { DEV_ROOM_ID, DEV_ROOM_KEY, DEV_WRITE_TOKEN } from "../src/dev/dev-room";
import { loadSessionScenario } from "./session-scenario";
import { stressEntries } from "./stress";

const DEFAULT_PORT = 7466;
const DEFAULT_STEP_MS = 40;
const TICK_INTERVAL_MS = 2_000;
const AGENTS_SNAPSHOT_EVERY = 5;

function flagValue(argv: string[], name: string): string | undefined {
	let raw: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === name) raw = argv[i + 1];
		else if (arg.startsWith(`${name}=`)) raw = arg.slice(name.length + 1);
	}
	return raw;
}

function parsePort(argv: string[]): number {
	const raw = flagValue(argv, "--port");
	if (raw === undefined) return DEFAULT_PORT;
	const port = Number(raw);
	if (!Number.isInteger(port) || port < 1 || port > 65_535) {
		console.error(`mock-host: invalid --port ${raw}`);
		process.exit(1);
	}
	return port;
}

const argv = Bun.argv.slice(2);
const port = parsePort(argv);
const sessionFile = flagValue(argv, "--session");
const stress = argv.includes("--stress");
const autoplay = argv.includes("--autoplay");
const devRoom = argv.includes("--dev-room");
// Slower replay for screenshots and demos: `--step-ms 120`.
const stepMs = Number(flagValue(argv, "--step-ms")) || DEFAULT_STEP_MS;
const scenario = sessionFile ? await loadSessionScenario(sessionFile) : null;
const header = scenario?.header ?? fixtureHeader;
const model = scenario?.model ?? fixtureModel;
const hostName = scenario ? "Oz" : HOST_DISPLAY_NAME;

const relay = startLocalRelay(port);
// `--dev-room` uses the gallery's fixed, published test room (see src/dev/dev-room.ts).
const roomId = devRoom ? DEV_ROOM_ID : generateRoomId();
const rawKey = devRoom ? DEV_ROOM_KEY : generateRoomKey();
const key = await importRoomKey(rawKey);
const writeToken = devRoom ? DEV_WRITE_TOKEN : new Uint8Array(WRITE_TOKEN_BYTES);
if (!devRoom) crypto.getRandomValues(writeToken);
const writeTokenText = encodeBase64Url(writeToken);
const link = formatCollabLink(relay.url, roomId, rawKey, writeToken);
const viewLink = formatCollabLink(relay.url, roomId, rawKey);

// ── mutable session state ────────────────────────────────────────────────────

const entries: SessionEntry[] = [...(scenario?.entries ?? fixtureEntries)];
if (stress) entries.push(...stressEntries(entries[entries.length - 1]?.id ?? null));
const agents: AgentSnapshot[] = scenario
	? [
			{
				id: "main",
				displayName: "Oz",
				kind: "main",
				status: "running",
				hasSessionFile: false,
				createdAt: Date.now(),
				lastActivity: Date.now(),
			},
		]
	: fixtureAgents.map(agent => ({ ...agent }));
const peers = new Map<number, { name: string; canWrite: boolean }>();
let uiReqSeq = 0;
let autoplayed = false;
const transcriptBytes = new TextEncoder().encode(subagentTranscriptJsonl);
const transcriptDecoder = new TextDecoder();

let lastEntryId: string | null = entries[entries.length - 1]?.id ?? null;
let streaming = false;
let queuedPrompts = 0;
let turnSeq = 0;
let liveEntrySeq = 0;
let replayQueue: ScriptedStep[] = [];
let replayTimer: Timer | null = null;
let tick = 0;
let shuttingDown = false;

// ── sealed transport (order-preserving, mirrors relay-client) ────────────────

const ws = new WebSocket(`${relay.url}/r/${roomId}?role=host`);
ws.binaryType = "arraybuffer";

let sendChain: Promise<void> = Promise.resolve();
let recvChain: Promise<void> = Promise.resolve();

/** Seal and send a frame; peerId 0 broadcasts, N targets that guest. */
function sendFrame(frame: HostFrame, targetPeer = 0): void {
	sendChain = sendChain
		.then(async () => {
			if (ws.readyState !== WebSocket.OPEN) return;
			const sealed = await seal(key, frame);
			ws.send(packEnvelope(targetPeer, sealed));
		})
		.catch((err: unknown) => {
			console.error("mock-host: send failed:", err);
		});
}

function buildState(): SessionState {
	const participants: SessionState["participants"] = [{ name: hostName, role: "host" }];
	for (const peer of peers.values()) {
		participants.push({ name: peer.name, role: "guest", readOnly: peer.canWrite ? undefined : true });
	}
	const tokens = 51_000 + entries.length * 120;
	return {
		isStreaming: streaming,
		queuedMessageCount: queuedPrompts,
		sessionName: header.title,
		cwd: header.cwd,
		model,
		thinkingLevel: scenario ? "high" : "medium",
		contextUsage: {
			tokens,
			contextWindow: model.contextWindow,
			percent: model.contextWindow !== null && model.contextWindow > 0 ? (tokens / model.contextWindow) * 100 : null,
		},
		participants,
	};
}

function broadcastState(): void {
	sendFrame({ t: "state", state: buildState() });
}

function appendEntry(entry: SessionEntry): void {
	entries.push(entry);
	lastEntryId = entry.id;
	sendFrame({ t: "entry", entry });
}

function notice(level: "info" | "warning" | "error", message: string): void {
	sendFrame({ t: "event", event: { type: "notice", level, message, source: "collab" } });
}

// ── scripted turn replay ─────────────────────────────────────────────────────

function startReplay(): void {
	turnSeq++;
	replayQueue = scenario ? scenario.makeTurn(turnSeq, lastEntryId) : makeScriptedTurn(turnSeq, lastEntryId);
	scheduleStep();
}

function scheduleStep(): void {
	replayTimer = setTimeout(() => {
		replayTimer = null;
		const step = replayQueue.shift();
		if (step) applyStep(step);
		if (replayQueue.length > 0) {
			scheduleStep();
			return;
		}
		if (queuedPrompts > 0) {
			queuedPrompts--;
			startReplay();
		}
	}, stepMs);
}

function applyStep(step: ScriptedStep): void {
	switch (step.kind) {
		case "event":
			sendFrame({ t: "event", event: step.event });
			break;
		case "entry":
			appendEntry(step.entry);
			break;
		case "state":
			streaming = step.streaming;
			broadcastState();
			break;
	}
}

function cancelReplay(): void {
	if (replayTimer !== null) {
		clearTimeout(replayTimer);
		replayTimer = null;
	}
	replayQueue = [];
}

// ── guest frame handling ─────────────────────────────────────────────────────

function peerName(fromPeer: number): string {
	return peers.get(fromPeer)?.name ?? `guest-${fromPeer}`;
}

const ASK_SELECT: CollabUiRequestDraft = {
	kind: "select",
	title: "apps/collab-relay is not in main. How should the README list it?",
	options: [
		{
			label: "Add it marked as planned",
			description: "apps/collab-relay/  relay for watching or steering a run (planned)",
		},
		{ label: "Add it exactly as asked", description: "The Layout will name a folder nobody can find" },
		{ label: "Leave it out until it exists" },
	],
	selectionMarker: "radio",
};
const ASK_TEXT: CollabUiRequestDraft = {
	kind: "editor",
	title: "What should the Development note say about npm run check?",
	prefill: "npm run check runs typecheck, lint:arch, validate:config and the tests.",
};

function canWrite(fromPeer: number): boolean {
	return peers.get(fromPeer)?.canWrite === true;
}

function handleHello(name: string, proto: number, fromPeer: number, token: string | undefined): void {
	if (proto !== COLLAB_PROTO) {
		sendFrame(
			{ t: "error", message: `protocol mismatch: host speaks v${COLLAB_PROTO}, guest sent v${proto}` },
			fromPeer,
		);
		return;
	}
	const cleanName = name.trim().slice(0, 64) || `guest-${fromPeer}`;
	const writable = token !== undefined && token === writeTokenText;
	peers.set(fromPeer, { name: cleanName, canWrite: writable });
	sendFrame(
		{
			t: "welcome",
			proto: COLLAB_PROTO,
			header,
			state: buildState(),
			agents: agents.map(agent => ({ ...agent })),
			entryCount: entries.length,
			readOnly: writable ? undefined : true,
		},
		fromPeer,
	);
	sendFrame({ t: "snapshot-chunk", entries: [...entries], final: true }, fromPeer);
	console.log(`mock-host: ${cleanName} joined (peer ${fromPeer}${writable ? "" : ", view only"})`);
	notice("info", `${cleanName} joined${writable ? "" : " to watch"}`);
	broadcastState();
	if (autoplay && !autoplayed) {
		autoplayed = true;
		setTimeout(() => {
			if (scenario?.pendingPrompt) appendEntry({ ...scenario.pendingPrompt, parentId: lastEntryId });
			startReplay();
		}, 1_500);
	}
}

function askQuestion(draft: CollabUiRequestDraft): void {
	uiReqSeq++;
	sendFrame({ t: "ui-request", request: { ...draft, reqId: uiReqSeq } });
}

function handlePrompt(text: string, fromPeer: number): void {
	if (!canWrite(fromPeer)) return;
	const command = text.trim();
	if (command === "/ask") return askQuestion(ASK_SELECT);
	if (command === "/ask text") return askQuestion(ASK_TEXT);
	if (command === "/end") {
		sendFrame({ t: "bye", reason: "the run finished" }, fromPeer);
		return;
	}
	liveEntrySeq++;
	appendEntry({
		id: `live-${liveEntrySeq}`,
		parentId: lastEntryId,
		timestamp: new Date().toISOString(),
		type: "custom_message",
		customType: "collab-prompt",
		content: text,
		details: { from: peerName(fromPeer) },
		display: true,
	});
	if (replayTimer !== null || replayQueue.length > 0) {
		queuedPrompts++;
		broadcastState();
		return;
	}
	startReplay();
}

function handleUiResponse(reqId: number, value: string | undefined, fromPeer: number): void {
	if (!canWrite(fromPeer)) return;
	sendFrame({ t: "ui-request-end", reqId });
	notice(
		"info",
		value === undefined ? `${peerName(fromPeer)} skipped the question` : `${peerName(fromPeer)} answered: ${value}`,
	);
}

function handleAbort(fromPeer: number): void {
	if (!canWrite(fromPeer)) return;
	const wasReplaying = replayTimer !== null || replayQueue.length > 0;
	cancelReplay();
	queuedPrompts = 0;
	notice("info", `${peerName(fromPeer)} interrupted`);
	if (wasReplaying) sendFrame({ t: "event", event: { type: "agent_end" } });
	streaming = false;
	broadcastState();
}

function handleAgentCmd(cmd: string, agentId: string, fromPeer: number): void {
	notice("info", `${peerName(fromPeer)} sent agent-cmd ${cmd} → ${agentId}`);
}

function handleFetchTranscript(reqId: number, fromByte: number, fromPeer: number): void {
	const total = transcriptBytes.byteLength;
	const start = Math.max(0, Math.min(fromByte, total));
	const text = start >= total ? "" : transcriptDecoder.decode(transcriptBytes.subarray(start));
	// We always serve to EOF, so the next offset base is the full size.
	sendFrame({ t: "transcript", reqId, text, newSize: total }, fromPeer);
}

function handleFrame(frame: WireFrame, fromPeer: number): void {
	switch (frame.t) {
		case "hello":
			handleHello(frame.name, frame.proto, fromPeer, frame.writeToken);
			break;
		case "ui-response":
			handleUiResponse(frame.reqId, frame.value, fromPeer);
			break;
		case "prompt":
			handlePrompt(frame.text, fromPeer);
			break;
		case "abort":
			handleAbort(fromPeer);
			break;
		case "agent-cmd":
			handleAgentCmd(frame.cmd, frame.agentId, fromPeer);
			break;
		case "fetch-transcript":
			handleFetchTranscript(frame.reqId, frame.fromByte, fromPeer);
			break;
		default:
			// Host-frame echoes or unknown types: ignore.
			break;
	}
}

function handleControl(text: string): void {
	let msg: unknown;
	try {
		msg = JSON.parse(text);
	} catch {
		return;
	}
	if (typeof msg !== "object" || msg === null) return;
	const control = msg as { t?: unknown; peer?: unknown };
	if (control.t === "peer-left" && typeof control.peer === "number") {
		const name = peers.get(control.peer)?.name;
		peers.delete(control.peer);
		if (name) console.log(`mock-host: ${name} left (peer ${control.peer})`);
		broadcastState();
	}
}

ws.onopen = () => {
	console.log("mock collab host ready");
	console.log(`join link: ${link}`);
	console.log(`view link: ${viewLink}`);
	console.log("paste the link into the collab-web connect screen (bun ./index.html), Ctrl+C stops the host");
};

ws.onmessage = event => {
	const data: unknown = event.data;
	if (typeof data === "string") {
		handleControl(data);
		return;
	}
	if (!(data instanceof ArrayBuffer)) return;
	const envelope = unpackEnvelope(new Uint8Array(data));
	if (!envelope) return;
	recvChain = recvChain
		.then(async () => {
			const frame = await open(key, envelope.payload);
			handleFrame(frame, envelope.peerId);
		})
		.catch((err: unknown) => {
			console.error("mock-host: dropping undecryptable frame:", err);
		});
};

ws.onclose = event => {
	if (shuttingDown) return;
	console.error(`mock-host: relay socket closed (${event.code} ${event.reason || "no reason"})`);
	shutdown(1);
};

// ── progress ticker ──────────────────────────────────────────────────────────

const tickInterval: Timer = setInterval(() => {
	tick++;
	// The real Oz session ran no subagents; only the fixture ticks one.
	if (!scenario) sendFrame({ t: "bus", channel: "task:subagent:progress", data: makeProbeProgress(tick) });
	const now = Date.now();
	for (const agent of agents) {
		if (agent.status === "running") agent.lastActivity = now;
	}
	if (tick % AGENTS_SNAPSHOT_EVERY === 0) {
		sendFrame({ t: "agents", agents: agents.map(agent => ({ ...agent })) });
	}
}, TICK_INTERVAL_MS);

// ── shutdown ─────────────────────────────────────────────────────────────────

function shutdown(code: number): void {
	if (shuttingDown) return;
	shuttingDown = true;
	cancelReplay();
	clearInterval(tickInterval);
	sendFrame({ t: "bye", reason: "mock host shutting down" });
	// Let the bye flush through the send chain before tearing the room down.
	void sendChain.finally(() => {
		try {
			ws.close(1000);
		} catch {
			// already closing
		}
		relay.stop();
		process.exit(code);
	});
}

process.on("SIGINT", () => {
	console.log("\nmock-host: shutting down");
	shutdown(0);
});

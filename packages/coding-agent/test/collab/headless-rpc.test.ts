/**
 * Contract: `--mode rpc` hosts a collab room under `collab.autoStart` and
 * reports it as one `collab_room` frame on the RPC stdout stream; a control
 * guest's prompt runs a turn in the RPC session; stdin EOF stops the room
 * (guests get `bye`) before the process exits. Real `runRpcMode` in a child
 * process, real local relay, real WebSockets; only the model is scripted.
 */
import { afterEach, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { COLLAB_PROTO, parseCollabLink } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import { removeWithRetries, withTimeout } from "@oh-my-pi/pi-utils";
import { type LocalRelay, startLocalRelay } from "../../../collab-web/scripts/local-relay";

let relay: LocalRelay | undefined;
let directory: string | undefined;
let child: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined;

afterEach(async () => {
	child?.kill();
	child = undefined;
	relay?.stop();
	relay = undefined;
	if (directory) await removeWithRetries(directory);
	directory = undefined;
});

it("hosts in rpc mode, runs a guest prompt, and says goodbye on stdin EOF", async () => {
	relay = startLocalRelay();
	directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-collab-rpc-"));
	const linkFile = path.join(directory, "link.json");
	child = Bun.spawn([process.execPath, path.join(import.meta.dir, "..", "fixtures", "collab-rpc-agent.ts")], {
		cwd: directory,
		env: {
			...Bun.env,
			PI_CODING_AGENT_DIR: directory,
			HOME: directory,
			PI_NO_TITLE: "1",
			TEST_COLLAB_RELAY_URL: relay.url,
			OMP_COLLAB_LINK_FILE: linkFile,
		},
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	const frames: Record<string, unknown>[] = [];
	const waiters: {
		match: (frame: Record<string, unknown>) => boolean;
		resolve: (frame: Record<string, unknown>) => void;
	}[] = [];
	const waitFor = (match: (frame: Record<string, unknown>) => boolean, label: string) => {
		const seen = frames.find(match);
		if (seen) return Promise.resolve(seen);
		const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>();
		waiters.push({ match, resolve });
		return withTimeout(promise, 15_000, `timed out waiting for ${label}`);
	};
	void (async () => {
		let buffer = "";
		const decoder = new TextDecoder();
		for await (const chunk of child!.stdout) {
			buffer += decoder.decode(chunk, { stream: true });
			let newline = buffer.indexOf("\n");
			while (newline >= 0) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				newline = buffer.indexOf("\n");
				let frame: Record<string, unknown>;
				try {
					frame = JSON.parse(line) as Record<string, unknown>;
				} catch {
					continue;
				}
				frames.push(frame);
				for (const waiter of waiters.splice(0)) {
					if (waiter.match(frame)) waiter.resolve(frame);
					else waiters.push(waiter);
				}
			}
		}
	})();
	const stderr = new Response(child.stderr).text();

	const room = (await waitFor(frame => frame.type === "collab_room", "collab_room")) as {
		webLink: string;
		roomId: string;
		controlSecret: string;
	};
	expect(JSON.parse(await fs.readFile(linkFile, "utf8"))).toEqual(room);

	const parsed = parseCollabLink(room.webLink);
	if ("error" in parsed) throw new Error(parsed.error);
	const socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key: await importRoomKey(parsed.key) });
	const welcomed = Promise.withResolvers<void>();
	const bye = Promise.withResolvers<void>();
	socket.onFrame = frame => {
		if (frame.t === "welcome") welcomed.resolve();
		if (frame.t === "bye") bye.resolve();
	};
	socket.onOpen = () =>
		socket.send({
			t: "hello",
			proto: COLLAB_PROTO,
			name: "rpc-guest",
			writeToken: Buffer.from(parsed.writeToken!).toString("base64url"),
		});
	socket.connect();
	try {
		await withTimeout(welcomed.promise, 10_000, "guest was not welcomed");
		socket.send({ t: "prompt", text: "from the guest" });
		await waitFor(
			frame =>
				frame.type === "message_end" &&
				JSON.stringify(frame).includes("echo:") &&
				JSON.stringify(frame).includes("from the guest"),
			"the guest prompt's answer",
		);

		child.stdin.end();
		await withTimeout(bye.promise, 10_000, "guest got no goodbye");
		expect(await withTimeout(child.exited, 10_000, "rpc process did not exit")).toBe(0);
	} finally {
		socket.close();
	}
	expect(frames.filter(frame => frame.type === "collab_room")).toHaveLength(1);
	await expect(fs.stat(linkFile)).rejects.toThrow();
	const errText = await stderr;
	expect(errText).not.toContain(room.roomId);
	expect(errText).not.toContain(room.controlSecret);
}, 40_000);

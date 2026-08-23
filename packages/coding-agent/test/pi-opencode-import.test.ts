import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { persistForeignSession } from "../src/session/foreign-session-import";
import type { ForeignSessionInfo } from "../src/session/foreign-session-store";
import { OpenCodeSessionStore } from "../src/session/opencode-session-store";
import { decodePiSessionDirName, PiSessionStore } from "../src/session/pi-session-store";
import { buildSessionContext } from "../src/session/session-context";
import { SessionManager } from "../src/session/session-manager";
import { FileSessionStorage } from "../src/session/session-storage";

let tempRoot: string;

beforeEach(async () => {
	tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-pi-opencode-import-"));
});

afterEach(async () => {
	await fs.rm(tempRoot, { recursive: true, force: true });
});

async function writeJsonl(filePath: string, records: Record<string, unknown>[]): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await Bun.write(filePath, `${records.map(record => JSON.stringify(record)).join("\n")}\n`);
}

describe("PiSessionStore", () => {
	it("lists sessions from project buckets and decodes the bucket cwd", async () => {
		const root = path.join(tempRoot, ".pi", "agent");
		const cwd = path.join(tempRoot, "project");
		const id = "019ed68c-de9d-7460-9121-bbafaa01cb34";
		const encoded = `--${cwd.slice(1).replace(/\//g, "-")}--`;
		await writeJsonl(path.join(root, "sessions", encoded, `2026-06-17T17-06-56-797Z_${id}.jsonl`), [
			{ type: "session", version: 3, id, timestamp: "2026-06-17T17:06:56.797Z", cwd },
			{
				type: "message",
				id: "b14484f8",
				parentId: null,
				timestamp: "2026-06-17T17:21:12.963Z",
				message: {
					role: "user",
					content: [{ type: "text", text: "Find last work" }],
					timestamp: 1_781_741_000_000,
				},
			},
		]);

		const sessions = await new PiSessionStore(root).list();

		expect(sessions).toHaveLength(1);
		expect(sessions[0]?.id).toBe(id);
		expect(sessions[0]?.cwd).toBe(cwd);
		expect(sessions[0]?.created.toISOString()).toBe("2026-06-17T17:06:56.797Z");
	});

	it("prefers the header cwd over the decoded bucket name and falls back to process.cwd()", async () => {
		const root = path.join(tempRoot, ".pi", "agent");
		const realDir = await fs.mkdtemp(path.join(tempRoot, "real-"));
		const headerCwd = path.join(tempRoot, "header-cwd");
		const fileA = path.join(root, "sessions", `--${path.basename(realDir)}--`, "a.jsonl");
		await writeJsonl(fileA, [
			{ type: "session", version: 3, id: "id-a", timestamp: "2026-01-01T00:00:00.000Z", cwd: headerCwd },
		]);
		// Bucket that decodes to nothing existing on disk.
		const fileB = path.join(root, "sessions", "--nope-nowhere--", "b.jsonl");
		await writeJsonl(fileB, [{ type: "session", version: 3, id: "id-b" }]);

		const sessions = await new PiSessionStore(root).list();

		const byFile = new Map(sessions.map(session => [session.path, session]));
		expect(byFile.get(fileA)?.cwd).toBe(headerCwd);
		expect(byFile.get(fileB)?.cwd).toBe(process.cwd());
	});

	it("converts messages, model changes, thinking levels, and compaction into OMP entries", async () => {
		const root = path.join(tempRoot, ".pi", "agent");
		const cwd = path.join(tempRoot, "convert-project");
		const sessionPath = path.join(root, "sessions", "--x--", "s.jsonl");
		await writeJsonl(sessionPath, [
			{ type: "session", version: 3, id: "sess-1", timestamp: "2026-06-17T17:06:56.797Z", cwd },
			{
				type: "model_change",
				id: "m1",
				parentId: null,
				timestamp: "2026-06-17T17:06:57.559Z",
				provider: "umans",
				modelId: "umans-kimi-k2.6",
			},
			{
				type: "thinking_level_change",
				id: "t1",
				parentId: "m1",
				timestamp: "2026-06-17T17:06:57.560Z",
				thinkingLevel: "high",
			},
			{
				type: "message",
				id: "u1",
				parentId: "t1",
				timestamp: "2026-06-17T17:07:00.000Z",
				message: { role: "user", content: "hello", timestamp: 1_781_741_000_000 },
			},
			{
				type: "message",
				id: "a1",
				parentId: "u1",
				timestamp: "2026-06-17T17:07:02.000Z",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "hi there" }],
					api: "openai-completions",
					provider: "umans",
					model: "umans-kimi-k2.6",
					usage: {
						input: 1,
						output: 2,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 3,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: 1_781_741_000_000,
				},
			},
			{
				type: "compaction",
				id: "c1",
				parentId: "a1",
				timestamp: "2026-06-17T17:08:00.000Z",
				summary: "Earlier context summarized.",
			},
			{
				type: "message",
				id: "u2",
				parentId: "c1",
				timestamp: "2026-06-17T17:09:00.000Z",
				message: { role: "user", content: "continue", timestamp: 1_781_742_000_000 },
			},
			{ type: "session_info", id: "drop-me", parentId: "u2", timestamp: "2026-06-17T17:09:01.000Z", payload: {} },
		]);
		const store = new PiSessionStore(root);
		const info: ForeignSessionInfo = (await store.list())[0];

		const manager = await store.load(info);

		expect(manager.getSessionFile()).toBeUndefined();
		const entries = manager.getEntries();
		expect(entries.map(entry => entry.type)).toEqual([
			"model_change",
			"thinking_level_change",
			"message",
			"message",
			"compaction",
			"message",
		]);
		expect(entries.some(entry => entry.type === "model_change" && entry.model === "umans/umans-kimi-k2.6")).toBe(
			true,
		);
		const activeContext = buildSessionContext(entries);
		expect(activeContext.messages.map(message => message.role)).toEqual(["compactionSummary", "user"]);
		expect(activeContext.messages[1]).toMatchObject({ role: "user", content: "continue" });
	});

	it("rejects loading a foreign info object from another source", async () => {
		const store = new PiSessionStore(tempRoot);
		await expect(
			store.load({
				source: "claude",
				id: "x",
				path: "/dev/null",
				cwd: tempRoot,
				created: new Date(),
				modified: new Date(),
			}),
		).rejects.toThrow(/Cannot load/);
	});
});

describe("decodePiSessionDirName", () => {
	it("returns undefined for names without an encoded path or existing target", async () => {
		expect(await decodePiSessionDirName("plain-name")).toBeUndefined();
		expect(await decodePiSessionDirName("--no-such-dir-anywhere--")).toBeUndefined();
	});

	it("decodes single-segment buckets to filesystem roots and multi-segment buckets by split points", async () => {
		const realDir = await fs.mkdtemp(path.join(tempRoot, "decode-"));
		const encoded = `--${realDir.slice(1).replaceAll("/", "-")}--`;
		expect(await decodePiSessionDirName(encoded)).toBe(realDir);
		if (process.platform !== "win32") {
			expect(await decodePiSessionDirName("--root--")).toBe("/root");
		}
	});
});

describe("OpenCodeSessionStore", () => {
	interface FixtureDatabase {
		path: string;
		addSession: (session: { id: string; directory: string; title: string; created: number; updated: number }) => void;
		addMessage: (row: { id: string; sessionId: string; timeCreated: number; data: Record<string, unknown> }) => void;
		addPart: (row: {
			id: string;
			messageId: string;
			sessionId: string;
			timeCreated: number;
			data: Record<string, unknown>;
		}) => void;
		close: () => void;
	}

	async function createFixtureDatabase(): Promise<FixtureDatabase> {
		const dataDir = path.join(tempRoot, "opencode-data");
		await fs.mkdir(dataDir, { recursive: true });
		const databasePath = path.join(dataDir, "opencode.db");
		const database = new Database(databasePath);
		database.exec(
			"CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT NOT NULL, title TEXT NOT NULL, slug TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL)",
		);
		database.exec(
			"CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)",
		);
		database.exec(
			"CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)",
		);
		return {
			path: databasePath,
			addSession({ id, directory, title, created, updated }) {
				database.run("INSERT INTO session VALUES (?1, ?2, ?3, ?4, ?5, ?6)", [
					id,
					directory,
					title,
					title,
					created,
					updated,
				]);
			},
			addMessage({ id, sessionId, timeCreated, data }) {
				database.run("INSERT INTO message VALUES (?1, ?2, ?3, ?4, ?5)", [
					id,
					sessionId,
					timeCreated,
					timeCreated,
					JSON.stringify(data),
				]);
			},
			addPart({ id, messageId, sessionId, timeCreated, data }) {
				database.run("INSERT INTO part VALUES (?1, ?2, ?3, ?4, ?5, ?6)", [
					id,
					messageId,
					sessionId,
					timeCreated,
					timeCreated,
					JSON.stringify(data),
				]);
			},
			close() {
				database.close();
			},
		};
	}

	function createInfo(databasePath: string, sessionId: string): ForeignSessionInfo {
		return {
			source: "opencode",
			id: sessionId,
			path: `${databasePath}#${sessionId}`,
			cwd: tempRoot,
			title: "OpenCode fixture",
			created: new Date(1_787_430_347_000),
			modified: new Date(1_787_479_458_000),
		};
	}

	it("lists indexed sessions without opening transcripts", async () => {
		const database = await createFixtureDatabase();
		try {
			database.addSession({
				id: "ses_a",
				directory: "/tmp/proj",
				title: "Indexed session",
				created: 1_787_430_000_000,
				updated: 1_787_479_400_000,
			});
			const sessions = await new OpenCodeSessionStore(path.dirname(database.path)).list();

			expect(sessions).toHaveLength(1);
			expect(sessions[0]).toMatchObject({ id: "ses_a", cwd: "/tmp/proj", title: "Indexed session" });
		} finally {
			database.close();
		}
	});

	it("converts user parts, reasoning, tool calls with results, and model changes", async () => {
		const database = await createFixtureDatabase();
		try {
			const sessionId = "ses_full";
			database.addSession({
				id: sessionId,
				directory: "/tmp/full",
				title: "Full session",
				created: 1_787_430_347_000,
				updated: 1_787_430_400_000,
			});
			const userId = "msg_user";
			const assistantOne = "msg_assistant_one";
			const assistantTwo = "msg_assistant_two";
			database.addMessage({ id: userId, sessionId, timeCreated: 1_787_430_347_100, data: { role: "user" } });
			database.addMessage({
				id: assistantOne,
				sessionId,
				timeCreated: 1_787_430_347_200,
				data: {
					role: "assistant",
					providerID: "umans",
					modelID: "openrouter/stealth/ox-alpha",
					tokens: { total: 100, input: 40, output: 30, reasoning: 10, cache: { read: 20, write: 0 } },
				},
			});
			database.addMessage({
				id: assistantTwo,
				sessionId,
				timeCreated: 1_787_430_347_300,
				data: {
					role: "assistant",
					providerID: "umans",
					modelID: "openrouter/stealth/ox-alpha",
					tokens: { total: 50, input: 20, output: 25, reasoning: 5, cache: { read: 0, write: 0 } },
					time: { completed: 1_787_430_349_000 },
				},
			});
			database.addPart({
				id: "p1",
				messageId: userId,
				sessionId,
				timeCreated: 1_787_430_347_110,
				data: { type: "text", text: "look at this" },
			});
			database.addPart({
				id: "p2",
				messageId: assistantOne,
				sessionId,
				timeCreated: 1_787_430_347_210,
				data: { type: "reasoning", text: "Thinking about the task." },
			});
			database.addPart({
				id: "p3",
				messageId: assistantOne,
				sessionId,
				timeCreated: 1_787_430_347_220,
				data: {
					type: "tool",
					tool: "bash",
					callID: "call-1",
					state: { status: "completed", input: { command: "ls" }, output: "file.ts\n" },
				},
			});
			database.addPart({
				id: "p4",
				messageId: assistantTwo,
				sessionId,
				timeCreated: 1_787_430_347_310,
				data: { type: "text", text: "All done." },
			});
			database.addPart({
				id: "p5",
				messageId: assistantTwo,
				sessionId,
				timeCreated: 1_787_430_347_320,
				data: { type: "step-finish", reason: "tool-calls" },
			});

			const manager = await new OpenCodeSessionStore(path.dirname(database.path)).load(
				createInfo(database.path, sessionId),
			);

			const entries = manager.getEntries();
			expect(entries.filter(entry => entry.type === "model_change")).toHaveLength(1);
			const messages = entries
				.filter(entry => entry.type === "message")
				.map(entry => entry.type === "message" && entry.message);
			expect(
				messages.map(message =>
					typeof message === "object" && message !== null && "role" in message ? message.role : "?",
				),
			).toEqual(["user", "assistant", "toolResult", "assistant"]);
			const transcript = buildSessionContext(entries);
			expect(transcript.messages.map(message => message.role)).toEqual([
				"user",
				"assistant",
				"toolResult",
				"assistant",
			]);
			let call: { id?: unknown; name?: unknown; arguments?: unknown } | undefined;
			for (const entry of entries) {
				if (entry.type !== "message" || entry.message.role !== "assistant") continue;
				const found = entry.message.content.find(block => block.type === "toolCall");
				if (found && found.type === "toolCall") call = found;
			}
			expect(call).toMatchObject({ id: "call-1", name: "bash" });
			const result = entries.find(entry => entry.type === "message" && entry.message.role === "toolResult");
			if (result?.type !== "message" || result.message.role !== "toolResult")
				throw new Error("Missing imported tool result");
			expect(result.message.content).toEqual([{ type: "text", text: "file.ts\n" }]);
			expect(result.message.isError).toBe(false);
			expect(manager.getSessionName()).toBe("OpenCode fixture");
		} finally {
			database.close();
		}
	});

	it("synthesizes error results for interrupted tool calls and preserves error status", async () => {
		const database = await createFixtureDatabase();
		try {
			const sessionId = "ses_interrupted";
			database.addSession({
				id: sessionId,
				directory: "/tmp/interrupted",
				title: "Interrupted",
				created: 1_787_430_000_000,
				updated: 1_787_430_100_000,
			});
			const assistantId = "msg_err";
			database.addMessage({
				id: assistantId,
				sessionId,
				timeCreated: 1_787_430_050_000,
				data: { role: "assistant", providerID: "umans", modelID: "m", tokens: null },
			});
			database.addPart({
				id: "pe1",
				messageId: assistantId,
				sessionId,
				timeCreated: 1_787_430_050_100,
				data: {
					type: "tool",
					tool: "bash",
					callID: "call-dead",
					state: { status: "running", input: { command: "sleep 999" } },
				},
			});

			const manager = await new OpenCodeSessionStore(path.dirname(database.path)).load(
				createInfo(database.path, sessionId),
			);

			const entries = manager.getEntries();
			const result = entries.find(entry => entry.type === "message" && entry.message.role === "toolResult");
			if (result?.type !== "message" || result.message.role !== "toolResult")
				throw new Error("Missing synthetic tool result");
			expect(result.message.isError).toBe(true);
			expect(result.message.toolCallId).toBe("call-dead");
		} finally {
			database.close();
		}
	});
});

describe("foreign session persistence (pi + opencode sources)", () => {
	it("persists a Pi import under a fresh OMP identity with provenance", async () => {
		const root = path.join(tempRoot, ".pi", "agent");
		const cwd = path.join(tempRoot, "persist-project");
		const sessionPath = path.join(root, "sessions", "--p--", "persist.jsonl");
		await writeJsonl(sessionPath, [
			{ type: "session", version: 3, id: "persist-1", timestamp: "2026-06-17T17:06:56.797Z", cwd },
			{
				type: "message",
				id: "u1",
				parentId: null,
				timestamp: "2026-06-17T17:07:00.000Z",
				message: { role: "user", content: "carry this over", timestamp: 1_781_741_000_000 },
			},
		]);
		const store = new PiSessionStore(root);
		const info = (await store.list())[0];
		if (!info) throw new Error("Pi fixture was not listed");

		const persisted = await persistForeignSession(store, info, {
			sessionDir: path.join(tempRoot, "omp-sessions"),
			suppressBreadcrumb: true,
		});
		const sessionFile = persisted.getSessionFile();
		if (!sessionFile) throw new Error("Imported session was not persisted");
		await persisted.close();

		const reopened = await SessionManager.open(
			sessionFile,
			path.join(tempRoot, "omp-sessions"),
			new FileSessionStorage(),
			{
				suppressBreadcrumb: true,
			},
		);
		try {
			expect(reopened.getSessionId()).not.toBe(info.id);
			const provenance = reopened
				.getEntries()
				.find(entry => entry.type === "custom" && entry.customType === "foreign_session_import");
			expect(provenance).toMatchObject({
				data: { source: "pi", sourceId: info.id, sourcePath: info.path, sourceCwd: info.cwd },
			});
		} finally {
			await reopened.close();
		}
	});

	it("persists an OpenCode import with provenance and a usable transcript", async () => {
		const database = await createPersistFixture();
		try {
			const sessionId = "ses_persist";
			database.addSession({
				id: sessionId,
				directory: tempRoot,
				title: "Persist me",
				created: 1_787_430_000_000,
				updated: 1_787_430_200_000,
			});
			database.addMessage({ id: "mu", sessionId, timeCreated: 1_787_430_010_000, data: { role: "user" } });
			database.addMessage({
				id: "ma",
				sessionId,
				timeCreated: 1_787_430_020_000,
				data: {
					role: "assistant",
					providerID: "umans",
					modelID: "openrouter/stealth/ox-alpha",
					tokens: { total: 10, input: 5, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
				},
			});
			database.addPart({
				id: "pp1",
				messageId: "mu",
				sessionId,
				timeCreated: 1_787_430_010_100,
				data: { type: "text", text: "import this session" },
			});
			database.addPart({
				id: "pp2",
				messageId: "ma",
				sessionId,
				timeCreated: 1_787_430_020_100,
				data: { type: "text", text: "Done importing." },
			});
			const store = new OpenCodeSessionStore(path.dirname(database.path));
			const info = (await store.list())[0];
			if (!info) throw new Error("OpenCode fixture was not listed");

			const persisted = await persistForeignSession(store, info, {
				sessionDir: path.join(tempRoot, "omp-sessions"),
				suppressBreadcrumb: true,
			});
			const sessionFile = persisted.getSessionFile();
			if (!sessionFile) throw new Error("Imported session was not persisted");
			await persisted.close();

			const reopened = await SessionManager.open(
				sessionFile,
				path.join(tempRoot, "omp-sessions"),
				new FileSessionStorage(),
				{
					suppressBreadcrumb: true,
				},
			);
			try {
				const provenance = reopened
					.getEntries()
					.find(entry => entry.type === "custom" && entry.customType === "foreign_session_import");
				expect(provenance).toMatchObject({ data: { source: "opencode", sourceId: sessionId } });
				const context = buildSessionContext(reopened.getEntries());
				expect(context.messages.some(message => message.role === "user")).toBe(true);
			} finally {
				await reopened.close();
			}
		} finally {
			database.close();
		}
	});

	async function createPersistFixture() {
		const dataDir = path.join(tempRoot, "opencode-data-persist");
		await fs.mkdir(dataDir, { recursive: true });
		const databasePath = path.join(dataDir, "opencode.db");
		const database = new Database(databasePath);
		database.exec(
			"CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT NOT NULL, title TEXT NOT NULL, slug TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL)",
		);
		database.exec(
			"CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)",
		);
		database.exec(
			"CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)",
		);
		return {
			path: databasePath,
			addSession(session: { id: string; directory: string; title: string; created: number; updated: number }) {
				database.run("INSERT INTO session VALUES (?1, ?2, ?3, ?4, ?5, ?6)", [
					session.id,
					session.directory,
					session.title,
					session.title,
					session.created,
					session.updated,
				]);
			},
			addMessage(row: { id: string; sessionId: string; timeCreated: number; data: Record<string, unknown> }) {
				database.run("INSERT INTO message VALUES (?1, ?2, ?3, ?4, ?5)", [
					row.id,
					row.sessionId,
					row.timeCreated,
					row.timeCreated,
					JSON.stringify(row.data),
				]);
			},
			addPart(row: {
				id: string;
				messageId: string;
				sessionId: string;
				timeCreated: number;
				data: Record<string, unknown>;
			}) {
				database.run("INSERT INTO part VALUES (?1, ?2, ?3, ?4, ?5, ?6)", [
					row.id,
					row.messageId,
					row.sessionId,
					row.timeCreated,
					row.timeCreated,
					JSON.stringify(row.data),
				]);
			},
			close() {
				database.close();
			},
		};
	}
});

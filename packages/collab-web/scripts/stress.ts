/**
 * Stress entries for the mock host (`--stress`): the shapes that break
 * layouts. A 2,000-line edit diff, a 3,000-line command output and a
 * 200-character file path, appended after whichever scenario is loaded.
 * The content is generated from a real file layout, not lorem ipsum.
 */
import type { SessionEntry } from "@oh-my-pi/pi-wire";

const LONG_PATH =
	"packages/adapters/src/integrations/slack/recordings/transcoders/webm-to-mp4/fallbacks/ffmpeg-wasm/workers/pool/scheduler/backpressure/strategies/adaptive-window-with-jitter-and-retry-budget.ts";

function bigDiff(): string {
	const rows: string[] = [];
	let line = 1;
	for (let block = 0; block < 100; block++) {
		for (let i = 0; i < 4; i++) rows.push(` ${line + i}|\tconst window${block}_${i} = budget.next(${i});`);
		rows.push(`-${line + 4}|\tif (attempt > MAX_RETRIES) throw new RetryBudgetExceeded(attempt);`);
		for (let i = 0; i < 12; i++)
			rows.push(
				`+${line + 4 + i}|\tif (attempt > budget.limit(${block}, ${i})) return backoff.schedule(window${block}_${i % 4});`,
			);
		for (let i = 0; i < 3; i++) rows.push(` ${line + 16 + i}|\t// window ${block}: jitter ${i * 17}ms`);
		rows.push("");
		line += 40;
	}
	return rows.join("\n");
}

function bigOutput(): string {
	const rows: string[] = [];
	for (let i = 1; i <= 3000; i++) {
		const file = `apps/worker/src/routing/case-${String(i % 211).padStart(3, "0")}.test.ts`;
		rows.push(
			i % 97 === 0
				? ` ✗ ${file} > retries a dropped frame (${i % 40}ms)`
				: ` ✓ ${file} > routes message ${i} (${i % 13}ms)`,
		);
	}
	rows.push(" Test Files  211 passed (211)", "      Tests  2969 passed | 31 failed (3000)");
	return rows.join("\n");
}

export function stressEntries(parentId: string | null): SessionEntry[] {
	const t = Date.now() - 60_000;
	const iso = (ms: number): string => new Date(ms).toISOString();
	const callEdit = "stress-edit-01";
	const callBash = "stress-bash-01";
	const callRead = "stress-read-01";
	return [
		{
			id: "stress-a1",
			parentId,
			timestamp: iso(t),
			type: "message",
			message: {
				role: "assistant",
				content: [
					{
						type: "text",
						text: "Rewriting the retry budget across the scheduler, then running the whole routing suite.",
					},
					{
						type: "toolCall",
						id: callRead,
						name: "read",
						arguments: { path: LONG_PATH },
						intent: "Reading the scheduler",
					},
					{
						type: "toolCall",
						id: callEdit,
						name: "edit",
						arguments: { input: `[${LONG_PATH}#9F2C]\nPUT 1.=4000:\n` },
						intent: "Rewriting the retry budget",
					},
					{
						type: "toolCall",
						id: callBash,
						name: "bash",
						arguments: { command: "npx vitest run apps/worker/src/routing" },
						intent: "Running the routing suite",
					},
				],
				model: "oz",
				usage: {
					input: 9_100,
					output: 820,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 9_920,
					cost: { total: 0.041 },
				},
				stopReason: "toolUse",
				timestamp: t,
			},
		},
		{
			id: "stress-r0",
			parentId: "stress-a1",
			timestamp: iso(t + 500),
			type: "message",
			message: {
				role: "toolResult",
				toolCallId: callRead,
				toolName: "read",
				content: [
					{
						type: "text",
						text: "1:export class AdaptiveWindow {\n2:\tconstructor(readonly budget: RetryBudget) {}\n3:}",
					},
				],
				isError: false,
				timestamp: t + 500,
			},
		},
		{
			id: "stress-r1",
			parentId: "stress-r0",
			timestamp: iso(t + 1_000),
			type: "message",
			message: {
				role: "toolResult",
				toolCallId: callEdit,
				toolName: "edit",
				content: [{ type: "text", text: "applied" }],
				details: { diff: bigDiff(), path: LONG_PATH, op: "update", firstChangedLine: 5 },
				isError: false,
				timestamp: t + 1_000,
			},
		},
		{
			id: "stress-r2",
			parentId: "stress-r1",
			timestamp: iso(t + 9_000),
			type: "message",
			message: {
				role: "toolResult",
				toolCallId: callBash,
				toolName: "bash",
				content: [{ type: "text", text: bigOutput() }],
				details: { exitCode: 1, wallTimeMs: 48_200 },
				isError: true,
				timestamp: t + 9_000,
			},
		},
		{
			id: "stress-a2",
			parentId: "stress-r2",
			timestamp: iso(t + 10_000),
			type: "message",
			message: {
				role: "assistant",
				content: [
					{
						type: "text",
						text: "31 of 3,000 routing tests fail after the rewrite, all on dropped-frame retries:\n\n| Suite | Passed | Failed |\n| --- | ---: | ---: |\n| routing | 2,969 | 31 |\n\nThe budget now grows as $b(n) = b_0 \\cdot 2^{n}$, which overshoots the relay's 30 s cap after the fifth retry. Capping it next.",
					},
				],
				model: "oz",
				usage: {
					input: 14_400,
					output: 210,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 14_610,
					cost: { total: 0.06 },
				},
				stopReason: "stop",
				timestamp: t + 10_000,
			},
		},
	];
}

/**
 * Screenshots of one direction against the running mock host (dev only).
 *
 *   bun scripts/shots.ts <direction> [--out <dir>] [--dev http://localhost:4767] [--relay 4766] [--only <moment>]
 *
 * Attaches to the ONE shared headless Chromium on 127.0.0.1:9223 (never
 * launches a browser), opens its own tabs and closes every one of them.
 * For each moment it takes desktop (1280x800) and 390 px shots in light and
 * dark, as ≤800 px wide JPEGs, plus a 1200x750 gallery thumbnail per mode.
 *
 * The mock host must run with `--dev-room --session <oz.jsonl> --stress`.
 * Moments that need host state (a question, the end) are driven through the
 * page itself: the script types `/ask` or `/end` into the composer, exactly
 * as a guest could.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { devLinks } from "../src/dev/dev-room";

function flag(name: string, fallback: string): string {
	const i = Bun.argv.indexOf(name);
	return i >= 0 ? (Bun.argv[i + 1] ?? fallback) : fallback;
}

const id = Bun.argv[2];
if (!id || id.startsWith("--")) {
	console.error("usage: bun scripts/shots.ts <direction> [--out dir] [--only moment]");
	process.exit(1);
}
const devUrl = flag("--dev", "http://localhost:4767");
const relayPort = Number(flag("--relay", "4766"));
const outDir = flag("--out", path.resolve(import.meta.dir, `../../../.superpowers/shots/${id}`));
const only = flag("--only", "");
const links = devLinks(relayPort);

type Mode = "light" | "dark";
type Width = "desktop" | "390";

interface Moment {
	name: string;
	access: "full" | "view";
	preview?: string;
	/** Runs in the page (via puppeteer) after load, before the shot. */
	act?(page: Page): Promise<void>;
	/** Extra wait after load and act. */
	settle?: number;
}

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

/** Types into the direction's composer (any focusable textarea or text input) and presses Enter. */
async function typeIntoComposer(page: Page, text: string): Promise<void> {
	await page.evaluate(() => {
		const opener = document.querySelector<HTMLElement>("[data-shot='open-composer']");
		opener?.click();
	});
	await sleep(400);
	const field = await page.waitForSelector(
		"[data-shot='composer'] textarea:not([disabled]), [data-shot='composer'] input:not([disabled])",
		{ timeout: 6000 },
	);
	await field?.click();
	await page.keyboard.type(text);
	await page.keyboard.press("Enter");
}

async function runHook(page: Page, hook: string): Promise<void> {
	await page.evaluate(h => {
		const els = [...document.querySelectorAll<HTMLElement>(`[data-shot='${h}']`)];
		const el = els[els.length - 1];
		if (!el) return;
		el.click();
		// Bring what opened to the top of its own scroll area (never scroll the page itself).
		requestAnimationFrame(() => {
			let box: HTMLElement | null = el.parentElement;
			while (box && !(box.scrollHeight > box.clientHeight && /auto|scroll/.test(getComputedStyle(box).overflowY)))
				box = box.parentElement;
			if (box) box.scrollTop += el.getBoundingClientRect().top - box.getBoundingClientRect().top - 8;
		});
	}, hook);
}

const MOMENTS: Moment[] = [
	{ name: "joining", access: "full", preview: "waiting", settle: 600 },
	{
		name: "running",
		access: "full",
		settle: 300,
		async act(page) {
			// A fresh session, then the held-back Oz turn replays; the shot lands mid-stream with a tool running.
			await typeIntoComposer(page, "/reset");
			await sleep(400);
			await page.reload({ waitUntil: "domcontentloaded" });
			await page.waitForSelector("[data-shot='ready']", { timeout: 15000 }).catch(() => undefined);
			await sleep(900);
			await typeIntoComposer(page, "Please also add a short Development note about npm run check.");
			await page.waitForSelector("[data-shot='running']", { timeout: 15000 }).catch(() => undefined);
			await sleep(250);
		},
	},
	{
		name: "diff",
		access: "full",
		settle: 400,
		async act(page) {
			await runHook(page, "open-diff");
			await sleep(700);
		},
	},
	{
		name: "ask",
		access: "full",
		settle: 300,
		async act(page) {
			await typeIntoComposer(page, "/ask");
			await page.waitForSelector("[data-shot='ask']", { timeout: 8000 }).catch(() => undefined);
			await sleep(400);
		},
	},
	{ name: "viewonly", access: "view", settle: 900 },
	{
		name: "ended",
		access: "full",
		settle: 300,
		async act(page) {
			await typeIntoComposer(page, "/end");
			await page.waitForSelector("[data-shot='ended']", { timeout: 8000 }).catch(() => undefined);
			await sleep(500);
		},
	},
];

function url(moment: Moment, mode: Mode): string {
	const params = new URLSearchParams({ direction: id!, mode });
	if (moment.preview) params.set("preview", moment.preview);
	return `${devUrl}/?${params.toString()}#${moment.access === "full" ? links.full : links.view}`;
}

async function shoot(browser: Browser, moment: Moment, mode: Mode, width: Width, errors: string[]): Promise<void> {
	const page = await browser.newPage();
	page.on("console", m => {
		if (m.type() === "error") errors.push(`${moment.name}/${mode}/${width}: ${m.text()}`);
	});
	page.on("pageerror", e => errors.push(`${moment.name}/${mode}/${width}: ${String(e)}`));
	try {
		const mobile = width === "390";
		await page.setViewport({
			width: mobile ? 390 : 1280,
			height: mobile ? 844 : 800,
			deviceScaleFactor: 1,
			isMobile: mobile,
			hasTouch: mobile,
		});
		await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: mode }]);
		await page.evaluateOnNewDocument(() => {
			try {
				localStorage.setItem("oz.live.name", "maya");
			} catch {}
		});
		await page.goto(url(moment, mode), { waitUntil: "domcontentloaded", timeout: 30000 });
		await page.waitForSelector("[data-shot='ready']", { timeout: 15000 }).catch(() => undefined);
		await sleep(900);
		if (moment.act) await moment.act(page);
		await sleep(moment.settle ?? 0);
		const file = path.join(outDir, `${id}-${moment.name}-${mode}-${width}.jpg`);
		if (mobile) {
			await page.screenshot({ path: file, type: "jpeg", quality: 70 });
		} else {
			// ≤800 px wide: shrink the 1280 frame through a scaled capture.
			await page.screenshot({
				path: file,
				type: "jpeg",
				quality: 70,
				clip: { x: 0, y: 0, width: 1280, height: 800, scale: 0.625 },
			});
		}
		if (moment.name === "running" && width === "desktop") {
			await page.setViewport({ width: 1200, height: 750, deviceScaleFactor: 1 });
			await sleep(300);
			await page.screenshot({ path: path.join(outDir, `${id}-thumb-${mode}.jpg`), type: "jpeg", quality: 72 });
		}
	} finally {
		await page.close();
	}
}

await fs.mkdir(outDir, { recursive: true });
const browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:9223", defaultViewport: null });
const errors: string[] = [];
try {
	for (const moment of MOMENTS) {
		if (only && moment.name !== only) continue;
		for (const mode of ["light", "dark"] as const) {
			for (const width of ["desktop", "390"] as const) await shoot(browser, moment, mode, width, errors);
		}
	}
} finally {
	browser.disconnect();
}
console.log(
	errors.length === 0
		? `shots: ${outDir} (no console errors)`
		: `shots: ${outDir}\nconsole errors:\n${errors.join("\n")}`,
);

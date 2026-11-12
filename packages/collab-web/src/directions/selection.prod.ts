/**
 * Production twin of `selection.ts`. Exactly one query parameter is read,
 * `look`, which the relay sets when it redirects `/j/<ticket>` to `/`:
 * `base64url(JSON {d, m?})`, where `d` is a user-facing direction id and `m`
 * is `light` or `dark`. The relay checked `d` against the closed set after
 * verifying the ticket's signature; this reads it again and falls back to the
 * default on anything it does not recognise, because a URL can be typed by
 * anybody and a page that threw on a bad one would be a worse failure than
 * showing Paper.
 *
 * The user-facing ids are Oz's (`COLLAB_DIRECTIONS`); two differ from the
 * folder names here: `paper` is the `claude` folder and `thread` is `slack`.
 * That mapping lives in this file alone, so renaming a folder never changes
 * what a stored preference means.
 *
 * Only the query string is read. The URL fragment holds the room key and is
 * the shell's alone; nothing here touches it.
 */
import type { ConnectionPhase } from "../lib/client";
// The `.prod` twin by name, not "./registry": only the production build swaps
// that import, so under `bun test` it would resolve to the dev registry and a
// test could not tell the two apart.
import { DEFAULT_DIRECTION, DIRECTIONS } from "./registry.prod";
import type { CustomerTheme, ThemeMode } from "./theme-seam";
import { OZ_THEME } from "./theme-seam";
import type { Direction } from "./types";

export type PreviewPhase = Exclude<ConnectionPhase, "live">;

export interface Selection {
	direction: Direction;
	mode: ThemeMode | null;
	theme: CustomerTheme;
	preview: PreviewPhase | null;
}

/** The user-facing id whose folder is named differently. Every other id is its folder. */
const FOLDER_OF_LOOK: ReadonlyMap<string, string> = new Map([
	["paper", "claude"],
	["thread", "slack"],
]);

const LOOK_IDS = ["paper", "classic", "chamber", "console", "feed", "studio", "thread"] as const;

/** A Map, not an object: `d: "__proto__"` or `"constructor"` must not find anything. */
const DIRECTION_OF_LOOK: ReadonlyMap<string, Direction> = new Map(
	LOOK_IDS.flatMap(id => {
		const folder = FOLDER_OF_LOOK.get(id) ?? id;
		const direction = DIRECTIONS.find(d => d.id === folder);
		return direction === undefined ? [] : [[id, direction] as const];
	}),
);

const BASE64URL = /^[A-Za-z0-9_-]+$/;
// {"d":"classic","m":"light"} is 27 bytes; a hundred leaves room for a field or two.
const MAX_LOOK_LENGTH = 256;

interface Look {
	direction: Direction | null;
	mode: ThemeMode | null;
}

function readLook(search: string): Look {
	const none: Look = { direction: null, mode: null };
	const raw = new URLSearchParams(search).get("look");
	if (raw === null || raw.length === 0 || raw.length > MAX_LOOK_LENGTH || !BASE64URL.test(raw)) return none;
	let parsed: unknown;
	try {
		const base64 = raw.replaceAll("-", "+").replaceAll("_", "/");
		const bytes = Uint8Array.from(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")), c => c.charCodeAt(0));
		parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch {
		return none;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return none;
	const { d, m } = parsed as { d?: unknown; m?: unknown };
	return {
		direction: typeof d === "string" ? (DIRECTION_OF_LOOK.get(d) ?? null) : null,
		mode: m === "light" || m === "dark" ? m : null,
	};
}

export function readSelection(search: string): Selection {
	const look = readLook(search);
	return {
		direction: look.direction ?? DEFAULT_DIRECTION,
		mode: look.mode,
		theme: OZ_THEME,
		preview: null,
	};
}

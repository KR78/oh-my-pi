/**
 * What the URL query may choose, in dev and gallery builds: the direction
 * (`?direction=`), a forced light/dark mode for the gallery (`?mode=`), a
 * sample customer theme (`?theme=`), and a connection phase to preview
 * (`?preview=`) for states a mock host cannot hold still.
 *
 * Only the query string is read. The URL fragment holds the room key and is
 * the shell's alone; nothing here touches it.
 *
 * The production build swaps this module for `selection.prod.ts`, which
 * ignores the query entirely.
 */
import type { ConnectionPhase } from "../lib/client";
import { DEFAULT_DIRECTION, DIRECTIONS } from "./registry";
import type { CustomerTheme, ThemeMode } from "./theme-seam";
import { OZ_THEME, SAMPLE_THEMES } from "./theme-seam";
import type { Direction } from "./types";

export type PreviewPhase = Exclude<ConnectionPhase, "live">;

export interface Selection {
	direction: Direction;
	mode: ThemeMode | null;
	theme: CustomerTheme;
	preview: PreviewPhase | null;
}

const PREVIEWS: Record<string, PreviewPhase> = {
	connecting: "connecting",
	waiting: "waiting",
	reconnecting: "reconnecting",
	ended: "ended",
};

export function readSelection(search: string): Selection {
	const params = new URLSearchParams(search);
	const id = params.get("direction");
	const mode = params.get("mode");
	return {
		direction: DIRECTIONS.find(d => d.id === id) ?? DEFAULT_DIRECTION,
		mode: mode === "light" || mode === "dark" ? mode : null,
		theme: SAMPLE_THEMES[params.get("theme") ?? ""] ?? OZ_THEME,
		preview: PREVIEWS[params.get("preview") ?? ""] ?? null,
	};
}

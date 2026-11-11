/** Production twin of `selection.ts`: the query string chooses nothing. */
import type { ConnectionPhase } from "../lib/client";
import { DEFAULT_DIRECTION } from "./registry";
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

export function readSelection(_search: string): Selection {
	return { direction: DEFAULT_DIRECTION, mode: null, theme: OZ_THEME, preview: null };
}

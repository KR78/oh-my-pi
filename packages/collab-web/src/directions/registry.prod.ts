/**
 * The production registry: only what ships. Until the owner chooses, that is
 * `classic` alone and `?direction=` is ignored; the chosen direction is added
 * here (and made the default) when it is picked.
 */
import { classic } from "./classic";
import type { Direction } from "./types";

export const DIRECTIONS: readonly Direction[] = [classic];

export const DEFAULT_DIRECTION = classic;

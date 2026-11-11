/**
 * Every direction, for dev and gallery builds. The production build swaps
 * this module for `registry.prod.ts` (see `scripts/build.ts`), so a direction
 * the owner has not chosen is not even in the bundle, let alone reachable
 * through `?direction=`.
 */
import { chamber } from "./chamber";
import { classic } from "./classic";
import { claude } from "./claude";
import { consoleDirection } from "./console";
import type { Direction } from "./types";

export const DIRECTIONS: readonly Direction[] = [classic, chamber, claude, consoleDirection];

export const DEFAULT_DIRECTION = classic;

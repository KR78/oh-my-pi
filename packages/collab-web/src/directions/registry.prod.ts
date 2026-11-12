/**
 * The production registry: all seven directions ship, with Paper (the
 * `claude` folder) as the default. Which one a visitor sees is decided by the
 * signed join ticket through `?look=` (see `selection.prod.ts`), never by a
 * query parameter a visitor could type: the owner's team and each person
 * choose in Oz's dashboard (2026-11-12).
 */
import { chamber } from "./chamber";
import { classic } from "./classic";
import { claude } from "./claude";
import { consoleDirection } from "./console";
import { feed } from "./feed";
import { slack } from "./slack";
import { studio } from "./studio";
import type { Direction } from "./types";

export const DIRECTIONS: readonly Direction[] = [classic, chamber, claude, consoleDirection, feed, studio, slack];

export const DEFAULT_DIRECTION = claude;

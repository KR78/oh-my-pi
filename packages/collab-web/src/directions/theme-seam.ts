/**
 * The customer theme seam: a small, fixed set of named overrides applied on
 * top of a direction's own tokens.
 *
 * Owner decision (2026-11-11): a customer may change the name, the logo, a
 * few colours, the corner radius, the UI font from a fixed list, and the
 * default light/dark mode. Nothing else. There is deliberately no free-form
 * CSS and no HTML: every value is validated against a narrow grammar here,
 * so a theme can recolour the page but never inject a selector, a url() to a
 * remote host, or markup. A value that fails validation is dropped and the
 * direction's own token stands.
 *
 * Where a theme comes from (dashboard settings, a signed field in the join
 * ticket) is a later spec. Until then the seam is exercised by the Oz
 * default below and, in dev and gallery builds only, a `?theme=` preview.
 */
import type { TokenMap } from "./types";

export type ThemeMode = "light" | "dark";

/** The only tokens a customer theme may set. Each maps to one CSS variable. */
export const SEAM_TOKENS = ["accent", "accent-ink", "surface", "ink", "radius", "font-ui"] as const;
export type SeamToken = (typeof SEAM_TOKENS)[number];

export interface CustomerTheme {
	/** Shown wherever a direction names the agent. 1–24 characters. */
	brandName: string;
	/** `data:image/svg+xml` or `data:image/png` only; null draws the Oz mark. */
	brandLogo: string | null;
	defaultMode: ThemeMode | "system";
	light: Partial<Record<SeamToken, string>>;
	dark: Partial<Record<SeamToken, string>>;
}

/** The default: Oz's own name and mark, every colour left to the direction. */
export const OZ_THEME: CustomerTheme = {
	brandName: "Oz",
	brandLogo: null,
	defaultMode: "system",
	light: {},
	dark: {},
};

const COLOUR = /^(?:#[0-9a-fA-F]{3,8}|oklch\(\s*[\d.]+%?\s+[\d.]+\s+[\d.]+\s*(?:\/\s*[\d.]+%?\s*)?\))$/;
const RADIUS = /^(?:\d{1,2}(?:\.\d+)?)px$/;
const LOGO = /^data:image\/(?:svg\+xml|png);base64,[A-Za-z0-9+/=]+$/;
const MAX_LOGO_BYTES = 48_000;

/** The fixed list of UI fonts a customer may pick: system stacks, nothing fetched. */
export const FONT_CHOICES: Record<string, string> = {
	system: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
	humanist: '"Segoe UI", "Helvetica Neue", Ubuntu, Cantarell, "Noto Sans", sans-serif',
	serif: 'ui-serif, "Iowan Old Style", "Palatino Linotype", Charter, Georgia, serif',
	mono: 'ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace',
};

function validValue(token: SeamToken, value: string): string | null {
	const v = value.trim();
	switch (token) {
		case "radius":
			return RADIUS.test(v) ? v : null;
		case "font-ui":
			return FONT_CHOICES[v] ?? null;
		default:
			return COLOUR.test(v) ? v : null;
	}
}

/** The validated overrides for one mode, as CSS variables. */
export function seamVariables(theme: CustomerTheme, mode: ThemeMode): TokenMap {
	const out: Record<string, string> = {};
	const values = theme[mode];
	for (const token of SEAM_TOKENS) {
		const raw = values[token];
		if (raw === undefined) continue;
		const valid = validValue(token, raw);
		if (valid !== null) out[token] = valid;
	}
	return out;
}

export function safeBrandName(theme: CustomerTheme): string {
	const name = theme.brandName.trim().slice(0, 24);
	return name.length > 0 ? name : "Oz";
}

export function safeBrandLogo(theme: CustomerTheme): string | null {
	const logo = theme.brandLogo;
	if (logo === null || logo.length > MAX_LOGO_BYTES || !LOGO.test(logo)) return null;
	return logo;
}

/**
 * Dev and gallery preview of the seam: `?theme=<name>` picks one of these
 * samples so a reviewer can watch a direction take a customer's colours.
 * Never reachable in the production build (the shell only reads `?theme`
 * when the gallery is compiled in).
 */
export const SAMPLE_THEMES: Record<string, CustomerTheme> = {
	harbour: {
		brandName: "Harbour",
		brandLogo: null,
		defaultMode: "light",
		light: {
			accent: "#0b6e69",
			"accent-ink": "#ffffff",
			surface: "#f4f7f6",
			ink: "#14211f",
			radius: "4px",
			"font-ui": "humanist",
		},
		dark: {
			accent: "#4fc2b8",
			"accent-ink": "#06201e",
			surface: "#0e1716",
			ink: "#e3efed",
			radius: "4px",
			"font-ui": "humanist",
		},
	},
};

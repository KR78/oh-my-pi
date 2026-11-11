/**
 * Chamber's palette is OpenChamber's own default theme pair
 * (`lib/theme/themes/openchamber-{light,dark}.json`), mapped onto the seam
 * and kit tokens. The surface step OpenChamber uses for the chat
 * (`surface.muted` mixed 50% into the background, design-system.css) is
 * resolved to a single value here.
 *
 * Copyright (c) 2025 Bohdan Triapitsyn. MIT License: the palette values are
 * taken from OpenChamber (https://github.com/openchamber/openchamber); the
 * licence text is in this folder's LICENSE-openchamber.txt.
 */
import type { TokenMap } from "../types";

const MONO = 'ui-monospace, "SFMono-Regular", Menlo, "Cascadia Mono", "Segoe UI Mono", monospace';
const SANS = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, Roboto, Ubuntu, sans-serif';

export const light: TokenMap = {
	// seam
	accent: "#b35017",
	"accent-ink": "#ffffff",
	surface: "#fbfaf7",
	ink: "#3a3a34",
	radius: "12px",
	"font-ui": SANS,
	// chamber
	"c-elevated": "#f3f2f0",
	"c-muted-ink": "#62625a",
	"c-faint-ink": "#77776d",
	"c-bold": "#2f2f2a",
	"c-user-bg": "#f3e9e3",
	"c-user-line": "#b350170d",
	"c-border": "#e5e1de",
	"c-border-hover": "#cbc7c2",
	"c-hover": "#0000000a",
	"c-active": "#00000014",
	"c-tools-icon": "#696960",
	"c-tools-desc": "#62625a",
	"c-tools-line": "#d8d5d0",
	"c-ok": "#517734",
	"c-warn": "#886914",
	"c-err": "#b7493f",
	"c-info": "#2c6ebd",
	"c-ok-bg": "#51773420",
	"c-err-bg": "#b7493f18",
	"c-info-bg": "#2c6ebd14",
	"c-shadow-raised":
		"inset 0 1px 0 0 rgb(255 255 255 / 0.7), 0 0 0 0.5px rgb(0 0 0 / 0.14), 0 1px 2px -0.5px rgb(0 0 0 / 0.06), 0 4px 10px -2px rgb(0 0 0 / 0.07)",
	"c-shadow-floating":
		"inset 0 1px 0 0 rgb(255 255 255 / 0.7), 0 0 0 0.5px rgb(0 0 0 / 0.14), 0 1px 2px -0.5px rgb(0 0 0 / 0.06), 0 4px 8px -2px rgb(0 0 0 / 0.08), 0 12px 20px -4px rgb(0 0 0 / 0.06)",
	"c-scrim": "#3939343d",
	// kit
	"k-mono": MONO,
	"k-ring": "#b35017",
	"k-selection": "#a9998f40",
	"k-radius": "9px",
	"k-line": "#e5e1de",
	"k-line-strong": "#cbc7c2",
	"k-inset": "#f6f5f2",
	"k-muted": "#62625a",
	"k-faint": "#77776d",
	"k-hover": "#0000000a",
	"k-marker": "#1e754f",
	"k-link": "#2d7d8c",
	"k-code-bg": "#efede8",
	"k-code-ink": "#006a2c",
	"k-add-bg": "#2c751e1f",
	"k-add-ink": "#3f6a22",
	"k-del-bg": "#ab59591f",
	"k-del-ink": "#a3413a",
	"k-hunk-bg": "#00000008",
	"k-err-line": "#b7493f55",
	"k-err-ink": "#9b3a31",
	"k-syn-comment": "#6f6e69",
	"k-syn-string": "#24837b",
	"k-syn-number": "#5e409d",
	"k-syn-keyword": "#205ea6",
	"k-prose-leading": "1.6",
	"k-heading-weight": "600",
};

export const dark: TokenMap = {
	accent: "#da7c47",
	"accent-ink": "#1a120d",
	surface: "#100d0c",
	ink: "#dbd7cc",
	radius: "12px",
	"font-ui": SANS,
	"c-elevated": "#1b1918",
	"c-muted-ink": "#a19e94",
	"c-faint-ink": "#8d8a80",
	"c-bold": "#e8e5dc",
	"c-user-bg": "#2d1c12",
	"c-user-line": "#da7c470d",
	"c-border": "#2b2928",
	"c-border-hover": "#504e4c",
	"c-hover": "#ffffff0f",
	"c-active": "#ffffff1a",
	"c-tools-icon": "#949187",
	"c-tools-desc": "#a19e94",
	"c-tools-line": "#383532",
	"c-ok": "#86bd5f",
	"c-warn": "#d39a3b",
	"c-err": "#e46b5a",
	"c-info": "#5aa9eb",
	"c-ok-bg": "#76ad4f22",
	"c-err-bg": "#da5b4a22",
	"c-info-bg": "#479fe618",
	"c-shadow-raised":
		"inset 0 1px 0 0 rgb(255 255 255 / 0.04), inset 0 0 0 0.5px rgb(255 255 255 / 0.08), 0 0 0 0.5px rgb(0 0 0 / 0.55), 0 2px 4px 0 rgb(0 0 0 / 0.25), 0 1px 2px 0 rgb(0 0 0 / 0.25)",
	"c-shadow-floating":
		"inset 0 1px 0 0 rgb(255 255 255 / 0.04), inset 0 0 0 0.5px rgb(255 255 255 / 0.08), 0 0 0 0.5px rgb(0 0 0 / 0.55), 0 8px 16px 0 rgb(0 0 0 / 0.25), 0 4px 8px 0 rgb(0 0 0 / 0.25)",
	"c-scrim": "#00000080",
	"k-mono": MONO,
	"k-ring": "#da7c47",
	"k-selection": "#c8c6c535",
	"k-radius": "9px",
	"k-line": "#2b2928",
	"k-line-strong": "#43403d",
	"k-inset": "#0c0a09",
	"k-muted": "#a19e94",
	"k-faint": "#8d8a80",
	"k-hover": "#ffffff0f",
	"k-marker": "#5aa65b",
	"k-link": "#74b0c0",
	"k-code-bg": "#1b1817",
	"k-code-ink": "#86bd5f",
	"k-add-bg": "#4d934e26",
	"k-add-ink": "#86bd5f",
	"k-del-bg": "#cb767626",
	"k-del-ink": "#e88a7e",
	"k-hunk-bg": "#ffffff06",
	"k-err-line": "#da5b4a55",
	"k-err-ink": "#ef8f82",
	"k-syn-comment": "#8f8c84",
	"k-syn-string": "#5ab8ad",
	"k-syn-number": "#a497d8",
	"k-syn-keyword": "#6ba0d6",
	"k-prose-leading": "1.6",
	"k-heading-weight": "600",
};

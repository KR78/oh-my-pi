/**
 * Loads a direction's one display font when that direction mounts, and only
 * then. A `@font-face` in the bundled CSS would not do: the bundler inlines
 * small fonts as data URIs into the shared stylesheet, so every direction's
 * font would download with every page. Registering a `FontFace` from the
 * direction's own module keeps the bytes behind the direction that uses
 * them. The URL is a same-origin bundled asset; nothing is fetched from a
 * CDN.
 */
import { useEffect } from "react";

export interface FontSource {
	url: string;
	weight: string;
	style?: "normal" | "italic";
}

const loaded = new Set<string>();

export function useDirectionFont(family: string, sources: readonly FontSource[]): void {
	useEffect(() => {
		if (typeof FontFace === "undefined" || !document.fonts) return;
		for (const source of sources) {
			const key = `${family}|${source.url}|${source.weight}|${source.style ?? "normal"}`;
			if (loaded.has(key)) continue;
			loaded.add(key);
			const face = new FontFace(family, `url(${source.url}) format("woff2")`, {
				weight: source.weight,
				style: source.style ?? "normal",
				display: "swap",
			});
			document.fonts.add(face);
			face.load().catch(() => {
				// a font that fails to load leaves the fallback stack in place
				loaded.delete(key);
			});
		}
	}, [family, sources]);
}

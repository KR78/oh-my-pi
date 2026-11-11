/**
 * Fixed room for the offline gallery (dev only).
 *
 * `bun scripts/mock-host.ts --dev-room` opens this room instead of a random
 * one, so the gallery can link every direction to the running mock host
 * without anyone pasting a link. The key is a published test value: it
 * protects nothing and must never be used by a real host.
 */
import { encodeBase64Url, formatCollabLink } from "../lib/link";

export const DEV_RELAY_PORT = 4766;
export const DEV_ROOM_ID = "ozGalleryDevRoom0001aa";
export const DEV_ROOM_KEY = Uint8Array.from({ length: 32 }, (_, i) => (i * 37 + 11) % 256);
export const DEV_WRITE_TOKEN = Uint8Array.from({ length: 16 }, (_, i) => (i * 53 + 7) % 256);

/**
 * Served on the server itself, the relay is `ws://localhost:<port>`. Served
 * behind a private HTTPS name (the review proxy routes `/r/` to the mock
 * relay), it is the page's own origin, so a reviewer on another machine joins
 * the same test room.
 */
function devRelay(port: number): string {
	const loc = typeof window === "undefined" ? undefined : window.location;
	if (loc === undefined || loc.hostname === "localhost" || loc.hostname === "127.0.0.1") return `ws://localhost:${port}`;
	return `${loc.protocol === "https:" ? "wss" : "ws"}://${loc.host}`;
}

export function devLinks(port = DEV_RELAY_PORT): { full: string; view: string; writeToken: string } {
	const relay = devRelay(port);
	return {
		full: formatCollabLink(relay, DEV_ROOM_ID, DEV_ROOM_KEY, DEV_WRITE_TOKEN),
		view: formatCollabLink(relay, DEV_ROOM_ID, DEV_ROOM_KEY),
		writeToken: encodeBase64Url(DEV_WRITE_TOKEN),
	};
}

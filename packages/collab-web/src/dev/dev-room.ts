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

export function devLinks(port = DEV_RELAY_PORT): { full: string; view: string; writeToken: string } {
	const relay = `ws://localhost:${port}`;
	return {
		full: formatCollabLink(relay, DEV_ROOM_ID, DEV_ROOM_KEY, DEV_WRITE_TOKEN),
		view: formatCollabLink(relay, DEV_ROOM_ID, DEV_ROOM_KEY),
		writeToken: encodeBase64Url(DEV_WRITE_TOKEN),
	};
}

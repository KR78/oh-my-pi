import { describe, expect, it } from "bun:test";
import "./transcript-dom-shim";
import { DEFAULT_DIRECTION, DIRECTIONS } from "../src/directions/registry.prod";
import { readSelection } from "../src/directions/selection.prod";

/** What the relay puts in `/?look=`: base64url(JSON {d, m?}), unpadded. */
function look(value: unknown): string {
	const text = typeof value === "string" ? value : JSON.stringify(value);
	const b64 = Buffer.from(text, "utf8").toString("base64url");
	return `?look=${b64}`;
}

describe("the production selection", () => {
	it("ships all seven directions, with Paper (the claude folder) as the default", () => {
		expect(DIRECTIONS.map(d => d.id).sort()).toEqual(
			["chamber", "claude", "classic", "console", "feed", "slack", "studio"].sort(),
		);
		expect(DEFAULT_DIRECTION.id).toBe("claude");
		expect(DEFAULT_DIRECTION.name).toBe("Paper");
	});

	it("shows Paper with no query at all", () => {
		expect(readSelection("").direction.id).toBe("claude");
	});

	it("maps the user-facing ids onto the folders: paper is claude, thread is slack", () => {
		expect(readSelection(look({ d: "paper" })).direction.id).toBe("claude");
		expect(readSelection(look({ d: "thread" })).direction.id).toBe("slack");
	});

	it("takes the other five by their own id", () => {
		for (const id of ["classic", "chamber", "console", "feed", "studio"]) {
			expect(readSelection(look({ d: id })).direction.id).toBe(id);
		}
	});

	it("does not accept a folder name that is not a user-facing id", () => {
		expect(readSelection(look({ d: "slack" })).direction.id).toBe("claude");
	});

	it("falls back to Paper for an unknown direction", () => {
		for (const d of ["evil", "", "__proto__", "constructor", "toString", 7, null, ["feed"]]) {
			expect(readSelection(look({ d })).direction.id).toBe("claude");
		}
	});

	it("falls back to Paper for a value that is not base64url JSON", () => {
		for (const search of [
			"?look=",
			"?look=%%%",
			"?look=!!!!",
			look("not json"),
			look("[]"),
			look("null"),
			look("42"),
			`?look=${"A".repeat(5000)}`,
		]) {
			expect(readSelection(search).direction.id).toBe("claude");
		}
	});

	it("ignores the dev-only parameters, which the production build does not honour", () => {
		const selection = readSelection("?direction=console&mode=dark&theme=anything&preview=ended");
		expect(selection.direction.id).toBe("claude");
		expect(selection.mode).toBeNull();
		expect(selection.preview).toBeNull();
	});

	it("reads the mode only when it is light or dark", () => {
		expect(readSelection(look({ d: "feed", m: "dark" })).mode).toBe("dark");
		expect(readSelection(look({ d: "feed", m: "light" })).mode).toBe("light");
		expect(readSelection(look({ d: "feed", m: "sepia" })).mode).toBeNull();
		expect(readSelection(look({ d: "feed" })).mode).toBeNull();
	});

	it("reads only the query string it is given, never a fragment", () => {
		const b64 = Buffer.from(JSON.stringify({ d: "feed" })).toString("base64url");
		expect(readSelection(`#look=${b64}`).direction.id).toBe("claude");
		expect(readSelection(`?x=1#look=${b64}`).direction.id).toBe("claude");
	});
});

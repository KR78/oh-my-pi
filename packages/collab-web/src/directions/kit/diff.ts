/**
 * Diff parsing for the edit views. Two dialects arrive over the wire:
 * the hashline form the coding agent reports (`+41|text`, `-41|text`,
 * ` 39|text`, a blank line between hunks) and plain unified diffs
 * (`@@ -1,3 +1,4 @@`, `+text`). Both become the same rows.
 */

export type DiffRowKind = "add" | "del" | "ctx" | "hunk";

export interface DiffRow {
	kind: DiffRowKind;
	/** Line number shown in the gutter, when the dialect carries one. */
	line: number | null;
	text: string;
}

const HASHLINE_ROW = /^([+\- ])\s*(\d+)\|(.*)$/;
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/;
const FILE_HEADER = /^(?:---|\+\+\+|diff --git|index )/;

export function parseDiff(diff: string): DiffRow[] {
	const rows: DiffRow[] = [];
	let next: number | null = null;
	const lines = diff.replace(/\n+$/, "").split("\n");
	for (const raw of lines) {
		const line = raw.replace(/\r$/, "").replaceAll("\t", "    ");
		const hash = HASHLINE_ROW.exec(line);
		if (hash) {
			const sign = hash[1];
			rows.push({
				kind: sign === "+" ? "add" : sign === "-" ? "del" : "ctx",
				line: Number(hash[2]),
				text: hash[3] ?? "",
			});
			continue;
		}
		const hunk = HUNK_HEADER.exec(line);
		if (hunk) {
			next = Number(hunk[1]);
			rows.push({ kind: "hunk", line: null, text: line });
			continue;
		}
		if (FILE_HEADER.test(line)) continue;
		if (line.trim().length === 0) {
			// A blank line between hashline hunks marks skipped lines.
			if (rows.length > 0 && rows[rows.length - 1]?.kind !== "hunk")
				rows.push({ kind: "hunk", line: null, text: "" });
			continue;
		}
		const sign = line[0];
		if (sign === "+") {
			rows.push({ kind: "add", line: next, text: line.slice(1) });
			if (next !== null) next++;
		} else if (sign === "-") {
			rows.push({ kind: "del", line: null, text: line.slice(1) });
		} else {
			rows.push({ kind: "ctx", line: next, text: sign === " " ? line.slice(1) : line });
			if (next !== null) next++;
		}
	}
	return rows;
}

/**
 * A small, dependency-free syntax tinter for the directions' code and diff
 * views. collab-web does not bundle highlight.js (see tool-render/util.ts
 * `getHljs`), and a full grammar would dwarf the page, so this colours the
 * four things a reader scans for: comments, strings, numbers and keywords.
 * It returns React nodes, never HTML, so nothing from a file can inject
 * markup.
 */
import type { ReactNode } from "react";

const KEYWORDS = new Set(
	(
		"const let var function return if else for while do switch case break continue new class extends import export from " +
		"default async await try catch finally throw typeof instanceof in of interface type enum implements public private " +
		"readonly static true false null undefined this super void yield def elif lambda pass raise with as fn pub mut impl " +
		"struct use mod match where self Self package func go defer chan select range then fi esac local echo cd"
	).split(" "),
);

// One alternation, hoisted: comment | string | number | identifier.
const TOKEN =
	/(\/\/[^\n]*|#(?![{!])[^\n]*|\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|(\b\d[\d_.]*\b)|([A-Za-z_$][\w$]*)/g;

const HASH_COMMENT_LANGS = new Set(["bash", "python", "ruby", "yaml", "ini", "toml", "dockerfile", "sh"]);

export function highlight(code: string, lang: string | null): ReactNode[] {
	if (!lang || lang === "markdown" || lang === "diff") return [code];
	const hashComments = HASH_COMMENT_LANGS.has(lang);
	const out: ReactNode[] = [];
	let last = 0;
	let key = 0;
	TOKEN.lastIndex = 0;
	for (let match = TOKEN.exec(code); match !== null; match = TOKEN.exec(code)) {
		const [text, comment, string, number, word] = match;
		let cls: string | null = null;
		if (comment !== undefined) cls = comment.startsWith("#") && !hashComments ? null : "hl-c";
		else if (string !== undefined) cls = "hl-s";
		else if (number !== undefined) cls = "hl-n";
		else if (word !== undefined && KEYWORDS.has(word)) cls = "hl-k";
		if (cls === null) continue;
		if (match.index > last) out.push(code.slice(last, match.index));
		out.push(
			<span key={key++} className={cls}>
				{text}
			</span>,
		);
		last = match.index + text.length;
	}
	if (last < code.length) out.push(code.slice(last));
	return out;
}

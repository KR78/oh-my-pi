/**
 * Static build of the guest page.
 *
 *   bun scripts/build.ts             # production: classic (and the chosen direction) only
 *   bun scripts/build.ts --gallery   # every direction plus the dev gallery, for a private preview
 *
 * The production build resolves `directions/registry` and
 * `directions/selection` to their `.prod` twins, so directions that have not
 * been chosen are absent from the bundle and the query string selects
 * nothing. That is a property of the output, not of a runtime flag: an
 * unchosen direction cannot be reached because its code is not there.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { BunPlugin } from "bun";

const root = path.resolve(import.meta.dir, "..");
const gallery = Bun.argv.includes("--gallery");
const outdir = path.join(root, gallery ? "dist-gallery" : "dist");

const PROD_TWINS = /[\\/]directions[\\/](registry|selection)$/;

const prodDirections: BunPlugin = {
	name: "prod-directions",
	setup(build) {
		build.onResolve({ filter: /(?:^|\/)(?:registry|selection)$/ }, args => {
			const target = path.resolve(path.dirname(args.importer), args.path);
			if (!PROD_TWINS.test(target)) return undefined;
			return { path: `${target}.prod.ts` };
		});
	},
};

await fs.rm(outdir, { recursive: true, force: true });
const entrypoints = [path.join(root, "index.html")];
if (gallery) entrypoints.push(path.join(root, "src/gallery.html"));
const result = await Bun.build({
	entrypoints,
	outdir,
	minify: true,
	splitting: true,
	define: { "process.env.NODE_ENV": '"production"' },
	naming: { entry: "[name].[ext]", chunk: "[hash].[ext]", asset: "[hash].[ext]" },
	plugins: gallery ? [] : [prodDirections],
});
if (!result.success) {
	for (const log of result.logs) console.error(log);
	process.exit(1);
}
await fs.cp(path.join(root, "public"), outdir, { recursive: true });
let bytes = 0;
for (const output of result.outputs) bytes += output.size;
console.log(
	`${gallery ? "gallery" : "production"} build: ${result.outputs.length} files, ${(bytes / 1024).toFixed(0)} KB → ${path.relative(root, outdir)}/`,
);

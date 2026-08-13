#!/usr/bin/env bun
/**
 * Publish this fork's coding agent to the `@kr78` npm scope.
 *
 * Why this exists instead of `scripts/ci-release-publish.ts`: that script is the
 * upstream release pipeline. It publishes the full `@oh-my-pi/*` set from CI via
 * OIDC trusted publishing, and it never rewrites package *names* — a fork has no
 * publish rights to that scope. This script publishes exactly one package, under
 * a different scope, from a laptop with a granular npm token.
 *
 * Only `pi-coding-agent` is published. `packages/coding-agent/scripts/bundle-dist.ts`
 * inlines every workspace dependency except the natives addon into `dist/cli.js`,
 * so the fork's own changes (currently `packages/ai` + `packages/catalog`) ride
 * along in the bundle. The published `bin` is therefore repointed at that bundle —
 * the same `publishBin` swap `ci-release-publish.ts` performs — which is what makes
 * a single-package publish self-contained. Leaving `bin` on `src/cli.ts` would
 * resolve the workspace deps from the registry at runtime, i.e. run upstream's
 * code and silently drop every fork patch.
 *
 * The `@oh-my-pi/*` dependency pins are left untouched: `bun pm pack` resolves
 * `catalog:` to the current monorepo version. That is only safe when upstream has
 * actually PUBLISHED that version — a version bump lands in git well before the
 * release CI pushes it to npm, so building straight off a freshly merged bump
 * produces a package whose every workspace pin 404s. `@kr78/pi-coding-agent@17.3.0`
 * shipped exactly that way and had to be deprecated. `assertPinsResolve` below now
 * refuses to publish unless every pin resolves on the registry.
 *
 * Consequence to respect when versioning: `omp update` pins
 * `@oh-my-pi/pi-natives` in lock-step with the agent version, so the version
 * published here must also exist upstream. Do not invent fork-only versions, and
 * do not publish from a bump upstream has not released yet — wait, or publish from
 * the last released base.
 *
 * The npm account has 2FA enforced for publishing, so a one-time password is
 * required; the granular token alone is not enough.
 *
 * Usage:
 *   bun scripts/fork-publish.ts --otp=123456   Build and publish
 *   bun scripts/fork-publish.ts --dry-run      Build and pack, print the tarball, publish nothing
 *   bun scripts/fork-publish.ts --otp=123456 --tarball=/path/to.tgz
 *                                              Publish an already-built tarball, skipping the rebuild
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";

const FORK_NAME = "@kr78/pi-coding-agent";
const PUBLISH_BIN = { omp: "dist/cli.js" } as const;
const PKG_DIR = path.join(import.meta.dir, "..", "packages", "coding-agent");
const MANIFEST = path.join(PKG_DIR, "package.json");

const isDryRun = process.argv.includes("--dry-run");
const otp = process.argv.find(arg => arg.startsWith("--otp="))?.slice("--otp=".length);
/** Publish a tarball built by an earlier run instead of rebuilding the bundle. */
const prebuilt = process.argv.find(arg => arg.startsWith("--tarball="))?.slice("--tarball=".length);

/**
 * Guard against publishing a name that would collide with upstream's scope, so a
 * bad edit to FORK_NAME can never push to `@oh-my-pi`.
 */
if (!FORK_NAME.startsWith("@kr78/")) {
	throw new Error(`Refusing to publish under a non-fork scope: ${FORK_NAME}`);
}

const original = await Bun.file(MANIFEST).text();
const manifest = JSON.parse(original) as Record<string, unknown>;
const upstreamName = manifest.name;
const version = manifest.version as string;

console.log(`Publishing ${upstreamName}@${version} as ${FORK_NAME}@${version}`);

// Refuse to republish an existing version: npm rejects it anyway, but failing
// here avoids a multi-minute bundle build first.
const existing = await $`npm view ${`${FORK_NAME}@${version}`} version`.quiet().nothrow();
if (existing.exitCode === 0 && existing.stdout.toString().trim()) {
	console.log(`${FORK_NAME}@${version} is already published — nothing to do.`);
	process.exit(0);
}

async function buildTarball(): Promise<string> {
	const packDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-fork-pack-"));
	try {
		manifest.name = FORK_NAME;
		manifest.bin = { ...PUBLISH_BIN };
		await Bun.write(MANIFEST, `${JSON.stringify(manifest, null, "\t")}\n`);

		// `bun pm pack` (not `npm pack`) resolves the `catalog:`/`workspace:`
		// protocols npm would ship verbatim, and runs the `prepack` lifecycle that
		// generates the tool views and builds dist/cli.js.
		console.log("Packing (runs prepack: gen:tool-views + gen:bundle)…");
		const packed = await $`bun pm pack --destination ${packDir}`.cwd(PKG_DIR).nothrow();
		if (packed.exitCode !== 0) throw new Error(`bun pm pack failed with exit code ${packed.exitCode}`);
	} finally {
		// Always restore the on-repo manifest byte-for-byte; the scope rewrite must
		// never be committed or left behind for the next build to pick up.
		await Bun.write(MANIFEST, original);
	}

	const tarball = (await fs.readdir(packDir)).find(entry => entry.endsWith(".tgz"));
	if (!tarball) throw new Error("bun pm pack produced no tarball");
	return path.join(packDir, tarball);
}

const tarballPath = prebuilt ?? (await buildTarball());

// Verify the packed manifest, not the intent: confirms the rewrite landed and
// the restore did not race the pack.
const packedManifest = JSON.parse(
	(await $`tar -xOzf ${tarballPath} package/package.json`.quiet()).stdout.toString(),
) as { name: string; version: string; bin: Record<string, string> };
if (packedManifest.name !== FORK_NAME) {
	throw new Error(`Packed manifest name is ${packedManifest.name}, expected ${FORK_NAME}`);
}
if (packedManifest.bin?.omp !== PUBLISH_BIN.omp) {
	throw new Error(`Packed bin is ${packedManifest.bin?.omp}, expected ${PUBLISH_BIN.omp}`);
}
console.log(`Packed ${packedManifest.name}@${packedManifest.version} (bin → ${packedManifest.bin.omp})`);
console.log(`Tarball: ${tarballPath}`);

/**
 * Fail before publishing if any scoped dependency pin is absent from the registry.
 *
 * `bun pm pack` resolves `catalog:` against the monorepo, which happily produces
 * pins for a version upstream has not released. npm accepts such a manifest, and
 * the breakage only surfaces later as `failed to resolve` in every consumer's
 * install — after the version number is permanently burned.
 */
async function assertPinsResolve(tarball: string): Promise<void> {
	const packed = JSON.parse((await $`tar -xOzf ${tarball} package/package.json`.quiet()).stdout.toString()) as {
		dependencies?: Record<string, string>;
	};
	const scoped = Object.entries(packed.dependencies ?? {}).filter(
		([name]) => name.startsWith("@oh-my-pi/") || name.startsWith("@kr78/"),
	);
	const unresolved: string[] = [];
	for (const [name, range] of scoped) {
		const spec = `${name}@${range}`;
		const view = await $`npm view ${spec} version`.quiet().nothrow();
		if (view.exitCode !== 0 || !view.stdout.toString().trim()) unresolved.push(spec);
	}
	if (unresolved.length > 0) {
		throw new Error(
			`Refusing to publish: ${unresolved.length} dependency pin(s) do not exist on npm:\n` +
				`${unresolved.map(spec => `  - ${spec}`).join("\n")}\n` +
				"Upstream has not released this version yet. Wait for its release CI, or publish from the last released base.",
		);
	}
	console.log(`Verified ${scoped.length} workspace dependency pins resolve on npm.`);
}

await assertPinsResolve(tarballPath);

if (isDryRun) {
	console.log("DRY RUN — not publishing.");
	process.exit(0);
}

if (!otp) {
	console.error("error: publishing requires a 2FA one-time password — rerun with --otp=<code>.");
	console.error(`       The built tarball is reusable: --otp=<code> --tarball=${tarballPath}`);
	process.exit(1);
}

const result = await $`npm publish ${tarballPath} --access public --otp=${otp}`.nothrow();
if (result.exitCode !== 0) throw new Error(`npm publish failed with exit code ${result.exitCode}`);
console.log(`Published ${packedManifest.name}@${packedManifest.version}`);

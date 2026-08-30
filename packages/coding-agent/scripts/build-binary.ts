#!/usr/bin/env bun

import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { compileCodingAgent } from "./compile-binary";

const packageDir = path.join(import.meta.dir, "..");
const repoRoot = path.join(packageDir, "..", "..");

/** Binary cross-compilation settings selected by `CROSS_TARGET`. */
export interface CrossBuild {
	readonly id: string;
	readonly platform: string;
	readonly arch: string;
	readonly target: Bun.Build.CompileTarget;
}

/** Resolves a CROSS_TARGET value to the Bun compile target used by local binary builds. */
export function resolveCrossBuild(value: string | undefined): CrossBuild | null {
	switch (value) {
		case undefined:
		case "":
			return null;
		case "darwin-arm64":
			return { id: value, platform: "darwin", arch: "arm64", target: "bun-darwin-arm64" };
		case "darwin-x64":
			return { id: value, platform: "darwin", arch: "x64", target: "bun-darwin-x64" };
		case "linux-arm64":
			return { id: value, platform: "linux", arch: "arm64", target: "bun-linux-arm64" };
		case "linux-x64":
			return { id: value, platform: "linux", arch: "x64", target: "bun-linux-x64-baseline" };
		case "win32-x64":
		case "windows-x64":
			return { id: value, platform: "win32", arch: "x64", target: "bun-windows-x64-baseline" };
		default:
			throw new Error(`Unsupported CROSS_TARGET: ${value}`);
	}
}

// Transformers.js is an optional, native-heavy dependency that is never bundled
// into the binary; the tiny-model worker `bun install`s it into a runtime cache
// on first use. The `catalog:` spec cannot be resolved from inside the compiled
// bunfs (issue #1763), so embed the concrete installed version here for the
// worker to pin its runtime install against.
const transformersManifest: unknown = createRequire(import.meta.url)("@huggingface/transformers/package.json");
if (
	typeof transformersManifest !== "object" ||
	transformersManifest === null ||
	!("version" in transformersManifest) ||
	typeof transformersManifest.version !== "string"
) {
	throw new Error("@huggingface/transformers package manifest has no string version");
}
const transformersVersion = transformersManifest.version;

async function runCommand(
	command: string[],
	env: NodeJS.ProcessEnv = Bun.env,
	cwd: string = packageDir,
): Promise<void> {
	const proc = Bun.spawn(command, {
		cwd,
		env,
		stdout: "inherit",
		stderr: "inherit",
	});
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		throw new Error(`Command failed with exit code ${exitCode}: ${command.join(" ")}`);
	}
}

/**
 * Stages the Swift `stt-nemotron` worker beside a compiled binary. The
 * compiled runtime resolves the worker only next to `process.execPath`
 * (src/stt/nemotron-worker-client.ts) and never falls back to workspace
 * build output, so a Darwin arm64 build that skips staging ships an `omp`
 * that cannot run Nemotron STT. `stagedName` defaults to the runtime-facing
 * `stt-nemotron`; release packaging overrides it with the per-platform asset
 * name (`omp-stt-nemotron-darwin-arm64`) so the worker rides the existing
 * bare-binary `omp-*` release globs.
 */
export function stageNemotronWorker({
	binaryPath,
	workerPath,
	stagedName = "stt-nemotron",
}: {
	binaryPath: string;
	workerPath: string;
	stagedName?: string;
}): void {
	const stagedPath = path.join(path.dirname(binaryPath), stagedName);
	const workerMode = fs.statSync(workerPath).mode & 0o7777;
	fs.copyFileSync(workerPath, stagedPath);
	fs.chmodSync(stagedPath, workerMode | 0o100);
}

/**
 * Whether a build must also build and stage the Nemotron STT worker. The
 * worker is a SwiftPM macOS executable, so only a Darwin arm64 host can
 * produce it, and it ships only for Darwin arm64 targets — covering the
 * native build and the same-host `CROSS_TARGET=darwin-arm64` build. Every
 * other target (including cross-compiling away from a Mac, and non-arm64
 * hosts targeting darwin-arm64) stays unchanged.
 */
export function shouldStageNemotronWorker(
	crossBuild: CrossBuild | null,
	host: { platform: NodeJS.Platform; arch: string } = process,
): boolean {
	const targetPlatform = crossBuild?.platform ?? host.platform;
	const targetArch = crossBuild?.arch ?? host.arch;
	return host.platform === "darwin" && host.arch === "arm64" && targetPlatform === "darwin" && targetArch === "arm64";
}

/**
 * Release asset name for the Nemotron STT worker, or null when the target
 * ships none. The worker is a Swift macOS executable that only exists for
 * Darwin arm64; release packaging stages it into `binaries/` under the
 * `omp-*` prefix so the existing checksum and GitHub-release globs publish
 * it with the binary, keeping the bare-binary (no-archive) release layout.
 */
export function releaseSttWorkerAssetName(target: { platform: string; arch: string }): string | null {
	return target.platform === "darwin" && target.arch === "arm64"
		? `omp-stt-nemotron-${target.platform}-${target.arch}`
		: null;
}

async function main(): Promise<void> {
	const crossBuild = resolveCrossBuild(Bun.env.CROSS_TARGET);
	const shouldBuildNemotronWorker = shouldStageNemotronWorker(crossBuild);
	const shouldAdhocSign = process.platform === "darwin" && !crossBuild && Bun.env.BUN_NO_CODESIGN_MACHO_BINARY !== "1";
	const outName = crossBuild ? `omp-${crossBuild.id}` : "omp";
	const outputPath = path.join(packageDir, "dist", outName);
	// Generate inside the try so the finally always restores the empty checked-in
	// placeholders (stats client archive, docs index) even on failure.
	try {
		await runCommand(["bun", "--cwd=../stats", "run", "gen:stats"]);
		// The in-memory legacy Pi virtual module reaches the coding-agent
		// `export/html` subpath, whose source imports `tool-views.generated.js`.
		// Rebuild it before compilation so clean checkouts that skipped install
		// hooks still contain that generated bundle.
		await runCommand(["bun", "--cwd=../collab-web", "run", "gen:tool-views"]);
		await runCommand(
			["bun", "--cwd=../natives", "run", "gen:native"],
			crossBuild ? { ...Bun.env, TARGET_PLATFORM: crossBuild.platform, TARGET_ARCH: crossBuild.arch } : Bun.env,
		);
		try {
			await compileCodingAgent({
				repoRoot,
				entrypoint: path.join(packageDir, "src", "cli.ts"),
				outfile: outputPath,
				transformersVersion,
				target: crossBuild?.target,
				executablePath: Bun.env.BUN_COMPILE_EXECUTABLE_PATH || undefined,
				skipBuiltinCodesign: shouldAdhocSign,
			});

			if (shouldAdhocSign) {
				await runCommand(["codesign", "--force", "--sign", "-", outputPath]);
			}
			if (shouldBuildNemotronWorker) {
				await runCommand(["bun", "run", "build:stt-worker"]);
				stageNemotronWorker({
					binaryPath: outputPath,
					workerPath: path.join(packageDir, "native", "stt-nemotron", ".build", "release", "stt-nemotron"),
				});
			}
		} finally {
			await runCommand(["bun", "--cwd=../natives", "run", "gen:native:reset"]);
		}
	} finally {
		await runCommand(["bun", "--cwd=../stats", "run", "gen:stats:reset"]);
	}
}

if (import.meta.main) await main();

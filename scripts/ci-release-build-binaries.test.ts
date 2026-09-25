import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils/temp";
import { $ } from "bun";
import { releaseSttWorkerAssetName, resolveCrossBuild } from "../packages/coding-agent/scripts/build-binary";
import { compileCodingAgent } from "../packages/coding-agent/scripts/compile-binary";

const repoRoot = path.join(import.meta.dir, "..");

async function runReleaseDryRun(target: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const captureDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-release-output-"));
	const stdoutPath = path.join(captureDir, "stdout");
	const stderrPath = path.join(captureDir, "stderr");
	try {
		const proc = Bun.spawn(
			[process.execPath, "scripts/ci-release-build-binaries.ts", "--dry-run", "--targets", target],
			{
				cwd: repoRoot,
				stdout: Bun.file(stdoutPath),
				stderr: Bun.file(stderrPath),
			},
		);
		const exitCode = await proc.exited;
		const [stdout, stderr] = await Promise.all([Bun.file(stdoutPath).text(), Bun.file(stderrPath).text()]);
		return { exitCode, stdout, stderr };
	} finally {
		await fs.rm(captureDir, { recursive: true, force: true });
	}
}

describe("Windows release binary target", () => {
	it("builds both Windows architecture release assets with their native runtimes", async () => {
		const result = await runReleaseDryRun("win32-x64,win32-arm64");
		expect(result.exitCode, result.stderr).toBe(0);
		const output = result.stdout;

		expect(output).toContain("Building packages/coding-agent/binaries/omp-windows-x64.exe...");
		expect(output).toContain(
			"DRY RUN Bun.build target=bun-windows-x64-baseline outfile=packages/coding-agent/binaries/omp-windows-x64.exe",
		);
		expect(output).toContain("Building packages/coding-agent/binaries/omp-windows-arm64.exe...");
		expect(output).toContain(
			"DRY RUN Bun.build target=bun-windows-arm64 outfile=packages/coding-agent/binaries/omp-windows-arm64.exe",
		);
		expect(output).toContain("external=fastembed,onnxruntime-node");
		expect(output).not.toContain("bun-windows-x64-modern");
	});

	it("resolves local Windows cross-build aliases for both architectures", () => {
		expect(resolveCrossBuild("win32-x64")).toEqual({
			id: "win32-x64",
			platform: "win32",
			arch: "x64",
			target: "bun-windows-x64-baseline",
		});
		expect(resolveCrossBuild("windows-x64")).toEqual({
			id: "windows-x64",
			platform: "win32",
			arch: "x64",
			target: "bun-windows-x64-baseline",
		});
		expect(resolveCrossBuild("win32-arm64")).toEqual({
			id: "win32-arm64",
			platform: "win32",
			arch: "arm64",
			target: "bun-windows-arm64",
		});
		expect(resolveCrossBuild("windows-arm64")).toEqual({
			id: "windows-arm64",
			platform: "win32",
			arch: "arm64",
			target: "bun-windows-arm64",
		});
	});
});

describe("darwin-arm64 release STT worker staging", () => {
	it("stages the stt-nemotron worker asset only for the darwin-arm64 target", () => {
		expect(releaseSttWorkerAssetName({ platform: "darwin", arch: "arm64" })).toBe("omp-stt-nemotron-darwin-arm64");
		expect(releaseSttWorkerAssetName({ platform: "darwin", arch: "x64" })).toBeNull();
		expect(releaseSttWorkerAssetName({ platform: "linux", arch: "arm64" })).toBeNull();
		expect(releaseSttWorkerAssetName({ platform: "win32", arch: "x64" })).toBeNull();
	});

	it("plans the worker build for darwin-arm64 and not for darwin-x64", async () => {
		const arm64 = await runReleaseDryRun("darwin-arm64");
		expect(arm64.exitCode, arm64.stderr).toBe(0);
		expect(arm64.stdout).toContain(
			"DRY RUN bun run build:stt-worker stage=packages/coding-agent/binaries/omp-stt-nemotron-darwin-arm64",
		);

		const x64 = await runReleaseDryRun("darwin-x64");
		expect(x64.exitCode, x64.stderr).toBe(0);
		expect(x64.stdout).not.toContain("build:stt-worker");
	});
});

it("runs compiled bytecode containing dependency import.meta.resolve calls", async () => {
	using temp = TempDir.createSync("@omp-bytecode-");
	const entrypoint = temp.join("entry.ts");
	const outfile = temp.join(process.platform === "win32" ? "probe.exe" : "probe");
	await Bun.write(entrypoint, 'console.log(import.meta.resolve("node:fs"));\n');
	await compileCodingAgent({
		repoRoot: temp.path(),
		entrypoint,
		outfile,
		transformersVersion: "unused",
	});
	const result = await $`${outfile}`.quiet().nothrow();
	expect(result.exitCode).toBe(0);
	expect(result.text().trim()).toBe("node:fs");
}, 30_000);
describe("macOS release binary entitlements", () => {
	it("allows Xcode MCP automation through Apple Events", async () => {
		const entitlements = await Bun.file(path.join(repoRoot, "scripts/macos-entitlements.plist")).text();

		expect(entitlements).toContain("<key>com.apple.security.automation.apple-events</key>\n\t<true/>");
	});
});

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { shouldStageNemotronWorker, stageNemotronWorker } from "./build-binary";

/**
 * Regression test for binary packaging: a local Darwin arm64 build must stage
 * the Swift `stt-nemotron` worker beside the compiled `dist/omp` binary. The
 * compiled runtime only resolves the worker next to `process.execPath`
 * (src/stt/nemotron-worker-client.ts) and never falls back to the workspace
 * build output, so a build that skips staging ships an `omp` that cannot run
 * Nemotron STT. Exercises the staging helper against a fake dist tree only —
 * no SwiftPM build and no `bun build --compile` is invoked.
 */
describe("build-binary stageNemotronWorker", () => {
	test("stages stt-nemotron beside the binary with identical bytes and owner-exec bits", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omp-stt-stage-"));
		try {
			// Fake compiled binary: `dist/omp` in the temp package dir.
			const ompPath = path.join(tmp, "dist", "omp");
			fs.mkdirSync(path.dirname(ompPath), { recursive: true });
			fs.writeFileSync(ompPath, Buffer.from("#!/fake-omp-binary\n"));
			fs.chmodSync(ompPath, 0o755);

			// Fake SwiftPM release output with bytes distinct from the binary,
			// so a copy of the wrong source cannot satisfy the assertions.
			const workerBytes = Buffer.from("fake-stt-nemotron-worker\x00\x01\x02\n");
			const workerPath = path.join(tmp, "worker-out", "stt-nemotron");
			fs.mkdirSync(path.dirname(workerPath), { recursive: true });
			fs.writeFileSync(workerPath, workerBytes);
			fs.chmodSync(workerPath, 0o755);

			stageNemotronWorker({ binaryPath: ompPath, workerPath });

			// The runtime spawns path.join(dirname(execPath), "stt-nemotron").
			const stagedPath = path.join(path.dirname(ompPath), "stt-nemotron");
			expect(fs.existsSync(stagedPath)).toBe(true);
			expect(fs.readFileSync(stagedPath).equals(workerBytes)).toBe(true);
			expect(fs.statSync(stagedPath).mode & 0o100).toBe(0o100);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
});

describe("build-binary shouldStageNemotronWorker", () => {
	const darwinArm64 = { platform: "darwin" as const, arch: "arm64" };
	const darwinX64 = { platform: "darwin" as const, arch: "x64" };
	const linuxX64 = { platform: "linux" as const, arch: "x64" };

	test("stages the worker for the native Darwin arm64 build", () => {
		expect(shouldStageNemotronWorker(null, darwinArm64)).toBe(true);
	});

	test("stages the worker for the same-host CROSS_TARGET=darwin-arm64 build", () => {
		expect(
			shouldStageNemotronWorker(
				{ id: "darwin-arm64", platform: "darwin", arch: "arm64", target: "bun-darwin-arm64" },
				darwinArm64,
			),
		).toBe(true);
	});

	test("never stages for other targets, even from a Darwin arm64 host", () => {
		for (const cross of [
			{ id: "darwin-x64", platform: "darwin", arch: "x64", target: "bun-darwin-x64" },
			{ id: "linux-arm64", platform: "linux", arch: "arm64", target: "bun-linux-arm64" },
			{ id: "linux-x64", platform: "linux", arch: "x64", target: "bun-linux-x64-baseline" },
			{ id: "win32-x64", platform: "win32", arch: "x64", target: "bun-windows-x64-baseline" },
		] as const) {
			expect(shouldStageNemotronWorker(cross, darwinArm64)).toBe(false);
		}
	});

	test("never stages when the host cannot produce the Swift worker", () => {
		// Cross-hosting to darwin-arm64 (Intel Mac or Linux) has no SwiftPM path.
		const cross = { id: "darwin-arm64", platform: "darwin", arch: "arm64", target: "bun-darwin-arm64" } as const;
		expect(shouldStageNemotronWorker(cross, darwinX64)).toBe(false);
		expect(shouldStageNemotronWorker(cross, linuxX64)).toBe(false);
		expect(shouldStageNemotronWorker(null, linuxX64)).toBe(false);
	});
});

describe("build-binary stageNemotronWorker stagedName", () => {
	test("stages under the release asset name when packaging overrides it", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omp-stt-stage-name-"));
		try {
			const ompPath = path.join(tmp, "binaries", "omp-darwin-arm64");
			fs.mkdirSync(path.dirname(ompPath), { recursive: true });
			fs.writeFileSync(ompPath, "omp");

			const workerBytes = Buffer.from("release-worker-bytes\n");
			const workerPath = path.join(tmp, "worker-out", "stt-nemotron");
			fs.mkdirSync(path.dirname(workerPath), { recursive: true });
			fs.writeFileSync(workerPath, workerBytes);

			stageNemotronWorker({
				binaryPath: ompPath,
				workerPath,
				stagedName: "omp-stt-nemotron-darwin-arm64",
			});

			const staged = path.join(tmp, "binaries", "omp-stt-nemotron-darwin-arm64");
			expect(fs.readFileSync(staged).equals(workerBytes)).toBe(true);
			// No runtime-facing name leaks into the release binaries dir.
			expect(fs.existsSync(path.join(tmp, "binaries", "stt-nemotron"))).toBe(false);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
});

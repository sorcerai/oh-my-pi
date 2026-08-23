import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const repoRoot = path.join(import.meta.dir, "..");
const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function run(
	command: string[],
	env: NodeJS.ProcessEnv = process.env,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const captureDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-stt-output-"));
	const stdoutPath = path.join(captureDir, "stdout");
	const stderrPath = path.join(captureDir, "stderr");
	try {
		const proc = Bun.spawn(command, {
			cwd: repoRoot,
			env,
			stdout: Bun.file(stdoutPath),
			stderr: Bun.file(stderrPath),
		});
		const exitCode = await proc.exited;
		const [stdout, stderr] = await Promise.all([Bun.file(stdoutPath).text(), Bun.file(stderrPath).text()]);
		return { exitCode, stdout, stderr };
	} finally {
		await fs.rm(captureDir, { recursive: true, force: true });
	}
}

async function writeExecutable(directory: string, name: string, content: string): Promise<void> {
	const file = path.join(directory, name);
	await Bun.write(file, content);
	await fs.chmod(file, 0o755);
}

// The omp payload must survive the installer's post-install smoke
// (`omp --version`), so it is a real runnable script rather than inert bytes.
const OMP_SCRIPT = "#!/bin/sh\necho omp/1.0.0\n";
const WORKER_BYTES = "fake-stt-nemotron-worker\n";

/**
 * PATH-stub environment presenting a Darwin arm64 host whose `curl` serves
 * the release metadata plus per-asset payloads (mirrors the technique in
 * musl-release.test.ts so the installer's platform detection and downloads
 * are exercised for real on any test host).
 */
async function darwinArm64Env(
	options: {
		failWorkerDownload?: boolean;
		failRename?: "omp" | "worker";
		failWorkerRestore?: boolean;
		failWorkerBackupCleanup?: boolean;
		signalAfterWorkerRename?: boolean;
		releaseHasWorker?: boolean;
	} = {},
): Promise<{
	env: NodeJS.ProcessEnv;
	dir: string;
	installDir: string;
}> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-stt-install-"));
	tempDirs.push(dir);
	const binDir = path.join(dir, "bin");
	const installDir = path.join(dir, "install");
	await fs.mkdir(binDir);

	await writeExecutable(binDir, "uname", '#!/bin/sh\n[ "$1" = "-s" ] && echo Darwin || echo arm64\n');
	await writeExecutable(binDir, "sysctl", "#!/bin/sh\necho 1\n");
	const releaseMetadata =
		options.releaseHasWorker === false
			? '{"assets":[],"tag_name":"v1.0.0","html_url":"https://example.invalid/v1.0.0"}'
			: '{"assets":[{"name":"omp-stt-nemotron-darwin-arm64"}],"tag_name":"v1.0.0","html_url":"https://example.invalid/v1.0.0"}';
	await writeExecutable(
		binDir,
		"curl",
		`#!/bin/sh
target=
url=
for arg in "$@"; do
  case "$prev" in
    -o) target=$arg ;;
  esac
  case "$arg" in
    http*) url=$arg ;;
  esac
  prev=$arg
done
case "$url" in
  *api.github.com*)
    echo '${releaseMetadata}'
    exit 0
    ;;
  *omp-stt-nemotron-darwin-arm64*)
    ${options.failWorkerDownload ? "exit 22" : `printf '%s' '${WORKER_BYTES}' > "$target"`}
    exit $?
    ;;
  *omp-darwin-arm64*)
    printf '%s' '${OMP_SCRIPT}' > "$target"
    exit 0
    ;;
  *)
    echo "unexpected url: $url" >&2
    exit 1
    ;;
esac
`,
	);
	// Optional mv stub: can fail a requested final rename, fail the worker
	// backup restore, or signal the installer after the worker rename.
	if (options.failRename || options.failWorkerRestore || options.signalAfterWorkerRename) {
		const failSrc = options.failRename === "omp" ? ".omp.install." : ".stt-nemotron.install.";
		const failDst = options.failRename === "omp" ? "/omp" : "/stt-nemotron";
		const failFinalRename = options.failRename
			? `case "$dst" in
  *${failDst})
    case "$src" in
      *${failSrc}*) echo "mv: simulated final rename failure" >&2; exit 1 ;;
    esac
    ;;
esac`
			: "";
		const failWorkerRestore = options.failWorkerRestore
			? `case "$dst" in
  */stt-nemotron)
    case "$src" in
      *.stt-nemotron.backup.*) echo "mv: simulated worker restore failure" >&2; exit 1 ;;
    esac
    ;;
esac`
			: "";
		await writeExecutable(
			binDir,
			"mv",
			`#!/bin/sh
src=
dst=
for arg in "$@"; do
  src=$dst
  dst=$arg
done
${failFinalRename}
${failWorkerRestore}
real_mv=
for candidate in /bin/mv /usr/bin/mv; do
  if [ -x "$candidate" ]; then
    real_mv=$candidate
    break
  fi
done
[ -n "$real_mv" ] || { echo "mv: no real mv found" >&2; exit 1; }
"$real_mv" "$@"
status=$?
if [ "$status" -eq 0 ]; then
  case "$dst" in
    */stt-nemotron)
      case "$src" in
        *.stt-nemotron.install.*)
          ${options.signalAfterWorkerRename ? 'kill -TERM "$PPID"' : ":"}
          ;;
      esac
      ;;
  esac
fi
exit "$status"
`,
		);
	}
	if (options.failWorkerBackupCleanup) {
		const rmStatePath = path.join(dir, "rm-worker-cleanup-state");
		await writeExecutable(
			binDir,
			"rm",
			`#!/bin/sh
state_file='${rmStatePath}'
real_rm=
for candidate in /bin/rm /usr/bin/rm; do
  if [ -x "$candidate" ]; then
    real_rm=$candidate
    break
  fi
done
[ -n "$real_rm" ] || { echo "rm: no real rm found" >&2; exit 1; }
for arg in "$@"; do
  case "$arg" in
    *.omp.backup.*)
      "$real_rm" "$@"
      status=$?
      if [ "$status" -eq 0 ]; then
        : > "$state_file"
      fi
      exit "$status"
      ;;
    *.stt-nemotron.backup.*)
      if [ -f "$state_file" ]; then
        echo "rm: simulated worker backup cleanup failure" >&2
        exit 1
      fi
      ;;
  esac
done
"$real_rm" "$@"
`,
		);
	}

	return {
		env: {
			...process.env,
			PATH: `${binDir}:${process.env.PATH ?? ""}`,
			HOME: dir,
			PI_INSTALL_DIR: installDir,
		},
		dir,
		installDir,
	};
}

describe("install.sh stt-nemotron worker adjacency (darwin-arm64)", () => {
	test("installs the worker beside omp and leaves no staging leftovers", async () => {
		const { env, installDir } = await darwinArm64Env();

		const result = await run(["sh", "scripts/install.sh", "--binary"], env);

		expect(result.exitCode, result.stderr).toBe(0);
		expect(result.stdout).toContain("Downloading omp-darwin-arm64...");
		expect(result.stdout).toContain("Downloading omp-stt-nemotron-darwin-arm64...");
		expect(await Bun.file(path.join(installDir, "omp")).text()).toBe(OMP_SCRIPT);
		expect(await Bun.file(path.join(installDir, "stt-nemotron")).text()).toBe(WORKER_BYTES);
		// The runtime spawns the adjacent worker — it must land executable.
		expect((await fs.stat(path.join(installDir, "stt-nemotron"))).mode & 0o100).toBe(0o100);
		// Staged temp files must all be consumed by the atomic renames.
		const leftovers = (await fs.readdir(installDir)).filter(
			name => name.startsWith(".omp") || name.startsWith(".stt"),
		);
		expect(leftovers).toEqual([]);
	});

	test("keeps older Darwin arm64 releases installable when metadata has no worker asset", async () => {
		const { env, installDir } = await darwinArm64Env({ releaseHasWorker: false });

		const result = await run(["sh", "scripts/install.sh", "--binary"], env);

		expect(result.exitCode, result.stderr).toBe(0);
		expect(result.stdout).toContain("has no omp-stt-nemotron-darwin-arm64");
		expect(await Bun.file(path.join(installDir, "omp")).text()).toBe(OMP_SCRIPT);
		expect(await Bun.file(path.join(installDir, "stt-nemotron")).exists()).toBe(false);
	});

	test("a failed worker download never installs a workerless omp or touches existing files", async () => {
		const { env, installDir } = await darwinArm64Env({ failWorkerDownload: true });
		await fs.mkdir(installDir, { recursive: true });
		await Bun.write(path.join(installDir, "omp"), "old omp");
		await Bun.write(path.join(installDir, "stt-nemotron"), "old worker");

		const result = await run(["sh", "scripts/install.sh", "--binary"], env);

		expect(result.exitCode).not.toBe(0);
		// Both previous files are exactly as they were: no new omp without its
		// worker, no deleted/replaced worker.
		expect(await Bun.file(path.join(installDir, "omp")).text()).toBe("old omp");
		expect(await Bun.file(path.join(installDir, "stt-nemotron")).text()).toBe("old worker");
		const leftovers = (await fs.readdir(installDir)).filter(
			name => name.startsWith(".omp") || name.startsWith(".stt"),
		);
		expect(leftovers).toEqual([]);
	});
});

describe("install.sh paired-rename rollback (darwin-arm64)", () => {
	async function seedPair(installDir: string): Promise<void> {
		await fs.mkdir(installDir, { recursive: true });
		await Bun.write(path.join(installDir, "omp"), "old omp");
		await Bun.write(path.join(installDir, "stt-nemotron"), "old worker");
	}

	async function expectSymlink(file: string, target: string): Promise<void> {
		const stat = await fs.lstat(file).catch(() => undefined);
		expect(stat?.isSymbolicLink()).toBe(true);
		if (stat?.isSymbolicLink()) {
			expect(await fs.readlink(file)).toBe(target);
		}
	}

	test("a signal after worker rename rolls back the old pair and removes transaction files", async () => {
		const { env, installDir } = await darwinArm64Env({ signalAfterWorkerRename: true });
		await seedPair(installDir);

		const result = await run(["sh", "scripts/install.sh", "--binary"], env);

		expect(result.exitCode).not.toBe(0);
		expect(await Bun.file(path.join(installDir, "omp")).text()).toBe("old omp");
		expect(await Bun.file(path.join(installDir, "stt-nemotron")).text()).toBe("old worker");
		const leftovers = (await fs.readdir(installDir)).filter(
			name => name.startsWith(".omp") || name.startsWith(".stt"),
		);
		expect(leftovers).toEqual([]);
	});

	test("restores a valid omp symlink and dangling worker symlink after omp rename failure", async () => {
		const { env, dir, installDir } = await darwinArm64Env({ failRename: "omp" });
		await fs.mkdir(installDir, { recursive: true });
		const ompTarget = path.join(dir, "previous-omp");
		const workerTarget = path.join(dir, "missing-worker");
		await Bun.write(ompTarget, "old omp");
		await fs.symlink(ompTarget, path.join(installDir, "omp"));
		await fs.symlink(workerTarget, path.join(installDir, "stt-nemotron"));

		const result = await run(["sh", "scripts/install.sh", "--binary"], env);

		expect(result.exitCode).not.toBe(0);
		await expectSymlink(path.join(installDir, "omp"), ompTarget);
		await expectSymlink(path.join(installDir, "stt-nemotron"), workerTarget);
		expect(await Bun.file(ompTarget).text()).toBe("old omp");
		const leftovers = (await fs.readdir(installDir)).filter(
			name => name.startsWith(".omp") || name.startsWith(".stt"),
		);
		expect(leftovers).toEqual([]);
	});

	test("restores a dangling omp symlink and valid worker symlink after omp rename failure", async () => {
		const { env, dir, installDir } = await darwinArm64Env({ failRename: "omp" });
		await fs.mkdir(installDir, { recursive: true });
		const ompTarget = path.join(dir, "missing-omp");
		const workerTarget = path.join(dir, "previous-worker");
		await Bun.write(workerTarget, "old worker");
		await fs.symlink(ompTarget, path.join(installDir, "omp"));
		await fs.symlink(workerTarget, path.join(installDir, "stt-nemotron"));

		const result = await run(["sh", "scripts/install.sh", "--binary"], env);

		expect(result.exitCode).not.toBe(0);
		await expectSymlink(path.join(installDir, "omp"), ompTarget);
		await expectSymlink(path.join(installDir, "stt-nemotron"), workerTarget);
		expect(await Bun.file(workerTarget).text()).toBe("old worker");
		const leftovers = (await fs.readdir(installDir)).filter(
			name => name.startsWith(".omp") || name.startsWith(".stt"),
		);
		expect(leftovers).toEqual([]);
	});

	test("a failed worker rename aborts before omp is touched", async () => {
		const { env, installDir } = await darwinArm64Env({ failRename: "worker" });
		await seedPair(installDir);

		const result = await run(["sh", "scripts/install.sh", "--binary"], env);

		expect(result.exitCode).not.toBe(0);
		expect(await Bun.file(path.join(installDir, "omp")).text()).toBe("old omp");
		expect(await Bun.file(path.join(installDir, "stt-nemotron")).text()).toBe("old worker");
		const leftovers = (await fs.readdir(installDir)).filter(
			name => name.startsWith(".omp") || name.startsWith(".stt"),
		);
		expect(leftovers).toEqual([]);
	});

	test("a failed omp rename restores the freshly-installed worker and keeps the previous omp", async () => {
		const { env, installDir } = await darwinArm64Env({ failRename: "omp" });
		await seedPair(installDir);

		const result = await run(["sh", "scripts/install.sh", "--binary"], env);

		expect(result.exitCode).not.toBe(0);
		expect(await Bun.file(path.join(installDir, "omp")).text()).toBe("old omp");
		// The worker rename succeeded before the omp failure; the rollback must
		// undo it so the previous pair is restored exactly.
		expect(await Bun.file(path.join(installDir, "stt-nemotron")).text()).toBe("old worker");
		const leftovers = (await fs.readdir(installDir)).filter(
			name => name.startsWith(".omp") || name.startsWith(".stt"),
		);
		expect(leftovers).toEqual([]);
	});

	test("restores omp even when restoring the worker backup fails", async () => {
		const { env, installDir } = await darwinArm64Env({ failRename: "omp", failWorkerRestore: true });
		await seedPair(installDir);

		const result = await run(["sh", "scripts/install.sh", "--binary"], env);

		expect(result.exitCode).not.toBe(0);
		expect(result.stdout).toContain("Rollback was incomplete");
		expect(await Bun.file(path.join(installDir, "omp")).text()).toBe("old omp");
	});

	test("a worker backup cleanup failure keeps the freshly-installed pair", async () => {
		const { env, installDir } = await darwinArm64Env({ failWorkerBackupCleanup: true });
		await seedPair(installDir);

		const result = await run(["sh", "scripts/install.sh", "--binary"], env);

		expect(result.exitCode).not.toBe(0);
		expect(await Bun.file(path.join(installDir, "omp")).text()).toBe(OMP_SCRIPT);
		expect(await Bun.file(path.join(installDir, "stt-nemotron")).text()).toBe(WORKER_BYTES);
		const leftovers = (await fs.readdir(installDir)).filter(
			name => name.startsWith(".omp") || name.startsWith(".stt"),
		);
		expect(leftovers).toHaveLength(1);
		expect(leftovers[0]).toMatch(/^\.stt-nemotron\.backup\./);
	});
});

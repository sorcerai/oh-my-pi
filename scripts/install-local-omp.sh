#!/bin/sh
# Build and atomically install the exact clean HEAD as Bun's global `omp`.
set -eu

name=install-local-omp
install_stage=
backup_stage=
backup_stage_dir=
restore_stage=
restore_stage_dir=
smoke_log=
smoke_json=
build_parent=
build_root=
lock_dir=
lock_held=0
worktree_added=0
backup_ready=0
had_target=0
previous_kind=
previous_link=
worker_install_stage=
worker_target=
worker_backup=
had_worker=0
worker_backup_ready=0
installed_worker_sum=

fail() {
	printf '%s: %s\n' "$name" "$*" >&2
	exit 1
}

rollback() {
	set +e
	if [ "$worker_backup_ready" -eq 1 ]; then
		if [ "$had_worker" -eq 1 ]; then
			if mv -f "$worker_backup" "$worker_target"; then
				worker_backup_ready=0
				printf '%s: restored previous stt-nemotron worker from %s\n' "$name" "$worker_backup" >&2
			else
				printf '%s: automatic worker restore failed; backup remains at %s\n' "$name" "$worker_backup" >&2
			fi
		else
			rm -f "$worker_target"
			worker_backup_ready=0
			printf '%s: removed failed stt-nemotron worker; no previous worker existed\n' "$name" >&2
		fi
	fi
	if [ "$had_target" -eq 1 ]; then
		restore_stage_dir=$(mktemp -d "$global_bin/.omp.restore.XXXXXX") || restore_stage_dir=
		restore_ok=0
		if [ -n "$restore_stage_dir" ]; then
			restore_stage=$restore_stage_dir/omp
			case "$previous_kind" in
				symlink) ln -s "$previous_link" "$restore_stage" ;;
				file) cp -p "$backup" "$restore_stage" ;;
				*) false ;;
			esac &&
				mv -f "$restore_stage" "$target" &&
				restore_ok=1
		fi
		if [ "$restore_ok" -eq 1 ]; then
			restore_stage=
			rm -rf "$restore_stage_dir"
			restore_stage_dir=
			printf '%s: restored previous %s from %s\n' "$name" "$previous_kind" "$backup" >&2
		else
			printf '%s: automatic restore failed; backup remains at %s\n' "$name" "$backup" >&2
		fi
	else
		rm -f "$target"
		printf '%s: removed failed executable; no previous executable existed\n' "$name" >&2
	fi
}
cleanup_worktree() {
	[ -n "$build_parent" ] || return 0
	cleanup_status=0
	if [ "$worktree_added" -eq 1 ] || [ -e "$build_root/.git" ]; then
		if git -C "$repo_root" worktree remove --force "$build_root" >/dev/null 2>&1; then
			worktree_added=0
		else
			cleanup_status=1
		fi
	fi
	if [ "$cleanup_status" -eq 0 ] && [ -d "$build_parent" ]; then
		rm -rf "$build_parent" || cleanup_status=1
	fi
	if [ "$cleanup_status" -ne 0 ]; then
		printf '%s: could not fully remove disposable worktree: %s\n' "$name" "$build_root" >&2
		return 1
	fi
	build_parent=
	build_root=
	return 0
}

release_lock() {
	[ "$lock_held" -eq 1 ] || return 0
	if ! rmdir "$lock_dir"; then
		printf '%s: could not release installer lock: %s\n' "$name" "$lock_dir" >&2
		return 1
	fi
	lock_held=0
	lock_dir=
	return 0
}

on_exit() {
	status=$1
	trap - 0 HUP INT TERM
	set +e
	if [ "$status" -ne 0 ] && [ "$backup_ready" -eq 1 ]; then
		rollback
	fi
	[ -z "$worker_install_stage" ] || rm -f "$worker_install_stage"
	[ -z "$install_stage" ] || rm -f "$install_stage"
	[ -z "$backup_stage" ] || rm -f "$backup_stage"
	[ -z "$backup_stage_dir" ] || rm -rf "$backup_stage_dir"
	[ -z "$restore_stage" ] || rm -f "$restore_stage"
	[ -z "$restore_stage_dir" ] || rm -rf "$restore_stage_dir"
	[ -z "$smoke_log" ] || rm -f "$smoke_log"
	[ -z "$smoke_json" ] || rm -f "$smoke_json"
	if ! cleanup_worktree; then
		[ "$status" -ne 0 ] || status=1
	fi
	if ! release_lock; then
		[ "$status" -ne 0 ] || status=1
	fi
	exit "$status"
}

trap 'on_exit $?' 0
trap 'exit 1' HUP INT TERM

[ -n "${HOME:-}" ] || fail "HOME is not set"
PATH="$HOME/.cargo/bin${PATH:+:$PATH}"
export PATH

for tool in git bun mktemp readlink; do
	command -v "$tool" >/dev/null 2>&1 || fail "required tool not found: $tool"
done

if command -v shasum >/dev/null 2>&1; then
	sha256_tool=shasum
elif command -v sha256sum >/dev/null 2>&1; then
	sha256_tool=sha256sum
else
	fail "no SHA-256 tool found; install shasum or sha256sum"
fi

sha256_file() {
	case "$sha256_tool" in
		shasum) checksum_output=$(shasum -a 256 "$1") || return 1 ;;
		sha256sum) checksum_output=$(sha256sum "$1") || return 1 ;;
	esac
	set -- $checksum_output
	[ -n "${1:-}" ] || return 1
	printf '%s\n' "$1"
}

repo_root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd -P) || fail "cannot resolve repository root"
git_root=$(git -C "$repo_root" rev-parse --show-toplevel 2>/dev/null) || fail "script is not inside a Git worktree"
git_root=$(CDPATH='' cd -- "$git_root" && pwd -P) || fail "cannot resolve Git worktree root"
[ "$repo_root" = "$git_root" ] || fail "script must run from the repository root"

head_commit=$(git -C "$repo_root" rev-parse --verify HEAD 2>/dev/null) || fail "cannot resolve HEAD"
dirty=$(git -C "$repo_root" status --porcelain=v1 --untracked-files=all) || fail "cannot inspect Git status"
if [ -n "$dirty" ]; then
	printf '%s\n' "$dirty" >&2
	fail "source checkout is dirty; commit or remove all tracked, staged, and untracked changes"
fi

global_bin=${BUN_INSTALL:-"$HOME/.bun"}/bin
case "$global_bin" in
	/*) ;;
	*) fail "Bun install directory must be an absolute path: $global_bin" ;;
esac

agent_dir=${OMP_LOCAL_AGENT_DIR:-${PI_CODING_AGENT_DIR:-"$HOME/.omp/agent"}}
smoke_model=${OMP_LOCAL_SMOKE_MODEL:-@advisor}
smoke_timeout=${OMP_LOCAL_SMOKE_TIMEOUT:-120}
case "$smoke_timeout" in
	''|*[!0-9]*) fail "OMP_LOCAL_SMOKE_TIMEOUT must be a positive integer in seconds" ;;
esac
[ "$smoke_timeout" -gt 0 ] || fail "OMP_LOCAL_SMOKE_TIMEOUT must be a positive integer in seconds"
[ -n "$agent_dir" ] || fail "OMP_LOCAL_AGENT_DIR must not be empty"
[ -n "$smoke_model" ] || fail "OMP_LOCAL_SMOKE_MODEL must not be empty"

temp_base=${TMPDIR:-/tmp}
case "$temp_base" in
	/*) ;;
	*) fail "temporary directory must be an absolute path: $temp_base" ;;
esac
[ -d "$temp_base" ] || fail "temporary directory does not exist: $temp_base"
temp_base=$(CDPATH='' cd -- "$temp_base" && pwd -P) || fail "cannot resolve temporary directory"
build_parent=$(mktemp -d "$temp_base/omp-local-build.XXXXXX") || fail "cannot create disposable build directory"
case "$build_parent/" in
	"$repo_root/"*) fail "disposable build directory must be outside the source checkout" ;;
esac
build_root=$build_parent/worktree
printf '%s: creating disposable worktree for %s\n' "$name" "$head_commit"
git -C "$repo_root" worktree add --detach "$build_root" "$head_commit" >/dev/null ||
	fail "cannot create disposable detached worktree"
worktree_added=1
built=$build_root/packages/coding-agent/dist/omp
# Darwin arm64 builds stage the Swift STT worker beside dist/omp
# (scripts/build-binary.ts); install it with the same atomic pattern so the
# installed omp is never left without its adjacent stt-nemotron worker.
built_worker=$build_root/packages/coding-agent/dist/stt-nemotron

printf '%s: installing frozen dependencies in disposable worktree\n' "$name"
(cd "$build_root" && bun install --frozen-lockfile)
printf '%s: building all workspaces in disposable worktree\n' "$name"
(cd "$build_root" && unset CROSS_TARGET && bun run build)

current_head=$(git -C "$repo_root" rev-parse --verify HEAD 2>/dev/null) || fail "cannot recheck HEAD after build"
[ "$current_head" = "$head_commit" ] || fail "HEAD changed during the build; refusing to install"
dirty=$(git -C "$repo_root" status --porcelain=v1 --untracked-files=all) || fail "cannot recheck Git status after build"
if [ -n "$dirty" ]; then
	printf '%s\n' "$dirty" >&2
	fail "source checkout changed during the build; refusing to install"
fi
[ -f "$built" ] && [ -x "$built" ] || fail "built executable not found: $built"

mkdir -p "$global_bin" || fail "cannot create Bun global bin directory: $global_bin"
global_bin=$(CDPATH='' cd -- "$global_bin" && pwd -P) || fail "cannot resolve Bun global bin directory"
target=$global_bin/omp
backup=$global_bin/omp.backup
worker_target=$global_bin/stt-nemotron
worker_backup=$global_bin/stt-nemotron.backup

install_stage=$(mktemp "$global_bin/.omp.install.XXXXXX") || fail "cannot create install staging file"
cp "$built" "$install_stage" || fail "cannot stage built executable"
chmod +x "$install_stage" || fail "cannot make staged executable runnable"
built_sum=$(sha256_file "$built") || fail "cannot checksum built executable"
staged_sum=$(sha256_file "$install_stage") || fail "cannot checksum staged executable"
[ "$built_sum" = "$staged_sum" ] || fail "staged executable checksum does not match the build"

if [ -f "$built_worker" ]; then
	worker_install_stage=$(mktemp "$global_bin/.stt-nemotron.install.XXXXXX") || fail "cannot create worker staging file"
	cp "$built_worker" "$worker_install_stage" || fail "cannot stage built stt-nemotron worker"
	chmod +x "$worker_install_stage" || fail "cannot make staged worker runnable"
	built_worker_sum=$(sha256_file "$built_worker") || fail "cannot checksum built worker"
	staged_worker_sum=$(sha256_file "$worker_install_stage") || fail "cannot checksum staged worker"
	[ "$built_worker_sum" = "$staged_worker_sum" ] || fail "staged worker checksum does not match the build"
else
	printf '%s: build staged no stt-nemotron worker; installing executable only\n' "$name"
fi

lock_dir=$global_bin/.omp.install-local.lock
if ! mkdir "$lock_dir"; then
	fail "installer lock is held: $lock_dir"
fi
lock_held=1

if [ -e "$target" ] || [ -L "$target" ]; then
	had_target=1
	backup_stage_dir=$(mktemp -d "$global_bin/.omp.backup.XXXXXX") || fail "cannot create backup staging directory"
	backup_stage=$backup_stage_dir/omp
	if [ -L "$target" ]; then
		previous_kind=symlink
		previous_link=$(readlink "$target") || fail "cannot read existing executable symlink"
		ln -s "$previous_link" "$backup_stage" || fail "cannot stage existing executable symlink"
	else
		previous_kind=file
		cp -p "$target" "$backup_stage" || fail "cannot preserve existing executable"
	fi
	mv -f "$backup_stage" "$backup" || fail "cannot install backup: $backup"
	backup_stage=
	rmdir "$backup_stage_dir" || fail "cannot remove backup staging directory"
	backup_stage_dir=
fi
if [ -n "$worker_install_stage" ]; then
	if [ -e "$worker_target" ]; then
		had_worker=1
		cp -p "$worker_target" "$worker_backup" || fail "cannot preserve existing stt-nemotron worker"
	fi
	worker_backup_ready=1
fi
backup_ready=1

if [ -n "$worker_install_stage" ]; then
	mv -f "$worker_install_stage" "$worker_target" || fail "cannot install stt-nemotron worker: $worker_target"
	worker_install_stage=
	installed_worker_sum=$(sha256_file "$worker_target") || fail "cannot checksum installed worker"
	[ "$built_worker_sum" = "$installed_worker_sum" ] || fail "installed worker checksum does not match the build"
fi
mv -f "$install_stage" "$target" || fail "cannot install executable: $target"
install_stage=
installed_sum=$(sha256_file "$target") || fail "cannot checksum installed executable"
[ "$built_sum" = "$installed_sum" ] || fail "installed executable checksum does not match the build"

if ! version_output=$("$target" --version 2>&1); then
	[ -z "$version_output" ] || printf '%s\n' "$version_output" >&2
	fail "installed omp --version failed"
fi
[ -n "$version_output" ] || fail "installed omp --version returned no version"
printf '%s: version smoke passed: %s\n' "$name" "$version_output"

marker=OMP_LOCAL_INSTALL_FLASH_WORKER_OK
prompt="Run one nested agent task with the configured agent named flash-worker. Give it this instruction: Reply with exactly $marker and no other text. You must call the task tool and wait for its result. If the nested result carries $marker, reply with exactly $marker and no other text. Otherwise, fail without printing the marker."
smoke_log=$(mktemp "$global_bin/.omp.smoke.XXXXXX") || fail "cannot create smoke log"
smoke_json=$(mktemp "$global_bin/.omp.smoke-json.XXXXXX") || fail "cannot create smoke event log"
if ! PI_CODING_AGENT_DIR="$agent_dir" PI_NO_TITLE=1 NO_COLOR=1 "$target" --mode json --no-session --no-title --model "$smoke_model" --max-time "$smoke_timeout" -- "$prompt" >"$smoke_json" 2>"$smoke_log"; then
	[ ! -s "$smoke_log" ] || cat "$smoke_log" >&2
	fail "flash-worker smoke command failed"
fi
if ! OMP_LOCAL_SMOKE_JSON="$smoke_json" OMP_LOCAL_SMOKE_MARKER="$marker" bun -e '
const source = await Bun.file(process.env.OMP_LOCAL_SMOKE_JSON).text();
const marker = process.env.OMP_LOCAL_SMOKE_MARKER;
const events = source
	.split(/\r?\n/)
	.filter(line => line.trim().length > 0)
	.map((line, index) => {
		try {
			return JSON.parse(line);
		} catch {
			throw new Error(`invalid JSON event on line ${index + 1}`);
		}
	});
const selectsFlashWorker = args =>
	args?.agent === "flash-worker" ||
	(Array.isArray(args?.tasks) && args.tasks.some(item => item?.agent === "flash-worker"));
const starts = events.filter(
	event => event?.type === "tool_execution_start" && event.toolName === "task" && selectsFlashWorker(event.args),
);
const directResultCarriesMarker = taskEnd => {
	const results = taskEnd.result?.details?.results;
	if (!Array.isArray(results) || results.length !== 1) return false;
	const result = results[0];
	return (
		result?.agent === "flash-worker" &&
		result.exitCode === 0 &&
		result.aborted !== true &&
		!result.error &&
		result.output === marker
	);
};
const asyncResultCarriesMarker = taskEnd => {
	const jobId = taskEnd.result?.details?.async?.jobId;
	if (taskEnd.result?.details?.async?.state !== "running" || typeof jobId !== "string") {
		return false;
	}
	const waitStarts = events.filter(
		event =>
			event?.type === "tool_execution_start" &&
			event.toolName === "hub" &&
			event.args?.op === "wait" &&
			Array.isArray(event.args?.ids) &&
			event.args.ids.length === 1 &&
			event.args.ids[0] === jobId,
	);
	if (waitStarts.length !== 1) return false;
	const waitEnds = events.filter(
		event =>
			event?.type === "tool_execution_end" &&
			event.toolName === "hub" &&
			event.toolCallId === waitStarts[0].toolCallId &&
			event.isError !== true,
	);
	if (waitEnds.length !== 1) return false;
	const jobs = waitEnds[0].result?.details?.jobs;
	if (!Array.isArray(jobs) || jobs.length !== 1) return false;
	const job = jobs[0];
	if (
		job?.id !== jobId ||
		job.status !== "completed" ||
		job.error ||
		typeof job.resultText !== "string" ||
		job.resultText.split(marker).length !== 2
	) {
		return false;
	}
	const taskResultTags = job.resultText.match(/<task-result\b[^>]*>/g) ?? [];
	const outputMatches = [...job.resultText.matchAll(/<output>\r?\n([\s\S]*?)\r?\n<\/output>/g)];
	return (
		taskResultTags.length === 1 &&
		/\bagent="flash-worker"/.test(taskResultTags[0]) &&
		/\bstatus="completed"/.test(taskResultTags[0]) &&
		outputMatches.length === 1 &&
		outputMatches[0][1] === marker
	);
};
const taskEnds =
	starts.length === 1
		? events.filter(
				event =>
					event?.type === "tool_execution_end" &&
					event.toolName === "task" &&
					event.toolCallId === starts[0].toolCallId &&
					event.isError !== true,
			)
		: [];
const provedNestedRun =
	taskEnds.length === 1 && (directResultCarriesMarker(taskEnds[0]) || asyncResultCarriesMarker(taskEnds[0]));
if (!provedNestedRun) {
	throw new Error("no successful flash-worker task event carried the marker");
}
const finalMessage = events
	.filter(event => event?.type === "message_end" && event.message?.role === "assistant")
	.at(-1)?.message;
const finalText = Array.isArray(finalMessage?.content)
	? finalMessage.content
			.filter(part => part?.type === "text" && typeof part.text === "string")
			.map(part => part.text)
			.join("")
	: "";
if (finalText !== marker) {
	throw new Error("final assistant text did not exactly match the marker");
}
' 2>>"$smoke_log"; then
	[ ! -s "$smoke_log" ] || cat "$smoke_log" >&2
	fail "flash-worker smoke JSON proof failed"
fi

if ! cleanup_worktree; then
	fail "disposable worktree cleanup failed"
fi
backup_ready=0
if ! release_lock; then
	backup_ready=1
	fail "installer lock cleanup failed"
fi
if [ "$had_target" -eq 1 ]; then
	printf '%s: installed %s (sha256 %s); previous executable: %s\n' "$name" "$target" "$installed_sum" "$backup"
else
	printf '%s: installed %s (sha256 %s); no previous executable to back up\n' "$name" "$target" "$installed_sum"
fi
if [ -n "$installed_worker_sum" ]; then
	printf '%s: installed %s (sha256 %s)\n' "$name" "$worker_target" "$installed_worker_sum"
fi

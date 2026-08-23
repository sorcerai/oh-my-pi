#!/bin/sh
set -e

# OMP Coding Agent Installer
# Usage: curl -fsSL https://raw.githubusercontent.com/can1357/oh-my-pi/main/scripts/install.sh | sh
#
# Options:
#   --source       Install via bun (installs bun if needed)
#   --binary       Always install prebuilt binary
#   --ref <ref>    Install specific tag/commit/branch
#   -r <ref>       Shorthand for --ref

REPO="can1357/oh-my-pi"
PACKAGE="@oh-my-pi/pi-coding-agent"
INSTALL_DIR="${PI_INSTALL_DIR:-$HOME/.local/bin}"
MIN_BUN_VERSION="1.3.14"

# Parse arguments
MODE=""
REF=""
while [ $# -gt 0 ]; do
    case "$1" in
        --source)
            MODE="source"
            shift
            ;;
        --binary)
            MODE="binary"
            shift
            ;;
        --ref)
            shift
            if [ -z "$1" ]; then
                echo "Missing value for --ref"
                exit 1
            fi
            REF="$1"
            shift
            ;;
        --ref=*)
            REF="${1#*=}"
            if [ -z "$REF" ]; then
                echo "Missing value for --ref"
                exit 1
            fi
            shift
            ;;
        -r)
            shift
            if [ -z "$1" ]; then
                echo "Missing value for -r"
                exit 1
            fi
            REF="$1"
            shift
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

# If a ref is provided, default to source install
if [ -n "$REF" ] && [ -z "$MODE" ]; then
    MODE="source"
fi

# Check if bun is available
has_bun() {
    command -v bun >/dev/null 2>&1
}

# Normalized host architecture (x64|arm64). On macOS this uses
# `sysctl hw.optional.arm64` so it stays correct inside a Rosetta session,
# where `uname -m` reports the translated x86_64.
host_arch() {
    if [ "$(uname -s)" = "Darwin" ]; then
        if [ "$(sysctl -in hw.optional.arm64 2>/dev/null || /usr/sbin/sysctl -in hw.optional.arm64 2>/dev/null)" = "1" ]; then
            echo "arm64"
        else
            echo "x64"
        fi
        return
    fi
    case "$(uname -m)" in
        x86_64|amd64)  echo "x64" ;;
        arm64|aarch64) echo "arm64" ;;
        *)             uname -m ;;
    esac
}

# Bun's own architecture (x64|arm64), or empty when it can't be determined.
bun_arch() {
    bun -e 'process.stdout.write(process.arch)' 2>/dev/null
}

# True when Bun's architecture matches the host. If Bun's arch can't be read,
# assume a match rather than block the install.
bun_arch_matches_host() {
    ba="$(bun_arch)"
    [ -z "$ba" ] && return 0
    [ "$ba" = "$(host_arch)" ]
}

version_ge() {
    current="$1"
    minimum="$2"

    current_major="${current%%.*}"
    current_rest="${current#*.}"
    current_minor="${current_rest%%.*}"
    current_patch="${current_rest#*.}"
    current_patch="${current_patch%%.*}"

    minimum_major="${minimum%%.*}"
    minimum_rest="${minimum#*.}"
    minimum_minor="${minimum_rest%%.*}"
    minimum_patch="${minimum_rest#*.}"
    minimum_patch="${minimum_patch%%.*}"

    if [ "$current_major" -ne "$minimum_major" ]; then
        [ "$current_major" -gt "$minimum_major" ]
        return $?
    fi

    if [ "$current_minor" -ne "$minimum_minor" ]; then
        [ "$current_minor" -gt "$minimum_minor" ]
        return $?
    fi

    [ "$current_patch" -ge "$minimum_patch" ]
}

require_bun_version() {
    version_raw=$(bun --version 2>/dev/null || true)
    if [ -z "$version_raw" ]; then
        echo "Failed to read bun version"
        exit 1
    fi

    version_clean=${version_raw%%-*}
    if ! version_ge "$version_clean" "$MIN_BUN_VERSION"; then
        echo "Bun ${MIN_BUN_VERSION} or newer is required. Current version: ${version_clean}"
        echo "Upgrade Bun at https://bun.sh/docs/installation"
        exit 1
    fi
}

# Check if git is available
has_git() {
    command -v git >/dev/null 2>&1
}

# Install bun
install_bun() {
    echo "Installing bun..."
    if command -v bash >/dev/null 2>&1; then
        curl -fsSL https://bun.sh/install | bash
    else
        echo "bash not found; attempting install with sh..."
        curl -fsSL https://bun.sh/install | sh
    fi
    export BUN_INSTALL="$HOME/.bun"
    export PATH="$BUN_INSTALL/bin:$PATH"
    require_bun_version
}

# Check if git-lfs is available
has_git_lfs() {
    command -v git-lfs >/dev/null 2>&1
}

# Install via bun
install_via_bun() {
    echo "Installing via bun..."
    if [ -n "$REF" ]; then
        if ! has_git; then
            echo "git is required for --ref when installing from source"
            exit 1
        fi

        TMP_DIR="$(mktemp -d)"
        trap 'rm -rf "$TMP_DIR"' EXIT

        if git clone --depth 1 --branch "$REF" "https://github.com/${REPO}.git" "$TMP_DIR" >/dev/null 2>&1; then
            :
        else
            git clone "https://github.com/${REPO}.git" "$TMP_DIR"
            (cd "$TMP_DIR" && git checkout "$REF")
        fi

        # Pull LFS files
        if has_git_lfs; then
            (cd "$TMP_DIR" && git lfs pull)
        fi

        if [ ! -d "$TMP_DIR/packages/coding-agent" ]; then
            echo "Expected package at ${TMP_DIR}/packages/coding-agent"
            exit 1
        fi

        bun install -g "$TMP_DIR/packages/coding-agent" || {
            echo "Failed to install from source"
            exit 1
        }
    else
        bun install -g "$PACKAGE" || {
            echo "Failed to install $PACKAGE"
            exit 1
        }
    fi
    echo ""
    echo "✓ Installed omp via bun"
    echo "Run 'omp' to get started!"
}

# Install binary from GitHub releases
install_binary() {
    # Detect platform
    OS="$(uname -s)"
    ARCH="$(host_arch)"

    case "$OS" in
        Linux)  PLATFORM="linux" ;;
        Darwin) PLATFORM="darwin" ;;
        *)      echo "Unsupported OS: $OS"; exit 1 ;;
    esac

    case "$ARCH" in
        x64|arm64) ;;
        *)         echo "Unsupported architecture: $ARCH"; exit 1 ;;
    esac

    if [ "$PLATFORM" = "linux" ]; then
        if [ -f /etc/alpine-release ] || { command -v ldd >/dev/null 2>&1 && ldd --version 2>&1 | grep -qi musl; }; then
            PLATFORM="linux-musl"
        fi
    fi

    BINARY="omp-${PLATFORM}-${ARCH}"
    # Get release tag
    if [ -n "$REF" ]; then
        echo "Fetching release $REF..."
        if RELEASE_JSON=$(curl -fsSL --connect-timeout 10 --max-time 60 "https://api.github.com/repos/${REPO}/releases/tags/${REF}"); then
            LATEST=$(echo "$RELEASE_JSON" | grep '"tag_name"' | sed -E 's/.*"([^"]+)".*/\1/')
        else
            echo "Release tag not found: $REF"
            echo "For branch/commit installs, use --source with --ref."
            exit 1
        fi
    else
        echo "Fetching latest release..."
        RELEASE_JSON=$(curl -fsSL --connect-timeout 10 --max-time 60 "https://api.github.com/repos/${REPO}/releases/latest")
        LATEST=$(echo "$RELEASE_JSON" | grep '"tag_name"' | sed -E 's/.*"([^"]+)".*/\1/')
    fi

    if [ -z "$LATEST" ]; then
        echo "Failed to fetch release tag"
        exit 1
    fi
    echo "Using version: $LATEST"

    mkdir -p "$INSTALL_DIR"

    # Stage every download as a temp file INSIDE the install dir (same
    # filesystem, so the final renames are atomic). Nothing is renamed into
    # place until all downloads succeeded, so a failed fetch can never leave
    # a workerless omp — or touch existing files at all.
    OMP_STAGE="$(mktemp "${INSTALL_DIR}/.omp.install.XXXXXX")"
    WORKER_STAGE=""

    # Download binary
    BINARY_URL="https://github.com/${REPO}/releases/download/${LATEST}/${BINARY}"
    echo "Downloading ${BINARY}..."
    if ! curl -fsSL --connect-timeout 10 --speed-limit 1024 --speed-time 30 "$BINARY_URL" -o "$OMP_STAGE"; then
        rm -f "$OMP_STAGE"
        echo "Failed to download ${BINARY}"
        exit 1
    fi
    chmod +x "$OMP_STAGE"
    [ -s "$OMP_STAGE" ] || { rm -f "$OMP_STAGE"; echo "Downloaded ${BINARY} is empty"; exit 1; }

    # Darwin arm64 releases may ship the Nemotron STT worker as a separate
    # asset. Older releases predate that asset; keep them installable and let
    # the runtime use its Bun transport fallback when the metadata omits it.
    if [ "$PLATFORM" = "darwin" ] && [ "$ARCH" = "arm64" ]; then
        WORKER="omp-stt-nemotron-${PLATFORM}-${ARCH}"
        if echo "$RELEASE_JSON" | grep -q "\"${WORKER}\""; then
            WORKER_URL="https://github.com/${REPO}/releases/download/${LATEST}/${WORKER}"
            WORKER_STAGE="$(mktemp "${INSTALL_DIR}/.stt-nemotron.install.XXXXXX")"
            echo "Downloading ${WORKER}..."
            if ! curl -fsSL --connect-timeout 10 --speed-limit 1024 --speed-time 30 "$WORKER_URL" -o "$WORKER_STAGE"; then
                rm -f "$OMP_STAGE" "$WORKER_STAGE"
                echo "Failed to download ${WORKER}"
                exit 1
            fi
            chmod +x "$WORKER_STAGE"
            [ -s "$WORKER_STAGE" ] || { rm -f "$OMP_STAGE" "$WORKER_STAGE"; echo "Downloaded ${WORKER} is empty"; exit 1; }
        else
            echo "Release ${LATEST} has no ${WORKER}; installing omp without the native speech worker."
        fi
    fi

    # Preserve existing entries with same-directory moves. The -L check keeps
    # dangling symlinks in the transaction, too.
    OMP_BACKUP=""
    WORKER_BACKUP=""
    OMP_OLD_PRESENT=""
    WORKER_OLD_PRESENT=""
    OMP_BACKUP_MOVED=""
    WORKER_BACKUP_MOVED=""
    OMP_MUTATION_STARTED=""
    WORKER_MUTATION_STARTED=""
    TRANSACTION_ACTIVE=""
    TRANSACTION_ROLLING_BACK=""
    ROLLBACK_FAILED=""

    transaction_entry_exists() {
        [ -e "$1" ] || [ -L "$1" ]
    }

    if transaction_entry_exists "${INSTALL_DIR}/omp"; then
        OMP_OLD_PRESENT=1
    fi
    if [ -n "$WORKER_STAGE" ] &&
        transaction_entry_exists "${INSTALL_DIR}/stt-nemotron"; then
        WORKER_OLD_PRESENT=1
    fi

    rollback_transaction() {
        ROLLBACK_FAILED=""
        TRANSACTION_ROLLING_BACK=1
        TRANSACTION_ACTIVE=""
        trap - 0
        # Finish both restores after the first signal. A second signal must not
        # interrupt rollback and leave only half of the previous pair.
        trap '' HUP INT TERM

        # A signal can interrupt mv after it moved the entry but before the
        # success assignment. Infer that state from the same-directory paths.
        if [ "$WORKER_BACKUP_MOVED" != 1 ] &&
            [ "$WORKER_OLD_PRESENT" = 1 ] &&
            ! transaction_entry_exists "${INSTALL_DIR}/stt-nemotron" &&
            transaction_entry_exists "$WORKER_BACKUP"; then
            WORKER_BACKUP_MOVED=1
        fi
        if [ "$OMP_BACKUP_MOVED" != 1 ] &&
            [ "$OMP_OLD_PRESENT" = 1 ] &&
            ! transaction_entry_exists "${INSTALL_DIR}/omp" &&
            transaction_entry_exists "$OMP_BACKUP"; then
            OMP_BACKUP_MOVED=1
        fi

        # Restore each entry independently. Clear state after every successful
        # operation so rollback stays idempotent.
        if [ "$WORKER_BACKUP_MOVED" = 1 ]; then
            if rm -f "${INSTALL_DIR}/stt-nemotron" &&
                mv -f "$WORKER_BACKUP" "${INSTALL_DIR}/stt-nemotron"; then
                WORKER_BACKUP_MOVED=""
                WORKER_MUTATION_STARTED=""
            else
                ROLLBACK_FAILED=1
            fi
        elif [ "$WORKER_MUTATION_STARTED" = 1 ]; then
            if rm -f "${INSTALL_DIR}/stt-nemotron"; then
                WORKER_MUTATION_STARTED=""
            else
                ROLLBACK_FAILED=1
            fi
        fi
        if [ "$OMP_BACKUP_MOVED" = 1 ]; then
            if rm -f "${INSTALL_DIR}/omp" &&
                mv -f "$OMP_BACKUP" "${INSTALL_DIR}/omp"; then
                OMP_BACKUP_MOVED=""
                OMP_MUTATION_STARTED=""
            else
                ROLLBACK_FAILED=1
            fi
        elif [ "$OMP_MUTATION_STARTED" = 1 ]; then
            if rm -f "${INSTALL_DIR}/omp"; then
                OMP_MUTATION_STARTED=""
            else
                ROLLBACK_FAILED=1
            fi
        fi

        [ -z "$OMP_STAGE" ] || rm -f "$OMP_STAGE" || ROLLBACK_FAILED=1
        [ -z "$WORKER_STAGE" ] || rm -f "$WORKER_STAGE" || ROLLBACK_FAILED=1
        if [ "$OMP_BACKUP_MOVED" != 1 ] && [ -n "$OMP_BACKUP" ]; then
            rm -f "$OMP_BACKUP" || ROLLBACK_FAILED=1
        fi
        if [ "$WORKER_BACKUP_MOVED" != 1 ] && [ -n "$WORKER_BACKUP" ]; then
            rm -f "$WORKER_BACKUP" || ROLLBACK_FAILED=1
        fi

        TRANSACTION_ROLLING_BACK=""
        [ -z "$ROLLBACK_FAILED" ]
    }

    transaction_finish() {
        TRANSACTION_ACTIVE=""
        trap - HUP INT TERM 0
    }

    transaction_abort() {
        transaction_status=$1
        if [ -z "$TRANSACTION_ACTIVE" ]; then
            return 0
        fi
        if [ "$TRANSACTION_ROLLING_BACK" = 1 ]; then
            exit "$transaction_status"
        fi
        if ! rollback_transaction; then
            :
        fi
        if [ -n "$ROLLBACK_FAILED" ] && [ "$transaction_status" -eq 0 ]; then
            transaction_status=1
        fi
        transaction_finish
        exit "$transaction_status"
    }

    # The traps remain active from the first backup move through smoke. This
    # also catches set -e exits in the mutation window.
    TRANSACTION_ACTIVE=1
    trap 'transaction_abort 129' HUP
    trap 'transaction_abort 130' INT
    trap 'transaction_abort 143' TERM
    trap 'transaction_abort $?' 0

    install_failed=""
    if [ "$WORKER_OLD_PRESENT" = 1 ]; then
        if WORKER_BACKUP="$(mktemp "${INSTALL_DIR}/.stt-nemotron.backup.XXXXXX")"; then
            if mv -f "${INSTALL_DIR}/stt-nemotron" "$WORKER_BACKUP"; then
                WORKER_BACKUP_MOVED=1
            else
                install_failed="stt-nemotron worker backup"
            fi
        else
            install_failed="stt-nemotron worker backup"
        fi
    fi
    if [ -z "$install_failed" ] && [ "$OMP_OLD_PRESENT" = 1 ]; then
        if OMP_BACKUP="$(mktemp "${INSTALL_DIR}/.omp.backup.XXXXXX")"; then
            if mv -f "${INSTALL_DIR}/omp" "$OMP_BACKUP"; then
                OMP_BACKUP_MOVED=1
            else
                install_failed="omp backup"
            fi
        else
            install_failed="omp backup"
        fi
    fi

    # Paired rename: worker first, then omp. The rollback path above handles
    # backup, rename, signal, and smoke failures.
    if [ -z "$install_failed" ] && [ -n "$WORKER_STAGE" ]; then
        WORKER_MUTATION_STARTED=1
        if ! mv -f "$WORKER_STAGE" "${INSTALL_DIR}/stt-nemotron"; then
            install_failed="stt-nemotron worker"
        fi
    fi
    if [ -z "$install_failed" ]; then
        OMP_MUTATION_STARTED=1
        if ! mv -f "$OMP_STAGE" "${INSTALL_DIR}/omp"; then
            install_failed="omp"
        fi
    fi
    if [ -n "$install_failed" ]; then
        echo "✗ Failed to install the ${install_failed}; rolling back."
        if ! rollback_transaction; then
            :
        fi
        if [ -n "$ROLLBACK_FAILED" ]; then
            echo "✗ Rollback was incomplete; inspect ${INSTALL_DIR}."
        fi
        transaction_finish
        exit 1
    fi

    # Verify the freshly installed binary can actually start before reporting
    # success. Bun's musl-target binaries link libstdc++/libgcc dynamically,
    # which stock Alpine/musl systems do not ship, so the download succeeds while
    # the binary exits 127 with relocation errors. Never claim success for a
    # binary that cannot run — and never leave a half-installed pair behind.
    if ! SMOKE_OUTPUT="$("${INSTALL_DIR}/omp" --version 2>&1)"; then
        echo ""
        echo "✗ omp was installed to ${INSTALL_DIR}/omp but cannot start:"
        echo "$SMOKE_OUTPUT" | sed 's/^/    /'
        if ! rollback_transaction; then
            :
        fi
        if [ "$PLATFORM" = "linux-musl" ]; then
            echo ""
            echo "The musl build links libstdc++/libgcc dynamically. Install them, then re-run 'omp':"
            if command -v apk >/dev/null 2>&1; then
                echo "    apk add libstdc++ libgcc"
            else
                echo "    (install the libstdc++ and libgcc runtime packages for your distro)"
            fi
        fi
        echo ""
        if [ -n "$ROLLBACK_FAILED" ]; then
            echo "Rollback was incomplete; inspect ${INSTALL_DIR}."
        else
            echo "Rolled back; previous files (if any) were restored."
        fi
        transaction_finish
        exit 1
    fi

    # Smoke passed, so the new pair is committed. Disable rollback before
    # deleting backups: once one backup is gone, rolling back can destroy the
    # only valid installed copy.
    transaction_finish
    cleanup_failed=""
    [ -z "$OMP_BACKUP" ] || rm -f "$OMP_BACKUP" || cleanup_failed=1
    [ -z "$WORKER_BACKUP" ] || rm -f "$WORKER_BACKUP" || cleanup_failed=1
    if [ -n "$cleanup_failed" ]; then
        echo "✗ Installed successfully, but backup cleanup was incomplete; inspect ${INSTALL_DIR}."
        exit 1
    fi

    echo ""
    echo "✓ Installed omp to ${INSTALL_DIR}/omp"
    if [ -n "$WORKER_STAGE" ]; then
        echo "✓ Installed stt-nemotron speech worker to ${INSTALL_DIR}/stt-nemotron"
    fi

    # Check if in PATH
    case ":$PATH:" in
        *":$INSTALL_DIR:"*) echo "Run 'omp' to get started!" ;;
        *) echo "Add ${INSTALL_DIR} to your PATH, then run 'omp'" ;;
    esac
}

# Main logic
case "$MODE" in
    source)
        if ! has_bun; then
            install_bun
        fi
        require_bun_version
        if ! bun_arch_matches_host; then
            echo "Error: bun reports architecture '$(bun_arch)' but this host is '$(host_arch)'."
            echo "Installing from source with this bun would produce a mismatched binary"
            echo "(e.g. x86_64 under Rosetta on Apple Silicon), causing slow startup and AVX warnings."
            echo "Install a native bun for your architecture, or re-run without --source to fetch the prebuilt $(host_arch) binary."
            exit 1
        fi
        install_via_bun
        ;;
    binary)
        install_binary
        ;;
    *)
        # Default: use bun only when it matches the host architecture, otherwise
        # fall back to the prebuilt binary so Rosetta bun can't force an x86_64 build.
        if has_bun && bun_arch_matches_host; then
            require_bun_version
            install_via_bun
        else
            if has_bun; then
                echo "Detected bun with architecture '$(bun_arch)' on a '$(host_arch)' host; using the prebuilt binary instead."
            fi
            install_binary
        fi
        ;;
esac

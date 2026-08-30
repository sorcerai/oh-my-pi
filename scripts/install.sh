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
            LATEST=$(printf '%s\n' "$RELEASE_JSON" | sed -nE 's/.*"tag_name"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p')
        else
            echo "Release tag not found: $REF"
            echo "For branch/commit installs, use --source with --ref."
            exit 1
        fi
    else
        echo "Fetching latest release..."
        RELEASE_JSON=$(curl -fsSL --connect-timeout 10 --max-time 60 "https://api.github.com/repos/${REPO}/releases/latest")
        LATEST=$(printf '%s\n' "$RELEASE_JSON" | sed -nE 's/.*"tag_name"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p')
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
    OMP_BACKUP=""
    WORKER_BACKUP=""

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

    # Preserve any existing files so the post-install smoke below can roll
    # the whole pair back if the new binary cannot start.
    if [ -e "${INSTALL_DIR}/omp" ]; then
        OMP_BACKUP="$(mktemp "${INSTALL_DIR}/.omp.backup.XXXXXX")"
        cp -p "${INSTALL_DIR}/omp" "$OMP_BACKUP"
    fi
    if [ -n "$WORKER_STAGE" ] && [ -e "${INSTALL_DIR}/stt-nemotron" ]; then
        WORKER_BACKUP="$(mktemp "${INSTALL_DIR}/.stt-nemotron.backup.XXXXXX")"
        cp -p "${INSTALL_DIR}/stt-nemotron" "$WORKER_BACKUP"
    fi

    # Paired rename: worker first, then omp. A worker-side failure aborts
    # before the omp binary is touched; any rename failure restores the
    # previous pair exactly instead of exiting mid-swap via set -e.
    install_failed=""
    if [ -n "$WORKER_STAGE" ]; then
        if ! mv -f "$WORKER_STAGE" "${INSTALL_DIR}/stt-nemotron"; then
            install_failed="stt-nemotron worker"
        fi
    fi
    if [ -z "$install_failed" ]; then
        if ! mv -f "$OMP_STAGE" "${INSTALL_DIR}/omp"; then
            install_failed="omp"
        fi
    fi
    if [ -n "$install_failed" ]; then
        echo "✗ Failed to install the ${install_failed}; rolling back."
        rollback_failed=""
        if [ -n "$WORKER_STAGE" ]; then
            # The worker rename may have succeeded before the failure — undo it.
            if [ -n "$WORKER_BACKUP" ]; then
                mv -f "$WORKER_BACKUP" "${INSTALL_DIR}/stt-nemotron" || rollback_failed=1
            else
                rm -f "${INSTALL_DIR}/stt-nemotron" || rollback_failed=1
            fi
        fi
        # omp was never renamed on a worker failure; on an omp-rename failure
        # its destination is unchanged, so restoring the backup is a no-op of
        # identical bytes and keeps a fresh-install dir clean.
        if [ -n "$OMP_BACKUP" ]; then
            mv -f "$OMP_BACKUP" "${INSTALL_DIR}/omp" || rollback_failed=1
        fi
        [ -z "$OMP_STAGE" ] || rm -f "$OMP_STAGE" || rollback_failed=1
        [ -z "$WORKER_STAGE" ] || rm -f "$WORKER_STAGE" || rollback_failed=1
        [ -z "$rollback_failed" ] || echo "✗ Rollback was incomplete; inspect ${INSTALL_DIR}."
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
        rollback_failed=""
        if [ -n "$OMP_BACKUP" ]; then
            mv -f "$OMP_BACKUP" "${INSTALL_DIR}/omp" || rollback_failed=1
        else
            rm -f "${INSTALL_DIR}/omp" || rollback_failed=1
        fi
        if [ -n "$WORKER_STAGE" ] || [ -n "$WORKER_BACKUP" ]; then
            if [ -n "$WORKER_BACKUP" ]; then
                mv -f "$WORKER_BACKUP" "${INSTALL_DIR}/stt-nemotron" || rollback_failed=1
            else
                rm -f "${INSTALL_DIR}/stt-nemotron" || rollback_failed=1
            fi
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
        if [ -n "$rollback_failed" ]; then
            echo "Rollback was incomplete; inspect ${INSTALL_DIR}."
        else
            echo "Rolled back; previous files (if any) were restored."
        fi
        exit 1
    fi

    [ -z "$OMP_BACKUP" ] || rm -f "$OMP_BACKUP"
    [ -z "$WORKER_BACKUP" ] || rm -f "$WORKER_BACKUP"

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

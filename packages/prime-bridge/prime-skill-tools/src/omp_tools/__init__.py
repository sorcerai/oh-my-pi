"""Session-scoped OMP tool access through Prime's native MCP integration."""

from __future__ import annotations

import json
import os
from pathlib import Path
from urllib.parse import quote, urlsplit

from rlm import McpIntegration, NotEnabled

__all__ = ["OmpTools", "connect", "omp_tools"]

_DEFAULT_CONFIG_PATH = Path("~/.prime/agent/omp-bridge.json")
_URL_ENV = "OMP_PRIME_BRIDGE_URL"
_TOKEN_FILE_ENV = "OMP_PRIME_BRIDGE_TOKEN_FILE"


def _string_field(value: object, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"bridge config field {field!r} must be a non-empty string")
    return value.strip()


def _bridge_url(value: str) -> str:
    try:
        parsed = urlsplit(value)
        hostname = parsed.hostname
        parsed.port
    except ValueError as error:
        raise ValueError("bridge URL is invalid") from error
    if (
        parsed.scheme != "http"
        or hostname is None
        or hostname.lower() not in {"127.0.0.1", "localhost"}
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path not in {"", "/"}
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("bridge URL must be plain loopback HTTP")
    return value.rstrip("/")


def _read_pointer(path: Path) -> dict[str, object]:
    try:
        value = json.loads(path.expanduser().read_text(encoding="utf-8"))
    except OSError as error:
        raise ValueError(f"unable to read bridge config: {path.expanduser()}") from error
    except json.JSONDecodeError as error:
        raise ValueError(f"bridge config is not valid JSON: {path.expanduser()}") from error
    if not isinstance(value, dict):
        raise ValueError("bridge config must be a JSON object")
    return value


def _discover_config(config_path: str | os.PathLike[str] | None) -> tuple[str, Path]:
    env_url = os.environ.get(_URL_ENV, "").strip()
    env_token_file = os.environ.get(_TOKEN_FILE_ENV, "").strip()
    pointer: dict[str, object] = {}
    if not env_url or not env_token_file:
        pointer = _read_pointer(Path(config_path or _DEFAULT_CONFIG_PATH))
    url = _bridge_url(env_url or _string_field(pointer.get("url"), "url"))
    token_file = Path(env_token_file or _string_field(pointer.get("tokenFile"), "tokenFile")).expanduser()
    return url, token_file


def _validate_session_id(session_id: str) -> str:
    try:
        utf16_units = len(session_id.encode("utf-16-le")) // 2
    except (AttributeError, UnicodeEncodeError) as error:
        raise ValueError("session ID must be valid Unicode") from error
    if not session_id or utf16_units > 256 or "/" in session_id:
        raise ValueError("session ID must be 1-256 UTF-16 code units and must not contain '/'")
    return session_id


class OmpTools(McpIntegration):
    """Prime MCP integration for the tools registered by one live OMP session."""

    server = "omp-tools"
    url: str | None = None

    def __init__(self) -> None:
        super().__init__()
        self._bridge_token_file: Path | None = None

    def connect(
        self,
        session_id: str,
        *,
        config_path: str | os.PathLike[str] | None = None,
    ) -> "OmpTools":
        """Return an integration connected to one validated OMP session."""
        _validate_session_id(session_id)
        base_url, token_file = _discover_config(config_path)
        integration = type(self)()
        integration.url = f"{base_url}/mcp/v1/sessions/{quote(session_id, safe='')}"
        integration._bridge_token_file = token_file
        return integration

    async def _resolve_config(self) -> tuple[str | None, dict[str, str]]:
        if self.url is None or self._bridge_token_file is None:
            raise ValueError("call connect(session_id) before using OmpTools")
        return self.url, {}

    async def _resolve_token(self) -> str:
        if self._bridge_token_file is None:
            raise NotEnabled(self.server)
        try:
            token = self._bridge_token_file.read_text(encoding="utf-8").strip()
        except OSError as error:
            raise RuntimeError("unable to read OMP bridge token file") from error
        if not token:
            raise RuntimeError("OMP bridge token file is empty")
        return token


omp_tools = OmpTools()


def connect(
    session_id: str,
    *,
    config_path: str | os.PathLike[str] | None = None,
) -> OmpTools:
    """Connect to a live OMP session using the bridge pointer configuration."""
    return omp_tools.connect(session_id, config_path=config_path)


_RESERVED = {"run", "__wrapped__", "__call__"}


def __getattr__(name: str):
    if name.startswith("_") or name in _RESERVED:
        raise AttributeError(name)
    return getattr(omp_tools, name)

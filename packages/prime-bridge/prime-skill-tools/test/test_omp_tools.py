from __future__ import annotations

import asyncio
import json
import sys
import tempfile
import types
import unittest
from contextlib import AsyncExitStack
from pathlib import Path
from unittest.mock import patch

PACKAGE_SRC = Path(__file__).parents[1] / "src"
sys.path.insert(0, str(PACKAGE_SRC))


class FakeNotEnabled(RuntimeError):
    pass


class FakeMcpToolError(RuntimeError):
    pass


def fake_parse_result(result):
    texts = [block.text for block in getattr(result, "content", None) or [] if getattr(block, "text", None) is not None]
    if getattr(result, "isError", False):
        raise FakeMcpToolError("\n".join(texts) or "MCP tool returned an error")
    structured = getattr(result, "structuredContent", None)
    if structured is not None:
        return structured
    return "\n".join(texts) if texts else result


fake_mcp_base = types.ModuleType("rlm.mcp_base")
fake_mcp_base.McpToolError = FakeMcpToolError
fake_mcp_base.NotEnabled = FakeNotEnabled
fake_mcp_base._resolve_streamable_http = lambda: None


class FakeMcpIntegration:
    server = ""
    url = None

    def __init__(self):
        if not self.server:
            raise ValueError("server is required")
        self._tools = None

    async def _open_session(self, stack):
        url, extra_headers = await self._resolve_config()
        token = await self._resolve_token()
        transport = fake_mcp_base._resolve_streamable_http()
        cm = transport(url, headers={**extra_headers, "Authorization": f"Bearer {token}"})
        read, write, *_ = await stack.enter_async_context(cm)
        session = await stack.enter_async_context(sys.modules["mcp"].ClientSession(read, write))
        await session.initialize()
        return session

    async def list_tools(self):
        await self._ensure_tools()
        return [dict(tool) for tool in (self._tools or {}).values()]

    async def _ensure_tools(self):
        if self._tools is not None:
            return
        async with AsyncExitStack() as stack:
            session = await self._open_session(stack)
            response = await session.list_tools()
            self._tools = {
                tool.name: {
                    "name": tool.name,
                    "description": getattr(tool, "description", "") or "",
                    "inputSchema": getattr(tool, "inputSchema", None) or {},
                }
                for tool in response.tools
            }

    async def call_tool(self, tool, arguments=None):
        async with AsyncExitStack() as stack:
            session = await self._open_session(stack)
            result = await session.call_tool(tool, arguments or {})
        return fake_parse_result(result)

    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)

        async def call(**kwargs):
            await self._ensure_tools()
            if self._tools is not None and name not in self._tools:
                raise AttributeError(name)
            return await self.call_tool(name, kwargs)

        return call


fake_rlm = types.ModuleType("rlm")
fake_rlm.McpIntegration = FakeMcpIntegration
fake_rlm.NotEnabled = FakeNotEnabled
fake_rlm.mcp_base = fake_mcp_base
sys.modules["rlm"] = fake_rlm
sys.modules["rlm.mcp_base"] = fake_mcp_base

from rlm import mcp_base  # noqa: E402
from rlm.mcp_base import McpToolError  # noqa: E402
from omp_tools import OmpTools, connect, omp_tools  # noqa: E402


def run(coro):
    return asyncio.run(coro)


class FakeSession:
    def __init__(self, *, tools=None, result=None):
        self.tools = tools or []
        self.result = result
        self.calls = []

    async def initialize(self):
        return None

    async def list_tools(self):
        Tool = type("Tool", (), {})
        response = type("Response", (), {})()
        response.tools = []
        for name, description, schema in self.tools:
            tool = Tool()
            tool.name = name
            tool.description = description
            tool.inputSchema = schema
            response.tools.append(tool)
        return response

    async def call_tool(self, name, arguments):
        self.calls.append((name, arguments))
        return self.result


class OmpToolsTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.token_path = self.root / "token"
        self.token_path.write_text("bridge-secret\n", encoding="utf-8")
        self.pointer_path = self.root / "omp-bridge.json"
        self.pointer_path.write_text(
            json.dumps({"url": "http://127.0.0.1:3210/", "tokenFile": str(self.token_path)}),
            encoding="utf-8",
        )

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_identity_uses_omp_tools_server_name(self):
        self.assertEqual(OmpTools.server, "omp-tools")
        self.assertEqual(omp_tools.server, "omp-tools")
        self.assertIsInstance(omp_tools, OmpTools)

    def test_connect_quotes_valid_session_id(self):
        integration = OmpTools().connect("prime session?#", config_path=self.pointer_path)
        self.assertEqual(
            integration.url,
            "http://127.0.0.1:3210/mcp/v1/sessions/prime%20session%3F%23",
        )

    def test_connect_rejects_invalid_session_id(self):
        for session_id in ("", "contains/slash", "bad\ud800", "x" * 257):
            with self.subTest(session_id=session_id):
                with self.assertRaises(ValueError):
                    OmpTools().connect(session_id, config_path=self.pointer_path)

    def test_connect_resolves_loopback_url_and_bearer_header_config(self):
        integration = OmpTools().connect("session-a", config_path=self.pointer_path)
        url, headers = run(integration._resolve_config())
        self.assertEqual(url, "http://127.0.0.1:3210/mcp/v1/sessions/session-a")
        self.assertEqual(headers, {})
        self.assertEqual(run(integration._resolve_token()), "bridge-secret")
    def test_connect_accepts_128_emoji_utf16_units(self):
        integration = OmpTools().connect("😀" * 128, config_path=self.pointer_path)
        self.assertTrue(integration.url.endswith(("%F0%9F%98%80" * 128)))

    def test_connect_rejects_129_emoji_utf16_units(self):
        with self.assertRaises(ValueError):
            OmpTools().connect("😀" * 129, config_path=self.pointer_path)
        

    def test_native_transport_receives_session_url_and_bearer_header(self):
        integration = OmpTools().connect("session-a", config_path=self.pointer_path)
        session = FakeSession(
            result=type("Result", (), {"structuredContent": {"ok": True}, "content": [], "isError": False})()
        )
        captured = {}

        class Transport:
            async def __aenter__(self):
                return ("read", "write", None)

            async def __aexit__(self, *args):
                return False

        def transport(url, headers=None):
            captured["url"] = url
            captured["headers"] = headers
            return Transport()

        class ClientSession:
            def __init__(self, _read, _write):
                self.session = session

            async def __aenter__(self):
                return self.session

            async def __aexit__(self, *args):
                return False

        fake_mcp = types.SimpleNamespace(ClientSession=ClientSession)
        with patch.dict(sys.modules, {"mcp": fake_mcp}), patch.object(mcp_base, "_resolve_streamable_http", lambda: transport):
            self.assertEqual(run(integration.call_tool("read", {})), {"ok": True})

        self.assertEqual(captured["url"], "http://127.0.0.1:3210/mcp/v1/sessions/session-a")
        self.assertEqual(captured["headers"], {"Authorization": "Bearer bridge-secret"})

    def test_connect_delegates_native_tool_discovery_and_call(self):
        session = FakeSession(
            tools=[("read", "Read a file", {"type": "object"})],
            result=type("Result", (), {"structuredContent": {"text": "ok"}, "content": [], "isError": False})(),
        )
        integration = OmpTools().connect("session-a", config_path=self.pointer_path)

        async def open_session(_stack: AsyncExitStack):
            return session

        with patch.object(integration, "_open_session", open_session):
            self.assertEqual(run(integration.list_tools()), [{"name": "read", "description": "Read a file", "inputSchema": {"type": "object"}}])
            self.assertEqual(run(integration.read(path="README.md")), {"text": "ok"})

        self.assertEqual(session.calls, [("read", {"path": "README.md"})])

    def test_offline_session_error_is_not_reported_as_success(self):
        result = type(
            "Result",
            (),
            {
                "structuredContent": None,
                "content": [type("Block", (), {"text": "MCP session is unknown or offline"})()],
                "isError": True,
            },
        )()
        integration = OmpTools().connect("offline", config_path=self.pointer_path)
        session = FakeSession(result=result)

        async def open_session(_stack: AsyncExitStack):
            return session

        with patch.object(integration, "_open_session", open_session):
            with self.assertRaises(McpToolError) as context:
                run(integration.call_tool("read", {"path": "README.md"}))
        self.assertIn("unknown or offline", str(context.exception))

    def test_final_success_and_error_results_use_prime_parsing(self):
        success = type("Result", (), {"structuredContent": {"value": 0}, "content": [], "isError": False})()
        success_session = FakeSession(result=success)
        integration = OmpTools().connect("session-a", config_path=self.pointer_path)

        async def open_success(_stack: AsyncExitStack):
            return success_session

        with patch.object(integration, "_open_session", open_success):
            self.assertEqual(run(integration.call_tool("read", {})), {"value": 0})

        error = type(
            "Result",
            (),
            {
                "structuredContent": None,
                "content": [type("Block", (), {"text": "tool failed"})()],
                "isError": True,
            },
        )()
        error_session = FakeSession(result=error)

        async def open_error(_stack: AsyncExitStack):
            return error_session

        with patch.object(integration, "_open_session", open_error):
            with self.assertRaises(McpToolError) as context:
                run(integration.call_tool("read", {}))
        self.assertIn("tool failed", str(context.exception))


if __name__ == "__main__":
    unittest.main()

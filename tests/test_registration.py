# -*- coding: utf-8 -*-
"""
test_registration.py —— 工具注册机制测试
========================================

覆盖验收标准：@mcp_tool 装饰器 + auto_discover_tools 自动发现注册是否生效。
"""
from __future__ import annotations

from tests.conftest import run

from yasa_mcp.decorators import _MCP_TOOL_META_ATTR
from yasa_mcp.registry import auto_discover_tools


def test_mcp_tool_marks_function():
    """@mcp_tool 装饰的函数应带有注册元数据（name / description）。"""
    from yasa_mcp.decorators import mcp_tool

    @mcp_tool(name="demo", description="演示工具")
    async def demo() -> dict:
        return {"ok": True}

    meta = getattr(demo, _MCP_TOOL_META_ATTR)
    assert meta["name"] == "demo"
    assert meta["description"] == "演示工具"


def test_mcp_tool_defaults_to_function_name():
    """未显式指定 name 时，应默认使用函数名；description 默认用 docstring 首行。"""
    from yasa_mcp.decorators import mcp_tool

    @mcp_tool()
    async def auto_named_tool() -> dict:
        """这是工具描述"""
        return {"ok": True}

    meta = getattr(auto_named_tool, _MCP_TOOL_META_ATTR)
    assert meta["name"] == "auto_named_tool"
    assert meta["description"] == "这是工具描述"


def test_auto_discover_registers_ping():
    """auto_discover_tools 应自动发现 tools/ 目录下的 ping 并注册。"""
    from fastmcp import FastMCP

    mcp = FastMCP("test-discover")
    registered = auto_discover_tools(mcp)
    assert "ping" in registered


def test_auto_discover_is_idempotent():
    """对同一实例重复调用 auto_discover_tools 不应重复注册 / 报错。"""
    from fastmcp import FastMCP

    mcp = FastMCP("test-idem")
    first = auto_discover_tools(mcp)
    second = auto_discover_tools(mcp)
    # 第一次注册到 ping；第二次已全部注册过，返回空列表（不重复、不报错）
    assert first == ["ping"]
    assert second == []


def test_ping_discoverable_in_tools_list():
    """已注册的 ping 应可通过 tools/list 被 AI 客户端发现。"""
    from fastmcp import FastMCP

    mcp = FastMCP("test-list")
    auto_discover_tools(mcp)

    async def _list():
        tools = await mcp.list_tools()
        return [t.name for t in tools]

    assert "ping" in run(_list())


def test_ping_callable_returns_fixed_structure():
    """调用 ping 应返回脚手架约定的固定结构。"""
    from fastmcp import FastMCP

    mcp = FastMCP("test-ping")
    auto_discover_tools(mcp)

    async def _call():
        result = await mcp.call_tool("ping", {})
        return result.content[0].text

    import json

    payload = json.loads(run(_call()))
    assert payload["status"] == "ok"
    assert payload["server_name"] == "yasa-mcp"
    assert payload["version"] == "0.1.0"
    assert "stdio" in payload["transports_supported"]
    assert "streamable-http" in payload["transports_supported"]

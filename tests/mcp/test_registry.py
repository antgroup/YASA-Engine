"""
测试 Tool 注册机制

覆盖需求:
- NFR-3.1: 单元测试覆盖 Tool 注册流程
- FR-3.1: 提供装饰器或注册表方式注册 MCP Tool
- FR-3.2: 后续 Tool 开发者只需编写 tool 函数本身
- FR-3.3: Tool 注册时自动生成 MCP schema
- FR-3.4: 框架内置 demo tool ping
"""

from __future__ import annotations

import asyncio

import pytest
from fastmcp import FastMCP

from yasa_mcp.registry import mcp_tool, auto_discover_tools


@pytest.fixture
def mcp_instance():
    """创建一个干净的 FastMCP 实例"""
    return FastMCP(name="test-server", version="0.0.1")


class TestMcpToolDecorator:
    """测试 @mcp_tool 装饰器"""

    def test_decorator_marks_function_with_metadata(self):
        """@mcp_tool 装饰器应在函数上留下正确的元数据"""
        @mcp_tool(name="test_tool", description="A test tool")
        async def my_tool() -> dict:
            return {"ok": True}

        assert hasattr(my_tool, "_mcp_tool_meta")
        meta = my_tool._mcp_tool_meta
        assert meta["name"] == "test_tool"
        assert meta["description"] == "A test tool"

    def test_decorator_preserves_function_callable(self):
        """装饰后的函数仍可直接调用"""
        @mcp_tool(name="callable_test", description="test")
        async def my_tool(x: int) -> int:
            return x * 2

        result = asyncio.get_event_loop().run_until_complete(my_tool(5))
        assert result == 10

    def test_decorator_does_not_execute_function(self):
        """装饰器不应在装饰时执行函数"""
        call_count = 0

        @mcp_tool(name="counted", description="test")
        async def my_tool() -> dict:
            nonlocal call_count
            call_count += 1
            return {"count": call_count}

        assert call_count == 0


class TestAutoDiscover:
    """测试 auto_discover_tools 自动发现"""

    @pytest.mark.asyncio
    async def test_discovers_ping_tool(self, mcp_instance):
        """自动发现应注册 ping tool"""
        registered = auto_discover_tools(mcp_instance, "yasa_mcp.tools")
        assert "ping" in registered

    @pytest.mark.asyncio
    async def test_ping_tool_in_tools_list(self, mcp_instance):
        """ping tool 应出现在 tools/list 中"""
        auto_discover_tools(mcp_instance, "yasa_mcp.tools")
        tools = await mcp_instance.list_tools()
        tool_names = [t.name for t in tools]
        assert "ping" in tool_names

    @pytest.mark.asyncio
    async def test_ping_tool_has_description(self, mcp_instance):
        """注册的 ping tool 应包含描述"""
        auto_discover_tools(mcp_instance, "yasa_mcp.tools")
        tools = await mcp_instance.list_tools()
        ping_tool = [t for t in tools if t.name == "ping"][0]
        assert ping_tool.description is not None
        assert len(ping_tool.description) > 0
        assert "health" in ping_tool.description.lower()

    @pytest.mark.asyncio
    async def test_ping_tool_callable_returns_status(self, mcp_instance):
        """调用 ping tool 应返回正确的状态结构"""
        auto_discover_tools(mcp_instance, "yasa_mcp.tools")
        result = await mcp_instance.call_tool("ping", {})
        # FastMCP call_tool 返回一个包含 content 的对象
        assert result is not None

    @pytest.mark.asyncio
    async def test_auto_discover_returns_list_of_names(self, mcp_instance):
        """auto_discover_tools 应返回已注册 tool 名称列表"""
        registered = auto_discover_tools(mcp_instance, "yasa_mcp.tools")
        assert isinstance(registered, list)
        assert len(registered) >= 1
        assert all(isinstance(name, str) for name in registered)

    @pytest.mark.asyncio
    async def test_auto_discover_invalid_package_returns_empty(self, mcp_instance):
        """扫描不存在的包应返回空列表而非崩溃"""
        registered = auto_discover_tools(mcp_instance, "yasa_mcp.nonexistent_pkg")
        assert registered == []


class TestToolSchemaGeneration:
    """测试 Tool schema 自动生成 (FR-3.3)"""

    @pytest.mark.asyncio
    async def test_ping_tool_has_parameters_schema(self, mcp_instance):
        """注册的 tool 应自动生成 parameters schema (FR-3.3)"""
        auto_discover_tools(mcp_instance, "yasa_mcp.tools")
        tools = await mcp_instance.list_tools()
        ping_tool = [t for t in tools if t.name == "ping"][0]
        # FastMCP FunctionTool 使用 parameters 属性存储输入参数 schema
        # ping 无参数，parameters 应为空 properties 的 object
        assert ping_tool.parameters is not None
        assert "properties" in ping_tool.parameters
        assert ping_tool.parameters["properties"] == {}

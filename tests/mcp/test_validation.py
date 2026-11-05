"""
测试参数校验

覆盖需求:
- NFR-3.2: 单元测试覆盖参数校验失败场景
- FR-4.1: 框架对每个 tool 的入参进行类型与必填校验
- FR-4.2: 校验失败时返回结构化错误信息，不导致进程崩溃
- FR-4.3: 校验规则基于 tool 注册时声明的参数 schema 自动生成
"""

from __future__ import annotations

import asyncio

import pytest
from fastmcp import FastMCP

from yasa_mcp.registry import mcp_tool, auto_discover_tools


@pytest.fixture
def mcp_instance():
    """创建一个干净的 FastMCP 实例"""
    return FastMCP(name="test-server-validation", version="0.0.1")


class TestParameterValidation:
    """测试 Pydantic 参数校验"""

    @pytest.mark.asyncio
    async def test_missing_required_param_raises_error(self, mcp_instance):
        """缺少必填参数应触发校验错误，而非静默成功"""
        @mcp_tool(name="need_param", description="A tool that requires a parameter")
        async def need_param(file_path: str) -> dict:
            """A tool requiring file_path.

            Args:
                file_path: path to file
            """
            return {"path": file_path}

        mcp_instance.tool(name="need_param", description="requires file_path")(need_param)

        # 调用时不传 file_path → 应触发校验错误
        with pytest.raises(Exception):
            await mcp_instance.call_tool("need_param", {})

    @pytest.mark.asyncio
    async def test_wrong_type_param_raises_error(self, mcp_instance):
        """参数类型错误应触发校验错误"""
        @mcp_tool(name="typed_tool", description="A typed tool")
        async def typed_tool(count: int) -> dict:
            """A tool requiring an integer.

            Args:
                count: a number
            """
            return {"count": count}

        mcp_instance.tool(name="typed_tool", description="requires int")(typed_tool)

        # 传入字符串而非整数 → 应触发校验错误
        with pytest.raises(Exception):
            await mcp_instance.call_tool("typed_tool", {"count": "not_a_number"})

    @pytest.mark.asyncio
    async def test_valid_params_succeed(self, mcp_instance):
        """正确参数应正常执行"""
        @mcp_tool(name="echo", description="Echo tool")
        async def echo(msg: str) -> dict:
            """Echo a message.

            Args:
                msg: message to echo
            """
            return {"echo": msg}

        mcp_instance.tool(name="echo", description="echo")(echo)

        result = await mcp_instance.call_tool("echo", {"msg": "hello"})
        assert result is not None

    @pytest.mark.asyncio
    async def test_no_param_tool_succeeds(self, mcp_instance):
        """无参数 tool 调用应成功"""
        auto_discover_tools(mcp_instance, "yasa_mcp.tools")
        result = await mcp_instance.call_tool("ping", {})
        assert result is not None

    @pytest.mark.asyncio
    async def test_validation_error_does_not_crash_server(self, mcp_instance):
        """校验失败不应导致进程崩溃"""
        @mcp_tool(name="crash_test", description="Crash test tool")
        async def crash_test(x: int) -> dict:
            """Requires int x.

            Args:
                x: an integer
            """
            return {"x": x}

        mcp_instance.tool(name="crash_test", description="crash test")(crash_test)

        # 触发校验错误
        try:
            await mcp_instance.call_tool("crash_test", {"x": "bad"})
        except Exception:
            pass  # 预期会抛异常

        # Server 实例仍可正常使用
        tools = await mcp_instance.list_tools()
        assert len(tools) > 0


class TestErrorHandling:
    """测试错误处理 (FR-5.1, FR-5.2)"""

    @pytest.mark.asyncio
    async def test_tool_exception_is_captured(self, mcp_instance):
        """Tool 执行异常应被捕获，不导致进程崩溃"""
        @mcp_tool(name="boom", description="A tool that raises")
        async def boom() -> dict:
            """Always raises."""
            raise RuntimeError("intentional failure")

        mcp_instance.tool(name="boom", description="raises error")(boom)

        # 调用应抛出异常（被框架捕获为 MCP 错误响应），而非崩溃
        with pytest.raises(Exception):
            await mcp_instance.call_tool("boom", {})

    def test_yasa_mcp_error_to_dict(self):
        """YasaMCPError.to_dict() 应返回结构化错误信息"""
        from yasa_mcp.errors import ToolExecutionError

        err = ToolExecutionError("something went wrong", tool_name="test")
        d = err.to_dict()
        assert d["error"] is True
        assert d["code"] == "TOOL_EXECUTION_ERROR"
        assert d["message"] == "something went wrong"
        assert d["tool_name"] == "test"

    def test_error_codes_are_distinct(self):
        """各错误类型的 code 应互不相同"""
        from yasa_mcp.errors import (
            ConfigError,
            ValidationError,
            ToolExecutionError,
            ToolNotFoundError,
        )

        codes = {
            ConfigError.code,
            ValidationError.code,
            ToolExecutionError.code,
            ToolNotFoundError.code,
        }
        assert len(codes) == 4

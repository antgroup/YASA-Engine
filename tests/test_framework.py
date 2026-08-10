# -*- coding: utf-8 -*-
"""
tests/test_framework.py —— 脚手架单元测试（pytest）
=====================================================

覆盖验收标准要求的三类场景：
    ① Tool 装饰器 @yasa_tool 自动注册功能是否生效；
    ② 工具传入非法参数时，参数校验是否触发、异常是否被捕获；
    ③ 不同日志级别下，日志输出格式与过滤是否正常。

运行命令（在项目根目录执行）：
    pytest tests/ -v
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import sys

# 把项目根目录加入 sys.path，保证 `import yasa_mcp` 在任何位置运行 pytest 都能成功
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, PROJECT_ROOT)

# 脚手架强校验环境变量 YASA_MCP_REPO_ROOT，测试期间兜底设置为项目根目录
os.environ.setdefault("YASA_MCP_REPO_ROOT", PROJECT_ROOT)

import pytest  # noqa: E402   （放在 sys.path 处理之后导入，保证定位正确）
from fastmcp import FastMCP  # noqa: E402
from fastmcp.exceptions import ValidationError  # noqa: E402  类型校验失败时的异常

from yasa_mcp.config import LOGGER_NAME, setup_logging  # noqa: E402
from yasa_mcp.decorators import yasa_tool  # noqa: E402


# ===========================================================================
# 场景①：@yasa_tool 装饰器自动注册功能
# ===========================================================================
def test_yasa_tool_registers_function() -> None:
    """
    验证：被 @yasa_tool 装饰的函数会被自动注册为 MCP 工具，
    并且工具名、入参 schema、描述都从函数定义里正确提取。
    """
    # 每个测试用独立的 FastMCP 实例，避免测试之间互相影响
    tm = FastMCP("test-server")

    @yasa_tool(tm)
    def add(a: int, b: int) -> int:
        """两数相加。"""
        return a + b

    # 通过 fastmcp 的检索接口确认工具已注册（get_tool 是异步的，用 asyncio.run 包裹）
    tool = asyncio.run(tm.get_tool("add"))

    # 1) 工具名 = 函数名
    assert tool.name == "add"
    # 2) 入参 schema 由函数签名自动生成（a:int, b:int）—— pydantic 校验的基础
    properties = tool.parameters.get("properties", {})
    assert properties["a"]["type"] == "integer"
    assert properties["b"]["type"] == "integer"
    # 3) 函数 docstring 被提取为工具描述
    assert "两数相加" in tool.description


# ===========================================================================
# 场景②：参数校验触发 + 异常捕获
# ===========================================================================
def test_invalid_type_triggers_validation() -> None:
    """
    验证：传入类型非法（把 int 参数传成字符串）时，pydantic 类型校验触发，
    fastmcp 抛出 ValidationError，服务进程不受影响。
    """
    tm = FastMCP("test-server")

    @yasa_tool(tm)
    def add(a: int, b: int) -> int:
        """两数相加。"""
        return a + b

    # 期望抛出 ValidationError（类型校验拦截）
    with pytest.raises(ValidationError):
        asyncio.run(tm.call_tool("add", {"a": "我不是数字", "b": 2}))


def test_exception_is_caught_returns_standard_error() -> None:
    """
    验证：工具函数内部抛异常时，@yasa_tool 的全局异常捕获生效——
    服务不崩溃、不把异常上抛给客户端，而是返回标准化错误 JSON。
    """
    tm = FastMCP("test-server")

    @yasa_tool(tm)
    def boom(msg: str) -> str:
        """故意抛异常，验证全局异常捕获。"""
        raise RuntimeError("boom-test")

    result = asyncio.run(tm.call_tool("boom", {"msg": "hello"}))

    # 异常被吞掉，fastmcp 不认为这是工具级错误（is_error 为 False）
    assert result.is_error is False

    # 返回值是标准化错误 JSON
    payload = json.loads(result.content[0].text)
    assert payload["status"] == "error"
    assert payload["error"]["code"] == "TOOL_EXECUTION_ERROR"
    assert payload["error"]["type"] == "RuntimeError"


def test_required_param_empty_triggers_nonempty_validation() -> None:
    """
    验证：必填字符串参数传空串时，触发脚手架的「非空校验」，
    返回标准化错误 JSON（INVALID_PARAM）。
    """
    tm = FastMCP("test-server")

    @yasa_tool(tm)
    def greet(name: str) -> str:
        """打招呼。"""
        return f"你好，{name}"

    result = asyncio.run(tm.call_tool("greet", {"name": ""}))

    payload = json.loads(result.content[0].text)
    assert payload["status"] == "error"
    assert payload["error"]["code"] == "INVALID_PARAM"
    assert "name" in payload["error"]["message"]


# ===========================================================================
# 场景③：不同日志级别下，输出格式与过滤是否正常
# ===========================================================================
def test_log_levels_format_and_filter(capsys) -> None:
    """
    验证分级日志系统：
        - debug 级别能输出 DEBUG / INFO 记录；
        - 切到 error 级别后，INFO 被过滤、ERROR 正常输出；
        - 输出格式包含 [级别][logger名] 标记。
    """
    logger = setup_logging("debug")  # 使用脚手架自带的 handler（写入 stderr）

    # 1) debug 级别：DEBUG 与 INFO 都能输出
    logger.debug("debug-line")
    logger.info("info-line")
    out = capsys.readouterr().err
    assert "[DEBUG][yasa_mcp] debug-line" in out
    assert "[INFO][yasa_mcp] info-line" in out

    # 2) 切到 error 级别：INFO 被过滤，ERROR 正常输出
    setup_logging("error")
    logger.info("should-be-filtered")
    logger.error("error-line")
    out2 = capsys.readouterr().err
    assert "should-be-filtered" not in out2
    assert "[ERROR][yasa_mcp] error-line" in out2

    # 3) 格式还原校验：日志级别与 logger 名必须出现在每一行
    assert "yasa_mcp" in out2

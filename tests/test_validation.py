# -*- coding: utf-8 -*-
"""
test_validation.py —— 入参校验与错误处理测试
============================================

覆盖验收标准：
    * 必填字符串参数为空 -> 标准化错误 INVALID_PARAM；
    * 类型不匹配 / 缺必填  -> fastmcp ValidationError；
    * 工具内部抛错      -> 标准化错误 INTERNAL_ERROR（不崩溃服务）。
"""
from __future__ import annotations

import json

import pytest
from fastmcp.exceptions import ValidationError

from tests.conftest import run


def _call(mcp, name: str, arguments: dict):
    async def _c():
        return await mcp.call_tool(name, arguments)

    return run(_c())


def test_required_empty_string_returns_invalid_param(make_tool_server):
    """必填字符串传空串/纯空格 -> 返回 INVALID_PARAM 标准化错误。"""
    async def greet(name: str) -> str:
        return f"hi {name}"

    mcp, name = make_tool_server(name="greet", func=greet)

    result = _call(mcp, name, {"name": ""})
    payload = json.loads(result.content[0].text)
    assert payload["status"] == "error"
    assert payload["error"]["code"] == "INVALID_PARAM"
    assert payload["error"]["type"] == "ValidationError"

    # 纯空格同样判定为空
    result2 = _call(mcp, name, {"name": "   "})
    payload2 = json.loads(result2.content[0].text)
    assert payload2["error"]["code"] == "INVALID_PARAM"


def test_type_mismatch_raises_validation_error(make_tool_server):
    """类型不匹配（如 str 传给 int 参数）-> fastmcp ValidationError。"""
    async def add(a: int, b: int) -> int:
        return a + b

    mcp, name = make_tool_server(name="add", func=add)

    with pytest.raises(ValidationError):
        _call(mcp, name, {"a": 1, "b": "not-a-number"})


def test_missing_required_param_raises_validation_error(make_tool_server):
    """缺少必填参数 -> fastmcp ValidationError。"""
    async def add(a: int, b: int) -> int:
        return a + b

    mcp, name = make_tool_server(name="add", func=add)

    with pytest.raises(ValidationError):
        _call(mcp, name, {"a": 1})


def test_tool_exception_returns_internal_error(make_tool_server):
    """工具内部抛异常 -> 返回 INTERNAL_ERROR 标准化错误，服务不崩溃。"""
    async def boom() -> str:
        raise RuntimeError("boom!")

    mcp, name = make_tool_server(name="boom", func=boom)

    result = _call(mcp, name, {})
    payload = json.loads(result.content[0].text)
    assert payload["status"] == "error"
    assert payload["error"]["code"] == "INTERNAL_ERROR"
    assert payload["error"]["type"] == "RuntimeError"


def test_sync_tool_exception_returns_internal_error(make_tool_server):
    """同步工具抛异常同样被捕获为标准错误。"""
    def boom_sync() -> str:
        raise ValueError("sync boom")

    mcp, name = make_tool_server(name="boom_sync", func=boom_sync)

    result = _call(mcp, name, {})
    payload = json.loads(result.content[0].text)
    assert payload["status"] == "error"
    assert payload["error"]["code"] == "INTERNAL_ERROR"
    assert payload["error"]["type"] == "ValueError"

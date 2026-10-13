# -*- coding: utf-8 -*-
"""
tests/conftest.py —— pytest 公共配置
=====================================

负责：
    1. 把项目根目录加入 sys.path，保证 `import yasa_mcp` 在任何目录运行 pytest 都成功；
    2. 兜底设置脚手架强校验的环境变量 YASA_MCP_REPO_ROOT（指向项目根目录）；
    3. 提供通用的测试工具 / 测试服务器 fixture。
"""
from __future__ import annotations

import asyncio
import os
import sys

import pytest

# 项目根目录 = 本文件的上两级目录
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

# 脚手架强校验环境变量 YASA_MCP_REPO_ROOT，测试期间兜底设置为项目根目录
os.environ.setdefault("YASA_MCP_REPO_ROOT", PROJECT_ROOT)

from yasa_mcp.decorators import mcp_tool  # noqa: E402


def run(coro):
    """在同步测试函数中运行协程的辅助函数（避免引入 pytest-asyncio）。"""
    return asyncio.run(coro)


@pytest.fixture
def make_tool_server():
    """
    工厂 fixture：把给定函数用 @mcp_tool 注册到一个全新的 FastMCP 实例上。

    用法：
        def test_xxx(make_tool_server):
            mcp, tool_name = make_tool_server(
                name="greet",
                func=lambda: {"ok": True},   # 或 async def 函数
            )
    """
    from fastmcp import FastMCP

    created = []

    def _make(name: str, func=None, description: str = "test tool"):
        nonlocal created
        mcp = FastMCP("test-server")
        decorated = mcp_tool(name=name, description=description)(func)
        mcp.tool(name=name, description=description)(decorated)
        created.append(mcp)
        return mcp, name

    yield _make

    # 清理：确保不再引用测试实例
    for mcp in created:
        pass

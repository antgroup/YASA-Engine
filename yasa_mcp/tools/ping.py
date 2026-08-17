# -*- coding: utf-8 -*-
"""
tools/ping.py —— 演示工具 ping
===============================

用于验证脚手架「自动发现 + 注册」机制是否生效的最小工具：
    * 被 @mcp_tool 装饰；
    * 无需修改任何框架核心代码，启动时自动注册到 FastMCP；
    * 固定返回结构，便于 AI 客户端验证连通性。
"""
from __future__ import annotations

from typing import Any, Dict

from yasa_mcp import SERVER_NAME, SERVER_VERSION, TRANSPORTS_SUPPORTED
from yasa_mcp.decorators import mcp_tool


@mcp_tool(
    name="ping",
    description="Ping 演示工具：探测服务是否在线，返回固定结构",
)
async def ping() -> Dict[str, Any]:
    """
    探测服务是否在线。

    固定返回结构：
        {
          "status": "ok",
          "server_name": "yasa-mcp",
          "version": "0.1.0",
          "transports_supported": ["stdio", "streamable-http"]
        }
    """
    return {
        "status": "ok",
        "server_name": SERVER_NAME,
        "version": SERVER_VERSION,
        "transports_supported": TRANSPORTS_SUPPORTED,
    }

"""
Demo tool: ping — 返回 server 状态信息

这是框架内置的健康检查 tool，用于验证 MCP Server 是否正常运行。
后续开发者可以参考此文件编写新的 tool。
"""

from __future__ import annotations

from yasa_mcp import SERVER_NAME, SERVER_VERSION, TRANSPORTS_SUPPORTED
from yasa_mcp.registry import mcp_tool


@mcp_tool(
    name="ping",
    description=(
        "Health check — returns server status, name, version, "
        "and supported transport modes"
    ),
)
async def ping() -> dict:
    """
    Returns server health and metadata.

    Returns:
        dict with keys: status, server_name, version, transports_supported
    """
    return {
        "status": "ok",
        "server_name": SERVER_NAME,
        "version": SERVER_VERSION,
        "transports_supported": TRANSPORTS_SUPPORTED,
    }

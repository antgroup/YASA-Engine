"""
MCP Server 核心: 管理生命周期与启动

YasaMCPServer 封装了 FastMCP 实例的创建、Tool 自动注册、
以及根据配置选择 stdio / http 传输模式启动。
"""

from __future__ import annotations

import logging

from fastmcp import FastMCP

from yasa_mcp import SERVER_NAME, SERVER_VERSION
from yasa_mcp.config import ServerConfig
from yasa_mcp.registry import auto_discover_tools

logger = logging.getLogger("yasa_mcp.server")


class YasaMCPServer:
    """YASA MCP Server 核心类"""

    def __init__(self, config: ServerConfig):
        self.config = config
        self.mcp = FastMCP(
            name=SERVER_NAME,
            version=SERVER_VERSION,
        )
        self._registered_tools: list[str] = []
        self._register_tools()

    def _register_tools(self) -> None:
        """自动发现并注册所有 tool"""
        self._registered_tools = auto_discover_tools(self.mcp)
        logger.info(
            "Server initialized: %s v%s, transport=%s, tools=%s",
            SERVER_NAME,
            SERVER_VERSION,
            self.config.transport,
            self._registered_tools,
        )

    async def run(self) -> None:
        """根据配置选择传输模式启动"""
        if self.config.transport == "stdio":
            logger.info("Starting in stdio mode")
            await self.mcp.run_stdio_async(show_banner=False)
        elif self.config.transport == "http":
            logger.info(
                "Starting in streamable-http mode on port %s",
                self.config.port,
            )
            await self._run_http()

    async def _run_http(self) -> None:
        """HTTP 模式启动 (含 /healthz)"""
        from yasa_mcp.transport.http import run_http
        await run_http(self.mcp, self.config.port)

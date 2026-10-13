# -*- coding: utf-8 -*-
"""
server.py —— MCP 服务核心（双传输模式）
=======================================

本文件负责：
    1. 创建全局唯一的 FastMCP 实例（统一运行底座）；
    2. 内置 /healthz 健康检查接口（HTTP 模式下可访问）；
    3. 启动时自动发现并注册 yasa_mcp/tools/ 下的所有工具；
    4. stdio 模式启动（默认，供 Claude Desktop / Cline / MCP Inspector 调用）；
    5. streamable-http 模式启动（HTTP 网络模式）。

注意：本脚手架针对 fastmcp 3.x 编写（见 requirements.txt）。
"""
from __future__ import annotations

import logging

from fastmcp import FastMCP
from starlette.requests import Request
from starlette.responses import JSONResponse

from yasa_mcp import SERVER_NAME, SERVER_VERSION, TRANSPORTS_SUPPORTED
from yasa_mcp.config import LOGGER_NAME, ServerConfig
from yasa_mcp.logging_config import setup_logging
from yasa_mcp.registry import auto_discover_tools

logger = logging.getLogger(LOGGER_NAME)


# ===========================================================================
# 全局唯一 MCP 服务实例 —— 后续所有代码分析 Tool 都注册到这个实例上
# ===========================================================================
mcp = FastMCP(
    name=SERVER_NAME,
    version=SERVER_VERSION,
    instructions=(
        "YASA-Engine [OSS26] MCP 统一运行底座脚手架。"
        "本服务是代码分析能力的统一注册底座，工具通过 tools/ 目录自动发现。"
    ),
)


# ---------------------------------------------------------------------------
# HTTP 健康检查接口：GET /healthz -> 200 + JSON
# 通过 fastmcp 3.x 的 custom_route 直接注册到 FastMCP 应用上。
# ---------------------------------------------------------------------------
@mcp.custom_route("/healthz", methods=["GET"])
async def healthz(request: Request) -> JSONResponse:
    """健康检查：返回 200 与服务基础信息（AI 客户端 / 运维探活用）。"""
    return JSONResponse(
        {
            "status": "ok",
            "server_name": SERVER_NAME,
            "version": SERVER_VERSION,
            "transports_supported": TRANSPORTS_SUPPORTED,
        }
    )


# ---------------------------------------------------------------------------
# 启动函数
# ---------------------------------------------------------------------------
def run_server(config: ServerConfig) -> None:
    """
    根据配置启动服务：初始化日志 -> 自动注册工具 -> 选择传输模式。

    Args:
        config: 服务运行配置（由 ServerConfig.from_env() 组装并校验）。

    Raises:
        ValueError: transport 取值非法（正常情况下由 from_env 提前拦截）。
    """
    setup_logging(config.log_level)
    logger.info(
        "YASA-MCP 启动: server=%s v%s, transport=%s, repo_root=%s",
        config.server_name,
        config.version,
        config.transport,
        config.repo_root,
    )

    registered = auto_discover_tools(mcp)
    logger.info("自动注册完成，共 %d 个工具: %s", len(registered), registered)

    if config.transport == "stdio":
        logger.info("stdio 模式启动中...")
        mcp.run(transport="stdio", show_banner=False)
    elif config.transport == "http":
        logger.info("streamable-http 模式启动中，端口 %s...", config.port)
        from yasa_mcp.transport.http import run_http

        run_http(mcp, config.port, log_level=config.log_level)
    else:
        raise ValueError(f"不支持的传输模式: {config.transport}")

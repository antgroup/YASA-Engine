# -*- coding: utf-8 -*-
"""
server.py —— MCP 服务核心（双传输模式）
=====================================

本文件负责：
    1. 创建全局唯一的 FastMCP 实例（统一运行底座）；
    2. 内置 ping 演示工具（固定返回结构，便于 AI 客户端验证连通性）；
    3. 内置 /healthz 健康检查接口（HTTP 模式下访问）；
    4. stdio 模式启动（默认，供 Claude Desktop / Cline / MCP Inspector 调用）；
    5. streamable-http 模式启动（HTTP 网络模式）。

注意：本脚手架针对 fastmcp 3.x 编写（见 requirements.txt）。
"""
from __future__ import annotations

import logging
from typing import Any, Dict

import uvicorn
from fastmcp import FastMCP
from starlette.requests import Request
from starlette.responses import JSONResponse

from yasa_mcp.config import LOGGER_NAME, ServerConfig, setup_logging
from yasa_mcp.decorators import yasa_tool

logger = logging.getLogger(LOGGER_NAME)

# ---------------------------------------------------------------------------
# 固定元信息常量：ping 工具与 /healthz 健康检查共用，保证返回一致
# ---------------------------------------------------------------------------
SERVER_NAME = "yasa-mcp"
SERVER_VERSION = "0.1.0"
TRANSPORTS_SUPPORTED = ["stdio", "streamable-http"]

# ===========================================================================
# 全局唯一 MCP 服务实例 —— 后续 14 个代码分析 Tool 都注册到这个实例上
# ===========================================================================
mcp = FastMCP(
    name=SERVER_NAME,
    version=SERVER_VERSION,
    instructions=(
        "YASA-Engine [OSS26] MCP 统一运行底座脚手架。"
        "本服务是代码分析能力的统一注册底座，内置 ping 演示工具。"
    ),
)


# ---------------------------------------------------------------------------
# 内置演示工具：ping
# 使用统一装饰器 @yasa_tool 注册，同时演示「装饰器 + 固定返回结构」。
# ---------------------------------------------------------------------------
@yasa_tool(mcp)
def ping() -> Dict[str, Any]:
    """
    Ping 演示工具：探测服务是否在线。

    固定返回结构：
        {
          "status": "ok",
          "server_name": "yasa-mcp",
          "version": "0.1.0",
          "transports_supported": ["stdio", "streamable-http"]
        }
    """
    logger.debug("ping 被调用")
    return {
        "status": "ok",
        "server_name": SERVER_NAME,
        "version": SERVER_VERSION,
        "transports_supported": TRANSPORTS_SUPPORTED,
    }


# ---------------------------------------------------------------------------
# HTTP 健康检查接口：GET /healthz -> 200 + JSON
# 通过 fastmcp 3.x 的 custom_route 直接注册到 FastMCP 应用上。
# ---------------------------------------------------------------------------
@mcp.custom_route("/healthz", methods=["GET"])
async def healthz(request: Request) -> JSONResponse:
    """健康检查：返回 200 与服务基础信息（AI 客户端/运维探活用）。"""
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
def run_stdio(config: ServerConfig) -> None:
    """
    stdio 模式启动（默认）：通过标准输入/输出传输 JSON-RPC 消息，
    供 Claude Desktop、Cline、MCP Inspector 等客户端调用。
    """
    logger.info(
        "[YASA-MCP] stdio 模式启动 | server=%s version=%s repo_root=%s",
        config.server_name,
        config.version,
        config.repo_root,
    )
    mcp.run(transport="stdio")


def run_http(config: ServerConfig) -> None:
    """
    streamable-http 模式启动：HTTP 网络服务。

    路由一览（启动后可访问）：
        GET  http://localhost:<port>/healthz   -> 健康检查
        POST http://localhost:<port>/mcp       -> MCP 协议端点（MCP 客户端连接用）
    """
    # 构建 FastMCP 的 HTTP 应用（streamable-http 传输，MCP 端点位于 /mcp）
    app = mcp.http_app(path="/mcp", transport="streamable-http")

    # uvicorn 的日志级别认 warning，这里做一次映射
    uvicorn_log_level = "warning" if config.log_level == "warn" else config.log_level

    logger.info(
        "[YASA-MCP] http 模式启动 | 端口=%s | 健康检查: http://localhost:%s/healthz",
        config.port,
        config.port,
    )
    uvicorn.run(app, host="0.0.0.0", port=config.port, log_level=uvicorn_log_level)


def run_server(config: ServerConfig) -> None:
    """统一启动入口：先初始化分级日志，再按 transport 分发到 stdio / http。"""
    setup_logging(config.log_level)
    if config.transport == "http":
        run_http(config)
    else:
        run_stdio(config)

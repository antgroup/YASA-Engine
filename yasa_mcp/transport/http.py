"""
HTTP 传输模式 + 健康检查端点

在 streamable-http 传输模式下，MCP Server 通过 HTTP 提供服务。
此模块负责:
1. 在 FastMCP 的 Starlette app 上追加 /healthz 健康检查路由
2. 启动 uvicorn 服务
"""

from __future__ import annotations

import logging
from typing import Any

from fastmcp import FastMCP
from starlette.responses import JSONResponse
from starlette.routing import Route

from yasa_mcp import SERVER_NAME, SERVER_VERSION

logger = logging.getLogger("yasa_mcp.transport.http")


async def healthz(request: Any) -> JSONResponse:
    """
    健康检查端点。

    GET /healthz → 200 + {"status": "ok", "server_name": ..., "version": ...}
    """
    return JSONResponse(
        {
            "status": "ok",
            "server_name": SERVER_NAME,
            "version": SERVER_VERSION,
        },
        status_code=200,
    )


def build_http_app(mcp: FastMCP) -> Any:
    """
    构建 HTTP app，在 FastMCP 的 streamable-http app 基础上
    追加 /healthz 健康检查路由。

    Args:
        mcp: FastMCP 实例

    Returns:
        Starlette app (含 /healthz 路由)
    """
    app = mcp.http_app(transport="streamable-http")

    # 追加 /healthz 路由
    health_route = Route("/healthz", healthz, methods=["GET"])
    app.routes.insert(0, health_route)

    return app


async def run_http(mcp: FastMCP, port: int, host: str = "0.0.0.0") -> None:
    """
    启动 HTTP 服务（含 /healthz 健康检查）。

    Args:
        mcp: FastMCP 实例
        port: 监听端口
        host: 监听地址
    """
    import uvicorn

    app = build_http_app(mcp)

    logger.info("HTTP server listening on %s:%s", host, port)

    config = uvicorn.Config(
        app,
        host=host,
        port=port,
        log_level="info",
    )
    server = uvicorn.Server(config)
    await server.serve()

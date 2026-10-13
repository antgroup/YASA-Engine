# -*- coding: utf-8 -*-
"""
transport/http.py —— streamable-http 传输模式
=============================================

将 FastMCP 实例的 http_app() 挂到 uvicorn 上运行。

安全默认（本脚手架的安全基线）：
    * 默认只绑定 127.0.0.1（仅本机可访问，不暴露到局域网/公网）；
    * 启用 fastmcp 的 host_origin_protection="auto" 来源保护
      （对 loopback 主机自动校验 Host/Origin，阻止跨站 / 伪造来源请求）；
    * 不设置通配 CORS（allowed_origins / allowed_hosts 默认 None，
      由 fastmcp 按 loopback 主机自动收紧）。

如需对外提供服务（如局域网 / 远程客户端访问），必须显式传入
allowed_origins / allowed_hosts / host，框架不会默认开放。
"""
from __future__ import annotations

import logging
from typing import List, Optional

import uvicorn
from fastmcp import FastMCP

from yasa_mcp.config import LOGGER_NAME

logger = logging.getLogger(LOGGER_NAME)


def run_http(
    mcp: FastMCP,
    port: int = 8765,
    host: str = "127.0.0.1",
    log_level: Optional[str] = "info",
    allowed_origins: Optional[List[str]] = None,
    allowed_hosts: Optional[List[str]] = None,
) -> None:
    """
    以 streamable-http 模式启动 MCP 服务（阻塞式）。

    Args:
        mcp:            FastMCP 实例（已注册好工具）。
        port:           监听端口。
        host:           监听地址（默认 127.0.0.1，仅本机访问）。
        log_level:      uvicorn 日志级别。
        allowed_origins: 显式放行的 Origin（默认 None -> 由 fastmcp
                         host_origin_protection="auto" 按 loopback 自动收紧）。
        allowed_hosts:   显式放行的 Host（默认 None，同上）。

    Note:
        默认安全策略不开放到网络。若确需远程访问，请显式传参，例如：
            run_http(mcp, host="0.0.0.0", port=8765,
                     allowed_origins=["https://your-client.example.com"])
    """
    # fastmcp 3.x 的 http_app 返回 Starlette 应用；/healthz 已挂在实例上
    app = mcp.http_app(
        transport="streamable-http",
        host_origin_protection="auto",  # loopback 主机自动校验 Host/Origin
        allowed_origins=allowed_origins,
        allowed_hosts=allowed_hosts,
    )

    logger.info("streamable-http 服务监听 http://%s:%s/", host, port)
    logger.info("健康检查: GET http://%s:%s/healthz", host, port)
    if host not in ("127.0.0.1", "localhost", "::1"):
        logger.warning(
            "绑定到非本机地址 %s，服务将对网络可见；请确认 allowed_origins / "
            "allowed_hosts 已按需配置。",
            host,
        )

    uvicorn.run(
        app,
        host=host,
        port=port,
        log_level=log_level or "info",
    )

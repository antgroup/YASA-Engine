"""
日志配置: stdio 模式下强制输出到 stderr

stdio 模式下 stdout 被 MCP JSON-RPC 协议占用，
日志必须输出到 stderr，否则会破坏 MCP 通信。
"""

from __future__ import annotations

import sys
import logging


def setup_logging(level: str = "info", transport: str = "stdio") -> None:
    """
    配置日志系统。

    Args:
        level: 日志级别 (debug/info/warn/error)
        transport: 传输模式，用于决定输出目标
                   (两种模式均输出到 stderr 以确保安全)
    """
    stream = sys.stderr  # 两种模式下都用 stderr 更安全
    handler = logging.StreamHandler(stream)
    formatter = logging.Formatter(
        fmt="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )
    handler.setFormatter(formatter)

    root_logger = logging.getLogger("yasa_mcp")
    root_logger.setLevel(level.upper())

    # 清除已有 handler 避免重复输出（测试场景会多次调用）
    root_logger.handlers.clear()
    root_logger.addHandler(handler)
    root_logger.propagate = False


def get_logger(name: str) -> logging.Logger:
    """获取 yasa_mcp 命名空间下的子 logger"""
    if name != "yasa_mcp" and not name.startswith("yasa_mcp."):
        name = f"yasa_mcp.{name}"
    return logging.getLogger(name)

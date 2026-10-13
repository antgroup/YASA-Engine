# -*- coding: utf-8 -*-
"""
yasa_mcp —— YASA-Engine [OSS26] MCP 统一运行底座脚手架
=====================================================

这是一个「MCP 统一运行底座骨架」，本身不是业务工具，
它为后续 14 个代码分析 MCP Tool 提供底层支撑。

核心能力：
    1. 双传输模式：stdio（默认，供 Claude Desktop / Cline 调用）
                   与 streamable-http（HTTP 网络模式，含 GET /healthz）
    2. 命令行启动参数：--transport / --port / --log-level
    3. 环境变量强制校验：YASA_MCP_REPO_ROOT 必填，为空直接抛异常
    4. 统一工具注册装饰器：@yasa_tool
    5. 基于 pydantic 的入参类型校验 + 必填参数非空校验
    6. 全局统一异常捕获：工具报错不崩溃服务，返回标准化错误 JSON
    7. 分级日志系统（debug / info / warn / error）

快速启动（先设置环境变量 YASA_MCP_REPO_ROOT）：
    python -m yasa_mcp --transport stdio
    python -m yasa_mcp --transport http --port 8765

模块结构：
    __init__.py   包入口与对外导出
    config.py     配置加载 + 环境变量强制校验 + 分级日志
    decorators.py 统一工具注册装饰器 @yasa_tool + 标准化错误
    server.py     FastMCP 实例、ping 演示工具、双传输模式启动
    __main__.py   命令行入口（click）
"""
from __future__ import annotations

# 导出顺序注意：config -> decorators -> server，避免循环导入
from yasa_mcp.config import (
    LOGGER_NAME,
    ConfigError,
    ServerConfig,
    get_config,
    setup_logging,
    validate_repo_root,
)
from yasa_mcp.decorators import make_error_response, yasa_tool
from yasa_mcp.server import mcp, run_server

__version__ = "0.1.0"

__all__ = [
    "__version__",
    "LOGGER_NAME",
    "ConfigError",
    "ServerConfig",
    "get_config",
    "setup_logging",
    "validate_repo_root",
    "make_error_response",
    "yasa_tool",
    "mcp",
    "run_server",
]

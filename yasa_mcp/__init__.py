# -*- coding: utf-8 -*-
"""
yasa_mcp —— YASA-Engine [OSS26] MCP 统一运行底座脚手架
=====================================================

为 YASA 对外开放的所有 MCP 工具提供统一的 Server 框架：
    * 工具注册机制（@mcp_tool 装饰器 + tools/ 目录自动发现）
    * 双传输模式（stdio / streamable-http）
    * 入参校验（pydantic 类型校验 + 必填字符串非空校验）
    * 统一错误处理（标准化错误 JSON，工具抛错不崩溃服务）
    * 分级日志与 /healthz 健康检查

典型用法：
    pip install -r requirements.txt
    set YASA_MCP_REPO_ROOT=D:\\path\\to\\repo
    python -m yasa_mcp --transport stdio
    python -m yasa_mcp --transport http --port 8765
"""
from __future__ import annotations

# ---------------------------------------------------------------------------
# 服务固定元信息（ping 与 /healthz 共用，保证返回一致）
# ---------------------------------------------------------------------------
SERVER_NAME = "yasa-mcp"
SERVER_VERSION = "0.1.0"
TRANSPORTS_SUPPORTED = ["stdio", "streamable-http"]

__version__ = SERVER_VERSION
__all__ = [
    "SERVER_NAME",
    "SERVER_VERSION",
    "TRANSPORTS_SUPPORTED",
    "__version__",
]

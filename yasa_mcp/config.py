"""
配置管理: 解析命令行参数与环境变量
"""

from __future__ import annotations

import os
import sys
import argparse
from dataclasses import dataclass
from typing import Literal


@dataclass(frozen=True)
class ServerConfig:
    """全局不可变配置"""

    transport: Literal["stdio", "http"] = "stdio"
    port: int = 8765
    log_level: Literal["debug", "info", "warn", "error"] = "info"
    repo_root: str = ""

    def validate(self) -> None:
        """校验配置合法性，失败时打印错误并退出"""
        if not self.repo_root:
            print(
                "ERROR: YASA_MCP_REPO_ROOT environment variable is required.\n"
                "       Please set it to the root directory of the repository "
                "to be analyzed.",
                file=sys.stderr,
            )
            sys.exit(1)
        if not os.path.isdir(self.repo_root):
            print(
                f"ERROR: YASA_MCP_REPO_ROOT path does not exist or is not a "
                f"directory: {self.repo_root}",
                file=sys.stderr,
            )
            sys.exit(1)


def parse_config(argv: list[str] | None = None) -> ServerConfig:
    """解析命令行参数 + 环境变量，返回 ServerConfig"""

    parser = argparse.ArgumentParser(
        prog="yasa-mcp",
        description="YASA MCP Server — unified program analysis MCP service",
    )
    parser.add_argument(
        "--transport",
        choices=["stdio", "http"],
        default="stdio",
        help="Transport mode (default: stdio)",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=8765,
        help="HTTP listen port, only used when --transport=http (default: 8765)",
    )
    parser.add_argument(
        "--log-level",
        choices=["debug", "info", "warn", "error"],
        default="info",
        help="Log level (default: info)",
    )

    args = parser.parse_args(argv)
    repo_root = os.environ.get("YASA_MCP_REPO_ROOT", "")

    config = ServerConfig(
        transport=args.transport,
        port=args.port,
        log_level=args.log_level,
        repo_root=repo_root,
    )
    config.validate()
    return config

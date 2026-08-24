# -*- coding: utf-8 -*-
"""
__main__.py —— 命令行入口，支持 python -m yasa_mcp
=================================================

支持的启动方式：
    python -m yasa_mcp --transport stdio                  # stdio（默认，AI 客户端调用）
    python -m yasa_mcp --transport http --port 8765       # HTTP 网络模式

命令行参数（click 实现）：
    --transport  可选 stdio / http，默认 stdio
    --port       可选，HTTP 端口，默认 8765
    --log-level  可选 debug / info / warn / error，默认 info
"""
from __future__ import annotations

import click

from yasa_mcp.config import ConfigError, ServerConfig
from yasa_mcp.server import run_server


@click.command(
    name="yasa-mcp",
    help="YASA-Engine [OSS26] MCP 统一运行底座脚手架启动器",
)
@click.option(
    "--transport",
    type=click.Choice(["stdio", "http"], case_sensitive=False),
    default="stdio",
    show_default=True,
    help="传输模式：stdio（默认，供 Claude Desktop/Cline 调用）或 http（网络模式）",
)
@click.option(
    "--port",
    type=int,
    default=8765,
    show_default=True,
    help="HTTP 模式监听端口（默认 8765）",
)
@click.option(
    "--log-level",
    type=click.Choice(["debug", "info", "warn", "error"], case_sensitive=False),
    default="info",
    show_default=True,
    help="日志级别（默认 info）",
)
def main(transport: str, port: int, log_level: str) -> None:
    """
    YASA-MCP 启动入口：组装配置 -> 校验环境变量 -> 启动服务。

    注意：环境变量 YASA_MCP_REPO_ROOT 的强制校验在
    ServerConfig.from_env() 内部完成，为空/非法会直接抛 ConfigError。
    """
    try:
        config = ServerConfig.from_env(
            transport=transport,
            port=port,
            log_level=log_level,
        )
    except ConfigError as exc:
        # 配置缺失 / 非法：友好红色提示 + 非 0 退出码
        click.secho(f"\n[YASA-MCP 配置错误]\n{exc}", fg="red", err=True)
        raise click.exceptions.Exit(code=1)

    run_server(config)


if __name__ == "__main__":
    main()

"""
python -m yasa_mcp 入口

用法:
    python -m yasa_mcp --transport stdio
    python -m yasa_mcp --transport http --port 8765
"""

from __future__ import annotations

import asyncio
import sys

from yasa_mcp.config import parse_config
from yasa_mcp.logging_config import setup_logging
from yasa_mcp.server import YasaMCPServer


def main() -> None:
    """主入口函数"""
    config = parse_config() # 解析配置文件,位置见上
    setup_logging(config.log_level, config.transport) # 设置日志，不确定全局日志在哪里，就先这么做

    server = YasaMCPServer(config)

    try:
        asyncio.run(server.run())
    except KeyboardInterrupt:
        print("\nShutting down...", file=sys.stderr)
    except SystemExit:
        raise
    except Exception as e:
        print(f"Fatal error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()

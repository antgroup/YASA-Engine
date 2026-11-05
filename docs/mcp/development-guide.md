# YASA MCP 服务框架 — 开发文档

> 对应 Issue: [antgroup/YASA-Engine#129](https://github.com/antgroup/YASA-Engine/issues/129)
> 任务名称: `bootstrap_mcp_framework`
> 版本: v0.1.0
> 状态: 草案

---

## 1. 环境准备

### 1.1 前置条件

- Python >= 3.10
- pip / pipenv / uv（任选）
- Node.js >= 18（YASA-Engine 本身依赖，后续 Tool 集成时需要）
- MCP Inspector（用于调试）: `npx @modelcontextprotocol/inspector`

### 1.2 依赖安装

```bash
# 创建项目目录（位于 YASA-Engine 仓库下）
cd YASA-Engine
mkdir -p yasa_mcp/tools

# 安装 Python 依赖
pip install fastmcp pydantic uvicorn starlette pytest httpx
```

### 1.3 建议的 pyproject.toml

```toml
[project]
name = "yasa-mcp"
version = "0.1.0"
description = "YASA MCP Server Framework"
requires-python = ">=3.10"
dependencies = [
    "fastmcp>=0.8.0",
    "pydantic>=2.0",
    "uvicorn>=0.30.0",
    "starlette>=0.37.0",
]

[project.optional-dependencies]
dev = [
    "pytest>=8.0",
    "pytest-asyncio>=0.23",
    "httpx>=0.27",
]

[project.scripts]
yasa-mcp = "yasa_mcp.__main__:main"
```

## 2. 目录结构

```
YASA-Engine/
├── yasa_mcp/                    # MCP 框架包
│   ├── __init__.py
│   ├── __main__.py              # python -m yasa_mcp 入口
│   ├── server.py                # Server 核心类
│   ├── config.py                # 配置解析
│   ├── registry.py              # Tool 注册机制
│   ├── errors.py                # 错误码与异常
│   ├── logging.py               # 日志配置
│   ├── transport/
│   │   ├── __init__.py
│   │   ├── stdio.py             # stdio 传输
│   │   └── http.py              # HTTP 传输 + /healthz
│   └── tools/                   # Tool 实现目录
│       ├── __init__.py
│       └── ping.py              # demo tool
├── tests/
│   └── mcp/
│       ├── test_registry.py
│       ├── test_validation.py
│       └── test_logging.py
└── docs/
    └── mcp/
        ├── requirements.md      # 需求文档
        ├── system-design.md     # 系统设计文档
        └── development-guide.md # 本文档
```

## 3. 分步实现指南

### Step 1: 配置管理 — `yasa_mcp/config.py`

```python
"""配置管理: 解析命令行参数与环境变量"""

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
        """校验配置合法性"""
        if not self.repo_root:
            print(
                "ERROR: YASA_MCP_REPO_ROOT environment variable is required",
                file=sys.stderr,
            )
            sys.exit(1)
        if not os.path.isdir(self.repo_root):
            print(
                f"ERROR: repo_root does not exist: {self.repo_root}",
                file=sys.stderr,
            )
            sys.exit(1)


def parse_config(argv: list[str] | None = None) -> ServerConfig:
    """解析命令行参数 + 环境变量"""
    parser = argparse.ArgumentParser(
        prog="yasa-mcp",
        description="YASA MCP Server",
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
        help="HTTP listen port (default: 8765)",
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
```

### Step 2: 日志配置 — `yasa_mcp/logging.py`

```python
"""日志配置: stdio 模式下强制输出到 stderr"""

import sys
import logging


def setup_logging(level: str, transport: str = "stdio") -> None:
    """
    配置日志系统。

    stdio 模式下日志必须输出到 stderr，因为 stdout 被 MCP 协议占用。
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
    # 避免重复添加 handler
    if not root_logger.handlers:
        root_logger.addHandler(handler)
    root_logger.propagate = False
```

### Step 3: 错误处理 — `yasa_mcp/errors.py`

```python
"""统一错误码与异常定义"""


class YasaMCPError(Exception):
    """框架基础异常"""
    code: str = "UNKNOWN_ERROR"
    message: str = "An unknown error occurred"

    def __init__(self, message: str | None = None, **extra):
        self.message = message or self.message
        self.extra = extra
        super().__init__(self.message)

    def to_dict(self) -> dict:
        return {
            "error": True,
            "code": self.code,
            "message": self.message,
            **self.extra,
        }


class ConfigError(YasaMCPError):
    code = "CONFIG_ERROR"
    message = "Configuration error"


class ValidationError(YasaMCPError):
    code = "VALIDATION_ERROR"
    message = "Parameter validation failed"


class ToolExecutionError(YasaMCPError):
    code = "TOOL_EXECUTION_ERROR"
    message = "Tool execution failed"


class ToolNotFoundError(YasaMCPError):
    code = "TOOL_NOT_FOUND"
    message = "Requested tool is not registered"
```

### Step 4: Tool 注册机制 — `yasa_mcp/registry.py`

```python
"""Tool 注册机制: 装饰器 + 自动发现"""

import importlib
import pkgutil
import logging
from typing import Callable, Any

from fastmcp import FastMCP

logger = logging.getLogger("yasa_mcp.registry")


def mcp_tool(
    name: str,
    description: str,
) -> Callable:
    """
    装饰器: 将函数注册为 MCP Tool。

    用法:
        @mcp_tool(name="ping", description="Health check")
        async def ping() -> dict:
            return {"status": "ok"}
    """
    def decorator(func: Callable) -> Callable:
        # 在函数上打标记，server 初始化时统一注册
        func._mcp_tool_meta = {
            "name": name,
            "description": description,
        }
        logger.debug(f"Tool registered: {name}")
        return func

    return decorator


def auto_discover_tools(mcp: FastMCP, package_name: str = "yasa_mcp.tools") -> None:
    """
    自动扫描 tools/ 目录下所有模块，
    找到使用 @mcp_tool 装饰的函数并注册到 FastMCP 实例。
    """
    package = importlib.import_module(package_name)
    package_path = package.__path__

    for _, module_name, _ in pkgutil.iter_modules(package_path):
        full_name = f"{package_name}.{module_name}"
        module = importlib.import_module(full_name)

        for attr_name in dir(module):
            attr = getattr(module, attr_name)
            if callable(attr) and hasattr(attr, "_mcp_tool_meta"):
                meta = attr._mcp_tool_meta
                mcp.tool(
                    name=meta["name"],
                    description=meta["description"],
                )(attr)
                logger.info(f"Registered MCP tool: {meta['name']}")
```

### Step 5: Demo Tool — `yasa_mcp/tools/ping.py`

```python
"""Demo tool: ping — 返回 server 状态"""

from yasa_mcp.registry import mcp_tool

SERVER_NAME = "yasa-mcp"
SERVER_VERSION = "0.1.0"
TRANSPORTS_SUPPORTED = ["stdio", "streamable-http"]


@mcp_tool(
    name="ping",
    description="Health check — returns server status, name, version, and supported transports",
)
async def ping() -> dict:
    """
    Returns server health and metadata.

    Returns:
        dict with keys: status, server_name, version, transports_supported
    """
    return {
        "status": "ok",
        "server_name": SERVER_NAME,
        "version": SERVER_VERSION,
        "transports_supported": TRANSPORTS_SUPPORTED,
    }
```

### Step 6: Server 核心 — `yasa_mcp/server.py`

```python
"""MCP Server 核心: 管理生命周期与启动"""

import logging
from fastmcp import FastMCP

from yasa_mcp.config import ServerConfig
from yasa_mcp.registry import auto_discover_tools

logger = logging.getLogger("yasa_mcp.server")

SERVER_NAME = "yasa-mcp"
SERVER_VERSION = "0.1.0"


class YasaMCPServer:
    """YASA MCP Server 核心类"""

    def __init__(self, config: ServerConfig):
        self.config = config
        self.mcp = FastMCP(
            name=SERVER_NAME,
            version=SERVER_VERSION,
        )
        self._register_tools()

    def _register_tools(self) -> None:
        """自动发现并注册所有 tool"""
        auto_discover_tools(self.mcp)
        logger.info(
            f"Server initialized: {SERVER_NAME} v{SERVER_VERSION}, "
            f"transport={self.config.transport}"
        )

    async def run(self) -> None:
        """根据配置选择传输模式启动"""
        if self.config.transport == "stdio":
            logger.info("Starting in stdio mode")
            await self.mcp.run_stdio()
        elif self.config.transport == "http":
            logger.info(f"Starting in HTTP mode on port {self.config.port}")
            await self._run_http()

    async def _run_http(self) -> None:
        """HTTP 模式启动 (含 /healthz)"""
        from yasa_mcp.transport.http import run_http
        await run_http(self.mcp, self.config.port)
```

### Step 7: HTTP 传输 — `yasa_mcp/transport/http.py`

```python
"""HTTP 传输模式 + 健康检查端点"""

import logging
from fastmcp import FastMCP
from starlette.applications import Starlette
from starlette.routing import Route, Mount
from starlette.responses import JSONResponse

logger = logging.getLogger("yasa_mcp.transport.http")

SERVER_NAME = "yasa-mcp"
SERVER_VERSION = "0.1.0"


async def healthz(request) -> JSONResponse:
    """健康检查端点"""
    return JSONResponse(
        {
            "status": "ok",
            "server_name": SERVER_NAME,
            "version": SERVER_VERSION,
        },
        status_code=200,
    )


async def run_http(mcp: FastMCP, port: int) -> None:
    """启动 HTTP 服务"""
    import uvicorn

    # 获取 fastmcp 内置的 streamable-http app
    mcp_app = mcp.streamable_http_app()

    # 追加 /healthz 路由
    # fastmcp 返回的是 Starlette/FastAPI app，可以在路由列表中插入
    health_route = Route("/healthz", healthz, methods=["GET"])
    mcp_app.routes.insert(0, health_route)

    logger.info(f"HTTP server listening on 0.0.0.0:{port}")
    uvicorn.run(mcp_app, host="0.0.0.0", port=port, log_level="info")
```

### Step 8: 入口文件 — `yasa_mcp/__main__.py`

```python
"""python -m yasa_mcp 入口"""

import asyncio
import sys

from yasa_mcp.config import parse_config
from yasa_mcp.logging import setup_logging
from yasa_mcp.server import YasaMCPServer


def main() -> None:
    """主入口函数"""
    config = parse_config()
    setup_logging(config.log_level, config.transport)

    server = YasaMCPServer(config)

    try:
        asyncio.run(server.run())
    except KeyboardInterrupt:
        print("\nShutting down...", file=sys.stderr)
    except Exception as e:
        print(f"Fatal error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
```

### Step 9: `yasa_mcp/__init__.py`

```python
"""YASA MCP Server Framework"""

__version__ = "0.1.0"
```

## 4. 单元测试

### 4.1 `tests/mcp/test_registry.py`

```python
"""测试 Tool 注册机制"""

import pytest
from fastmcp import FastMCP
from yasa_mcp.registry import auto_discover_tools, mcp_tool


@pytest.fixture
def mcp_instance():
    mcp = FastMCP(name="test-server")
    return mcp


def test_tool_decorator_marks_function():
    """@mcp_tool 装饰器应在函数上留下元数据"""
    @mcp_tool(name="test_tool", description="A test tool")
    async def my_tool() -> dict:
        return {"ok": True}

    assert hasattr(my_tool, "_mcp_tool_meta")
    assert my_tool._mcp_tool_meta["name"] == "test_tool"
    assert my_tool._mcp_tool_meta["description"] == "A test tool"


def test_auto_discover_registers_ping(mcp_instance):
    """自动发现应注册 ping tool"""
    auto_discover_tools(mcp_instance, "yasa_mcp.tools")
    # 通过 FastMCP API 验证 tool 已注册
    tools = asyncio.get_event_loop().run_until_complete(
        mcp_instance.list_tools()
    )
    tool_names = [t.name for t in tools]
    assert "ping" in tool_names


def test_registered_tool_has_description(mcp_instance):
    """注册的 tool 应包含描述"""
    auto_discover_tools(mcp_instance, "yasa_mcp.tools")
    tools = asyncio.get_event_loop().run_until_complete(
        mcp_instance.list_tools()
    )
    ping_tool = [t for t in tools if t.name == "ping"][0]
    assert "health" in ping_tool.description.lower()
```

### 4.2 `tests/mcp/test_validation.py`

```python
"""测试参数校验"""

import pytest
from yasa_mcp.errors import ValidationError


def test_missing_required_param_raises_error():
    """缺少必填参数应抛出 ValidationError"""
    # 假设有 tool 需要 file_path 参数
    # 调用时不传 file_path → 应触发校验错误
    # 具体实现取决于 fastmcp 的校验行为
    # 可以通过直接调用 Pydantic model 验证
    pass  # 实现时补充


def test_wrong_type_param_raises_error():
    """参数类型错误应抛出校验异常"""
    pass  # 实现时补充
```

### 4.3 `tests/mcp/test_logging.py`

```python
"""测试日志输出格式"""

import logging
import pytest
from io import StringIO
from yasa_mcp.logging import setup_logging


def test_log_output_to_stderr(capsys):
    """stdio 模式日志应输出到 stderr"""
    setup_logging("debug", "stdio")
    logger = logging.getLogger("yasa_mcp")
    logger.info("test message")

    captured = capsys.readouterr()
    assert "test message" in captured.err  # stderr
    assert "test message" not in captured.out  # 不在 stdout


def test_log_format_contains_required_fields(capsys):
    """日志格式应包含时间戳、级别、模块名"""
    setup_logging("debug", "stdio")
    logger = logging.getLogger("yasa_mcp.server")
    logger.info("hello")

    captured = capsys.readouterr()
    log_line = captured.err.strip()
    assert "[INFO]" in log_line
    assert "yasa_mcp.server" in log_line
    assert "hello" in log_line


def test_log_level_filter(capsys):
    """WARN 级别下 DEBUG 日志不应输出"""
    setup_logging("warn", "stdio")
    logger = logging.getLogger("yasa_mcp")
    logger.debug("debug msg")
    logger.warning("warn msg")

    captured = capsys.readouterr()
    assert "debug msg" not in captured.err
    assert "warn msg" in captured.err
```

## 5. 本地启动与验证

### 5.1 stdio 模式

```bash
# 设置环境变量
export YASA_MCP_REPO_ROOT=/path/to/your/repo

# 启动
python -m yasa_mcp --transport stdio --log-level debug

# 用 MCP Inspector 调试
npx @modelcontextprotocol/inspector python -m yasa_mcp --transport stdio
```

### 5.2 HTTP 模式

```bash
export YASA_MCP_REPO_ROOT=/path/to/your/repo

# 启动
python -m yasa_mcp --transport http --port 8765

# 验证健康检查
curl http://localhost:8765/healthz
# 预期: {"status":"ok","server_name":"yasa-mcp","version":"0.1.0"}
```

## 6. 客户端配置示例

### 6.1 Claude Desktop (stdio 模式)

文件路径: `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS)

```json
{
  "mcpServers": {
    "yasa-mcp": {
      "command": "python",
      "args": ["-m", "yasa_mcp", "--transport", "stdio"],
      "env": {
        "YASA_MCP_REPO_ROOT": "/absolute/path/to/your/repo"
      }
    }
  }
}
```

> Windows 路径: `%APPDATA%\Claude\claude_desktop_config.json`

### 6.2 Cline (HTTP 模式)

在 VS Code 中打开 Cline 设置 → MCP Servers:

```json
{
  "mcpServers": {
    "yasa-mcp": {
      "url": "http://localhost:8765/mcp",
      "transportType": "streamable-http"
    }
  }
}
```

### 6.3 Cline (stdio 模式)

```json
{
  "mcpServers": {
    "yasa-mcp": {
      "command": "python",
      "args": ["-m", "yasa_mcp", "--transport", "stdio"],
      "env": {
        "YASA_MCP_REPO_ROOT": "/absolute/path/to/your/repo"
      },
      "transportType": "stdio"
    }
  }
}
```

## 7. 后续 Tool 开发指南

后续开发者只需 3 步即可新增一个 MCP Tool:

### Step 1: 在 `yasa_mcp/tools/` 下新建文件

例如 `yasa_mcp/tools/get_file_ast.py`:

```python
"""Tool: 获取文件的 AST"""

from pathlib import Path
from yasa_mcp.registry import mcp_tool


@mcp_tool(
    name="get_file_ast",
    description="Get the UAST (Unified Abstract Syntax Tree) of a specified file",
)
async def get_file_ast(file_path: str) -> dict:
    """
    Get the AST of a file in the analyzed repository.

    Args:
        file_path: Relative path to the file within the repository.
                   e.g. "src/main.ts"

    Returns:
        dict with keys: file_path, ast (JSON structure)
    """
    # 调用 YASA-Engine 进行分析
    # ...
    return {
        "file_path": file_path,
        "ast": {},  # 实际 AST 数据
    }
```

### Step 2: 无需修改框架代码

`auto_discover_tools()` 会自动扫描 `tools/` 目录并注册新 Tool。框架自动处理:
- 参数 schema 生成（从 type hint + Pydantic）
- 参数校验（Pydantic 自动）
- 错误捕获（框架统一）
- 日志记录（框架统一）

### Step 3: 测试

在 `tests/mcp/` 下新增测试文件即可。

## 8. 开发检查清单

实现完成时请逐项确认:

- [ ] `yasa_mcp/__main__.py` 可通过 `python -m yasa_mcp` 启动
- [ ] `--transport stdio` 模式正常，日志输出到 stderr
- [ ] `--transport http --port 8765` 模式正常，`GET /healthz` 返回 200
- [ ] `ping` tool 在 `tools/list` 中可见
- [ ] `ping` tool 调用返回正确的 JSON 结构
- [ ] 缺少 `YASA_MCP_REPO_ROOT` 环境变量时优雅报错退出
- [ ] 单元测试全部通过
- [ ] README 包含 Claude Desktop 配置示例
- [ ] MCP Inspector 可正常连接并调试

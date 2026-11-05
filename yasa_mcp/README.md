# YASA MCP Server

> YASA MCP 服务框架 — 为 YASA 对外开放的所有 MCP 工具提供统一的运行底座。
>
> 对应 Issue: [antgroup/YASA-Engine#129](https://github.com/antgroup/YASA-Engine/issues/129)

## 概述

YASA MCP Server 是基于 [fastmcp](https://github.com/jlowin/fastmcp) 搭建的 MCP (Model Context Protocol) 服务框架，提供：

- **双传输模式**: `stdio` (默认) / `streamable-http`
- **Tool 注册机制**: 装饰器 + 自动发现，后续开发者只需写 tool 函数
- **统一横切关注点**: 入参校验 (Pydantic)、错误处理、日志 (stderr)、健康检查 (`/healthz`)
- **内置 demo tool `ping`**: 验证框架是否正常运行

## 环境要求

- Python >= 3.10
- pip

## 安装

```bash
cd YASA-Engine

# 安装依赖
pip install fastmcp pydantic uvicorn starlette

# 开发环境（含测试）
pip install fastmcp pydantic uvicorn starlette pytest pytest-asyncio httpx
```

或使用 pyproject.toml:

```bash
pip install -e ".[dev]"
```

## 快速开始

### 1. 设置环境变量

```bash
# 必填：被分析的代码仓库根目录
export YASA_MCP_REPO_ROOT=/path/to/your/repo
```

### 2. stdio 模式启动（用于 Claude Desktop 等本地客户端）

```bash
python -m yasa_mcp --transport stdio
```

### 3. HTTP 模式启动（用于 Cline 等远程客户端）

```bash
python -m yasa_mcp --transport http --port 8765
```

验证健康检查：

```bash
curl http://localhost:8765/healthz
# 预期输出: {"status":"ok","server_name":"yasa-mcp","version":"0.1.0"}
```

### 4. 使用 MCP Inspector 调试

```bash
npx @modelcontextprotocol/inspector python -m yasa_mcp --transport stdio
```

## 启动参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `--transport` | enum(stdio, http) | 否 | stdio | 传输模式 |
| `--port` | int | 否 | 8765 | HTTP 模式监听端口 |
| `--log-level` | enum(debug, info, warn, error) | 否 | info | 日志级别 |
| `YASA_MCP_REPO_ROOT` | 环境变量 | 是 | — | 被分析的代码仓库根目录 |

## Demo Tool `ping`

框架内置一个 `ping` tool，用于验证服务是否正常运行：

**调用:**
```json
{"method": "tools/call", "params": {"name": "ping", "arguments": {}}}
```

**返回:**
```json
{
  "status": "ok",
  "server_name": "yasa-mcp",
  "version": "0.1.0",
  "transports_supported": ["stdio", "streamable-http"]
}
```

## 客户端配置

### Claude Desktop (stdio 模式)

文件路径:
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

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

### Cline (stdio 模式)

在 VS Code 中打开 Cline 设置 → MCP Servers:

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

### Cline (HTTP 模式)

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

## 新增 MCP Tool

后续开发者只需 3 步即可新增一个 MCP Tool，无需修改框架核心代码。

### Step 1: 在 `yasa_mcp/tools/` 下新建文件

例如 `yasa_mcp/tools/get_file_ast.py`:

```python
"""Tool: 获取文件的 AST"""

from yasa_mcp.registry import mcp_tool


@mcp_tool(
    name="get_file_ast",
    description="Get the UAST of a specified file in the repository",
)
async def get_file_ast(file_path: str) -> dict:
    """
    Get the AST of a file.

    Args:
        file_path: Relative path to the file within the repository.
    """
    # 调用 YASA-Engine 进行分析
    return {
        "file_path": file_path,
        "ast": {},
    }
```

### Step 2: 完成

`auto_discover_tools()` 会在启动时自动扫描 `tools/` 目录并注册新 Tool。框架自动处理:
- 参数 schema 生成（从 type hint + Pydantic）
- 参数校验（Pydantic 自动）
- 错误捕获（框架统一）
- 日志记录（框架统一）

### Step 3: 测试

在 `tests/mcp/` 下新增测试文件即可。

## 目录结构

```
YASA-Engine/
├── yasa_mcp/                    # MCP 框架包
│   ├── __init__.py              # 包入口，定义 server 常量
│   ├── __main__.py              # python -m yasa_mcp 入口
│   ├── server.py                # Server 核心类，管理生命周期
│   ├── config.py                # 启动参数解析与环境变量
│   ├── registry.py              # Tool 注册机制（装饰器 + 自动发现）
│   ├── errors.py                # 统一错误码与异常
│   ├── logging_config.py        # 日志配置（stderr 输出）
│   ├── transport/
│   │   ├── __init__.py
│   │   └── http.py              # HTTP 传输 + /healthz 健康检查
│   └── tools/                   # Tool 实现目录
│       ├── __init__.py
│       └── ping.py              # demo tool
├── tests/
│   └── mcp/
│       ├── conftest.py          # 测试 fixtures
│       ├── test_registry.py     # Tool 注册测试
│       ├── test_validation.py   # 参数校验测试
│       ├── test_logging.py      # 日志测试
│       └── test_config.py       # 配置测试
├── pyproject.toml               # Python 项目配置
└── docs/
    └── mcp/
        ├── README.md            # 文档索引
        ├── requirements.md      # 需求文档
        ├── system-design.md     # 系统设计文档
        └── development-guide.md # 开发文档
```

## 运行测试

```bash
python -m pytest tests/mcp/ -v
```

测试覆盖:
- **Tool 注册**: 装饰器元数据、自动发现、schema 生成、ping tool 可见可调用
- **参数校验**: 缺少必填参数、类型错误、正确参数、校验失败不崩溃
- **错误处理**: Tool 异常捕获、错误码唯一性、错误字典序列化
- **日志**: stderr 输出、格式（时间戳/级别/模块名/消息）、级别过滤
- **配置**: 默认值、参数解析、环境变量读取、错误退出

## 技术栈

| 组件 | 选型 | 版本 |
|------|------|------|
| 语言 | Python | >= 3.10 |
| MCP SDK | fastmcp | >= 3.0 |
| 参数校验 | Pydantic | >= 2.0 (随 fastmcp 安装) |
| HTTP 服务 | uvicorn + starlette | 随 fastmcp 安装 |
| 测试 | pytest + pytest-asyncio | >= 8.0 |

## 设计文档

详细的设计文档位于 `docs/mcp/`:

- [需求文档](docs/mcp/requirements.md) — 功能性与非功能性需求、验收标准
- [系统设计文档](docs/mcp/system-design.md) — 架构、模块划分、接口设计、数据流
- [开发文档](docs/mcp/development-guide.md) — 分步实现指南、代码示例、测试

## License

Apache License 2.0

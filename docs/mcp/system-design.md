# YASA MCP 服务框架 — 系统设计文档

> 对应 Issue: [antgroup/YASA-Engine#129](https://github.com/antgroup/YASA-Engine/issues/129)
> 任务名称: `bootstrap_mcp_framework`
> 版本: v0.1.0
> 状态: 草案

---

## 1. 概述

本文档描述 YASA MCP Server 框架的系统架构、模块划分、接口设计、数据流和部署方案。框架作为后续 14 个 MCP 分析工具的运行底座，提供传输层、注册机制、校验、错误处理和日志能力。

## 2. 技术选型

| 维度 | 选型 | 理由 |
|------|------|------|
| 语言 | Python 3.10+ | Issue 明确要求；MCP 生态 Python SDK 最成熟 |
| MCP SDK | `fastmcp` | Issue 推荐；API 简洁，内置 stdio/http 双模式，装饰器注册 |
| 参数校验 | Pydantic v2 | 与 fastmcp 天然集成；类型安全，自动生成 JSON Schema |
| 日志 | Python `logging` + structlog 或标准库 | 轻量依赖；stdio 模式必须输出到 stderr |
| HTTP 框架 | fastmcp 内置 (基于 starlette/uvicorn) | 无需额外引入 |
| 测试 | pytest | Python 生态标准 |

## 3. 系统架构

### 3.1 整体架构图

```
┌─────────────────────────────────────────────────────────┐
│                    MCP Client                           │
│         (Claude Desktop / Cline / Inspector)            │
└────────────┬──────────────────────┬─────────────────────┘
             │ stdio                │ streamable-http
             ▼                      ▼
┌─────────────────────────────────────────────────────────┐
│                  YASA MCP Server                        │
│  ┌─────────────────────────────────────────────────┐   │
│  │              传输层 (Transport)                   │   │
│  │   ┌──────────────┐    ┌────────────────────┐    │   │
│  │   │ StdioTransport│    │ HttpTransport      │    │   │
│  │   │ (stdin/stdout)│    │ (uvicorn + starlette)│   │   │
│  │   └──────┬───────┘    └────────┬───────────┘    │   │
│  │          └────────┬────────────┘                │   │
│  │                   ▼                              │   │
│  │          MCP Protocol Handler                   │   │
│  │     (tools/list, tools/call, initialize)        │   │
│  └─────────────────────┬───────────────────────────┘   │
│                        │                               │
│  ┌─────────────────────▼───────────────────────────┐   │
│  │            Tool 注册表 (Registry)                 │   │
│  │   ┌──────────┐ ┌──────────┐ ┌──────────────┐   │   │
│  │   │ ping     │ │ tool_A   │ │ tool_B ...   │   │   │
│  │   │ (demo)   │ │ (future) │ │ (future)     │   │   │
│  │   └──────────┘ └──────────┘ └──────────────┘   │   │
│  └─────────────────────┬───────────────────────────┘   │
│                        │                               │
│  ┌─────────────────────▼───────────────────────────┐   │
│  │            横切关注点 (Cross-cutting)             │   │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────────┐    │   │
│  │  │参数校验   │ │错误处理   │ │日志          │    │   │
│  │  │(Pydantic)│ │(统一捕获) │ │(stderr)      │    │   │
│  │  └──────────┘ └──────────┘ └──────────────┘    │   │
│  └─────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

### 3.2 模块划分

```
yasa_mcp/
├── __init__.py              # 包入口
├── __main__.py              # python -m yasa_mcp 入口
├── server.py                # MCP Server 核心类，管理生命周期
├── config.py                # 启动参数解析与环境变量
├── transport/
│   ├── __init__.py
│   ├── stdio.py             # stdio 传输模式
│   └── http.py              # streamable-http 传输模式 + /healthz
├── registry.py              # Tool 注册表（装饰器 + 自动发现）
├── errors.py                # 统一错误码与错误响应
├── logging.py               # 日志配置（stderr 输出）
└── tools/                   # Tool 实现目录
    ├── __init__.py
    └── ping.py              # demo tool
```

## 4. 模块详细设计

### 4.1 `config.py` — 配置管理

**职责**: 解析命令行参数与环境变量，生成全局配置对象。

```python
@dataclass
class ServerConfig:
    transport: Literal["stdio", "http"] = "stdio"
    port: int = 8765
    log_level: Literal["debug", "info", "warn", "error"] = "info"
    repo_root: str  # 来自 YASA_MCP_REPO_ROOT 环境变量

def parse_config(argv: list[str] | None = None) -> ServerConfig:
    ...
```

**设计要点**:
- `repo_root` 从环境变量 `YASA_MCP_REPO_ROOT` 读取，缺失时报错退出
- 命令行参数优先级高于环境变量
- 返回不可变 dataclass，避免运行时被意外修改

### 4.2 `server.py` — Server 核心

**职责**: 管理 MCP Server 的创建、启动、关闭。

```python
class YasaMCPServer:
    def __init__(self, config: ServerConfig):
        self.config = config
        self.mcp = FastMCP(name="yasa-mcp", version="0.1.0")
        self._register_tools()

    def _register_tools(self):
        """自动发现并注册 tools/ 目录下所有 tool"""

    async def run(self):
        """根据 config.transport 选择传输模式启动"""
        if self.config.transport == "stdio":
            await self.mcp.run_stdio()
        else:
            await self.mcp.run_streamable_http(port=self.config.port)
```

### 4.3 `registry.py` — Tool 注册机制

**职责**: 提供 tool 注册的统一机制，让后续开发者只需写函数。

**方案: 装饰器 + 自动发现**

```python
# 后续 Tool 开发者只需这样写：
from yasa_mcp.registry import mcp_tool

@mcp_tool(
    name="ping",
    description="Health check — returns server status",
)
async def ping() -> dict:
    return {
        "status": "ok",
        "server_name": "yasa-mcp",
        "version": "0.1.0",
        "transports_supported": ["stdio", "streamable-http"],
    }
```

**注册流程**:

```
Server.__init__()
  → _register_tools()
    → 扫描 tools/ 目录下所有 .py 模块
    → import 每个模块
    → 模块中使用 @mcp_tool 装饰的函数自动注册到 FastMCP 实例
    → Pydantic 自动从函数签名生成参数 schema
```

**设计要点**:
- `@mcp_tool` 装饰器内部调用 `FastMCP.tool()` 完成注册
- 参数类型由函数签名的 type hint 自动推断，Pydantic 生成 JSON Schema
- 后续开发者无需接触传输层、校验层代码

### 4.4 `transport/stdio.py` — stdio 传输

**职责**: stdio 模式启动入口。

**设计要点**:
- 直接调用 `fastmcp` 的 `run_stdio()` 方法
- 日志必须输出到 stderr，stdout 仅用于 MCP JSON-RPC 通信
- stdin/stdout 不做任何额外包装

### 4.5 `transport/http.py` — HTTP 传输

**职责**: streamable-http 模式启动入口 + 健康检查端点。

```python
async def run_http(mcp: FastMCP, port: int):
    """启动 HTTP 服务，附加 /healthz 路由"""
    app = mcp.streamable_http_app()
    # 在 starlette app 上追加 /healthz 路由
    app.mount("/healthz", healthz_route)
    uvicorn.run(app, host="0.0.0.0", port=port)

async def healthz(request):
    return JSONResponse({
        "status": "ok",
        "server_name": "yasa-mcp",
        "version": "0.1.0",
    }, status_code=200)
```

### 4.6 `errors.py` — 统一错误处理

**职责**: 定义错误码，统一错误响应格式。

```python
class YasaMCPError(Exception):
    """框架基础异常"""
    code: str
    message: str

class ValidationError(YasaMCPError):
    code = "VALIDATION_ERROR"

class ToolExecutionError(YasaMCPError):
    code = "TOOL_EXECUTION_ERROR"

class ConfigError(YasaMCPError):
    code = "CONFIG_ERROR"
```

**错误处理流程**:

```
Tool 函数执行
  → 成功: 返回结果
  → Pydantic 校验失败: 捕获 → 返回 VALIDATION_ERROR
  → Tool 内部异常: 捕获 → 返回 TOOL_EXECUTION_ERROR
  → 框架异常(端口占用等): 打印错误信息 → sys.exit(1)
```

### 4.7 `logging.py` — 日志配置

**职责**: 统一日志格式与输出目标。

```python
def setup_logging(level: str):
    """配置日志，stdio 模式下强制输出到 stderr"""
    handler = logging.StreamHandler(sys.stderr)
    formatter = logging.Formatter(
        "%(asctime)s [%(levelname)s] %(name)s: %(message)s"
    )
    handler.setFormatter(formatter)
    root_logger = logging.getLogger("yasa_mcp")
    root_logger.setLevel(level.upper())
    root_logger.addHandler(handler)
```

**设计要点**:
- stdio 模式: 日志必须输出到 stderr（stdout 被 MCP 协议占用）
- http 模式: 日志可输出到 stdout 或 stderr
- 日志格式: `时间戳 [级别] 模块名: 消息`

## 5. 数据流

### 5.1 stdio 模式调用流程

```
Claude Desktop
  → stdin 发送 JSON-RPC: {"method": "tools/call", "params": {"name": "ping", "arguments": {}}}
  → MCP Protocol Handler 解析请求
  → Registry 查找 "ping" tool
  → Pydantic 校验入参 (ping 无入参，直接通过)
  → 执行 ping() 函数
  → 返回结果
  → stdout 输出 JSON-RPC 响应
  → Claude Desktop 收到响应
```

### 5.2 http 模式调用流程

```
Cline / 远程客户端
  → POST /mcp HTTP/1.1
  → Body: {"method": "tools/call", "params": {"name": "ping", "arguments": {}}}
  → starlette 路由到 MCP handler
  → Registry 查找 "ping" tool
  → Pydantic 校验入参
  → 执行 ping() 函数
  → 返回 JSON 响应
```

### 5.3 健康检查流程

```
GET /healthz
  → starlette 路由到 healthz handler
  → 返回 {"status": "ok", "server_name": "yasa-mcp", "version": "0.1.0"}
  → HTTP 200
```

## 6. 接口设计

### 6.1 MCP Tool 注册接口

```python
def mcp_tool(
    name: str,
    description: str,
) -> Callable:
    """装饰器: 将函数注册为 MCP Tool"""
```

### 6.2 Demo Tool `ping` 接口

| 属性 | 值 |
|------|-----|
| Tool Name | `ping` |
| Description | Health check — returns server status |
| Parameters | 无 |
| 返回类型 | `dict` |

**返回结构**:

```json
{
  "status": "ok",
  "server_name": "yasa-mcp",
  "version": "0.1.0",
  "transports_supported": ["stdio", "streamable-http"]
}
```

### 6.3 健康检查接口

| 属性 | 值 |
|------|-----|
| 路径 | `GET /healthz` |
| 参数 | 无 |
| 成功响应 | HTTP 200 + JSON body |

## 7. 与 YASA-Engine 的集成方案（未来规划）

本任务仅搭建框架底座，不直接集成 YASA-Engine 分析能力。后续 14 个 Tool 将通过以下方式与 YASA-Engine 交互：

```
MCP Tool 函数
  → 构造 YASA-Engine CLI 命令 (或调用 Node.js SDK)
  → 子进程执行: npx tsx src/client.ts --singleCommand ...
  → 解析输出 (JSON)
  → 返回给 MCP 客户端
```

**关键设计**: 框架的 `ServerConfig.repo_root` 为后续 Tool 提供被分析仓库的根目录路径。

## 8. 部署方案

### 8.1 本地开发 (stdio)

```bash
export YASA_MCP_REPO_ROOT=/path/to/repo
python -m yasa_mcp --transport stdio --log-level debug
```

### 8.2 本地 HTTP 服务

```bash
export YASA_MCP_REPO_ROOT=/path/to/repo
python -m yasa_mcp --transport http --port 8765
```

### 8.3 Claude Desktop 集成

```json
{
  "mcpServers": {
    "yasa-mcp": {
      "command": "python",
      "args": ["-m", "yasa_mcp", "--transport", "stdio"],
      "env": {
        "YASA_MCP_REPO_ROOT": "/path/to/repo"
      }
    }
  }
}
```

### 8.4 Cline 集成 (HTTP 模式)

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

## 9. 测试策略

| 测试类型 | 覆盖范围 | 工具 |
|----------|----------|------|
| 单元测试 | Tool 注册流程 | pytest |
| 单元测试 | 参数校验失败场景 | pytest |
| 单元测试 | 日志输出格式 | pytest + capsys |
| 集成测试 | stdio 模式启动与通信 | MCP Inspector |
| 集成测试 | HTTP 模式 + /healthz | pytest + httpx |

### 9.1 单元测试用例

```
test_registry.py
  ✓ test_tool_auto_registration    — 装饰器注册后 tool 出现在 tools/list
  ✓ test_tool_name_and_description — 注册的 name/description 正确
  ✓ test_ping_tool_returns_status  — ping 返回正确结构

test_validation.py
  ✓ test_missing_required_param    — 缺少必填参数返回 VALIDATION_ERROR
  ✓ test_wrong_type_param          — 类型错误返回 VALIDATION_ERROR
  ✓ test_extra_param               — 多余参数的行为

test_logging.py
  ✓ test_log_output_to_stderr      — stdio 模式日志输出到 stderr
  ✓ test_log_format                — 日志格式包含时间戳、级别、模块
  ✓ test_log_level_filter          — 日志级别过滤生效
```

## 10. 风险与对策

| 风险 | 影响 | 对策 |
|------|------|------|
| fastmcp API 变更 | 框架不可用 | 锁定 fastmcp 版本；抽象传输层接口 |
| stdio 模式下日志污染 stdout | MCP 通信中断 | 强制日志输出到 stderr；测试验证 |
| YASA-Engine 是 Node.js 项目，MCP 是 Python | 跨语言调用开销 | 子进程方式调用；后续可考虑 gRPC |
| 后续 14 个 Tool 并发调用 YASA-Engine | 进程管理复杂 | 框架预留进程池接口（本期不实现） |

## 11. 后续演进路径

```
Phase 1 (本任务): 框架骨架 + ping demo
    ↓
Phase 2: 第一个分析 Tool (如 get_file_ast)
    ↓
Phase 3: 14 个 Tool 全部实现
    ↓
Phase 4: 进程池 / 缓存 / 性能优化
```

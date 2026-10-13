# YASA-MCP 统一运行底座脚手架（bootstrap_mcp_framework）

> Issue #129 · 为 YASA 对外开放的所有 MCP 工具搭建统一的 Server 框架

YASA-MCP 是 YASA-Engine 面向大模型开放的原子化程序分析 API。本脚手架为后续
全部 MCP 工具提供**统一的运行底座**：工具注册机制、双传输模式、入参校验、
错误处理、日志与健康检查。

- **技术栈**：Python 3.10+ / [fastmcp](https://github.com/jlowin/fastmcp) 3.x / click / pydantic / uvicorn / pytest
- **传输模式**：`stdio`（默认，供 Claude Desktop / Cline 等本地客户端调用）、`streamable-http`（HTTP 网络模式）

---

## 目录结构

```
yasa_mcp/
  __init__.py        # 服务固定元信息（server_name / version / transports）
  __main__.py        # 命令行入口（python -m yasa_mcp）
  config.py          # 配置加载 + YASA_MCP_REPO_ROOT 强校验（CLI > 环境变量 > 默认值）
  errors.py          # 标准化错误结构
  logging_config.py  # 分级日志
  decorators.py      # @mcp_tool 统一注册装饰器（校验 + 错误捕获）
  registry.py        # auto_discover_tools：启动时自动扫描 tools/ 目录注册工具
  server.py          # FastMCP 实例、/healthz、run_server 双模式启动
  transport/
    http.py          # streamable-http 传输层（uvicorn）
  tools/
    ping.py          # 演示工具：探测服务在线状态
tests/               # pytest 单元测试
```

---

## 快速开始

### 1. 安装依赖

```bash
pip install -r requirements-dev.txt   # 运行 + 测试依赖
```

### 2. 设置环境变量（必填）

`YASA_MCP_REPO_ROOT` 指向**待分析代码仓库的根目录**，启动时会强制校验：

```bash
# Windows (cmd)
set YASA_MCP_REPO_ROOT=D:\path\to\your\repo

# Windows (PowerShell)
$env:YASA_MCP_REPO_ROOT = "D:\path\to\your\repo"

# Mac / Linux
export YASA_MCP_REPO_ROOT=/path/to/your/repo
```

未设置或指向不存在路径时，启动会给出友好错误提示并以退出码 1 结束。

### 3. 启动服务

```bash
# stdio 模式（默认，供 Claude Desktop / Cline / MCP Inspector 调用）
python -m yasa_mcp --transport stdio

# HTTP 模式（streamable-http），默认绑定 127.0.0.1:8765
python -m yasa_mcp --transport http --port 8765
```

| 启动参数 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `--transport` | stdio / http | stdio | 传输模式 |
| `--port` | int | 8765 | HTTP 模式监听端口 |
| `--log-level` | debug / info / warn / error | info | 日志级别 |

### 4. 健康检查

HTTP 模式下访问 `GET /healthz` 应返回 200：

```bash
curl http://127.0.0.1:8765/healthz
# {"status":"ok","server_name":"yasa-mcp","version":"0.1.0","transports_supported":["stdio","streamable-http"]}
```

---

## 客户端配置

### Claude Desktop

编辑 `claude_desktop_config.json`（macOS 位于 `~/Library/Application Support/Claude/`，
Windows 位于 `%APPDATA%\Claude\`）。

**stdio 模式：**

```json
{
  "mcpServers": {
    "yasa-mcp": {
      "command": "python",
      "args": ["-m", "yasa_mcp", "--transport", "stdio"],
      "env": {
        "YASA_MCP_REPO_ROOT": "D:\\path\\to\\your\\repo"
      }
    }
  }
}
```

**HTTP 模式（需先手动启动服务）：**

```json
{
  "mcpServers": {
    "yasa-mcp": {
      "type": "http",
      "url": "http://127.0.0.1:8765/mcp"
    }
  }
}
```

### Cline

在 Cline 的 MCP 服务器设置中添加：

```json
{
  "mcpServers": {
    "yasa-mcp": {
      "command": "python",
      "args": ["-m", "yasa_mcp", "--transport", "stdio"],
      "env": {
        "YASA_MCP_REPO_ROOT": "D:\\path\\to\\your\\repo"
      }
    }
  }
}
```

### MCP Inspector 调试

```bash
# 方式一：先设好环境变量，再启动 Inspector 交互式输入命令
npx @modelcontextprotocol/inspector

# 方式二：直接传入启动命令（Inspector 会自动带上 stdio 子进程）
npx @modelcontextprotocol/inspector python -m yasa_mcp --transport stdio
```

启动后在 Inspector 界面应能看到 `ping` 工具，点击调用返回：

```json
{
  "status": "ok",
  "server_name": "yasa-mcp",
  "version": "0.1.0",
  "transports_supported": ["stdio", "streamable-http"]
}
```

---

## 新增一个 MCP 工具

新增工具**无需修改任何框架核心代码**，三步完成：

1. 在 `yasa_mcp/tools/` 下新建模块文件（如 `yasa_mcp/tools/greet.py`）；
2. 用 `@mcp_tool` 装饰 tool 函数（框架会自动做 pydantic 类型校验、必填非空校验、异常兜底）；
3. 重启服务，工具被 `auto_discover_tools()` 自动扫描注册。

```python
# yasa_mcp/tools/greet.py
from typing import Any, Dict
from yasa_mcp.decorators import mcp_tool


@mcp_tool(name="greet", description="向用户打招呼")
async def greet(name: str, times: int = 1) -> Dict[str, Any]:
    """返回打招呼消息。

    Args:
        name:  用户名称（必填，空串会被框架拦下）。
        times: 重复次数（可选，默认 1）。
    """
    return {"message": ("你好 " + name) * times}
```

要点：

- **签名即规范**：fastmcp 依据函数签名自动生成 pydantic 参数模型，无需手写 Schema；
- **必填非空**：必填字符串参数传空串/纯空格，返回 `INVALID_PARAM` 标准化错误；
- **异常兜底**：工具内任何异常都被捕获，返回 `INTERNAL_ERROR` 标准化错误，服务不崩溃；
- **文档即描述**：`description` 缺省时取 docstring 首行。

### 标准化错误结构

```json
{
  "status": "error",
  "error": {
    "code": "INVALID_PARAM | INTERNAL_ERROR",
    "type": "Python 异常类型名",
    "message": "人类可读错误信息",
    "params": { "触发错误的入参快照": "..." }
  }
}
```

---

## 单元测试

```bash
pytest tests/ -v
```

覆盖：工具注册机制、参数校验（空串 / 类型不匹配 / 缺必填）、异常兜底、
日志分级与格式、配置强校验、`/healthz` 健康检查。

# yasamcp

**yasamcp** 是基于静态分析引擎 [yasa](https://github.com/antgroup/YASA-Engine) 的仓库结构化查询工具：先用 CLI `init` 把代码工程预处理为结构化缓存，再用 CLI 查询、或启动 MCP 进程供 Claude Code / Codex 调用，对类、函数、调用图、关键字等做毫秒级查询。

支持 Java / Python / Go / JavaScript / PHP。

> ⚠️ **`init` 只能通过 CLI 执行，MCP 不提供 `init`**：预处理耗时长（数十秒到数分钟），经 MCP 调用极易因超时断链。务必先在终端 `yasamcp init <项目>` 生成缓存，再让 MCP 进程消费。

## 提供的工具

| CLI 子命令 | MCP 工具 | 作用 |
|------------|----------|------|
| `init` | —— | 初始化项目分析缓存（仅 CLI） |
| `status` | —— | 查询缓存状态（仅 CLI） |
| `search` | `search_symbol` | 统一符号搜索 |
| `class` | `get_class_by_name` | 按类名查类定义 |
| `func` | `get_function` | 按名 / 文件 / 代码片段查函数定义 |
| `keywords` | `get_file_by_keyword` | 按关键字搜文件内容 |
| `api` | `get_api_by_name` | 按接口名反查实现函数 |
| `callers` | `get_reference_by_function` | 查函数被调用的位置 |
| `callees` | `get_function_by_call` | 根据调用点反查被调用函数 |
| `callgraph` | `get_call_graph` | 获取函数调用图 |
| —— | `get_import_by_file` | 查询指定文件的 import 语句（仅 MCP） |
| `server` | —— | 启动 MCP 常驻进程（供 CC/Codex spawn） |

MCP 共 **9 个只读查询工具**，完整参数与输入输出示范见 [docs/yasamcp.md](docs/yasamcp.md)。

## 使用示范

```bash
# 1. 预处理生成缓存（首次必做，用 -b 指定 native 引擎目录）
yasamcp init tests/dataset/java/sast-java -b /path/to/yasa_mcp_bin

# 2. 查缓存状态
yasamcp status -p tests/dataset/java/sast-java

# 3. 查询（非 init 工具必填 -p/--project，加 -j 以 JSON 输出）
yasamcp search HttpUtil -p tests/dataset/java/sast-java
yasamcp class HttpUtil -p tests/dataset/java/sast-java -j
yasamcp callgraph Controller.query -p tests/dataset/java/sast-java --depth 3
```

也可以设置环境变量 `YASA_MCP_PROJECT` 后省略 `-p`。

## 在 CC / Codex 中配置 MCP server

先启动 MCP 进程，再在客户端配置里登记：

```bash
yasamcp server -b /path/to/yasa_mcp_bin      # 默认 stdio，供客户端 spawn
```

**Claude Code**（`~/.claude.json` 的 `mcpServers`）：

```json
{
  "mcpServers": {
    "yasamcp": {
      "type": "stdio",
      "command": "/path/to/yasamcp",
      "args": ["server", "-b", "/path/to/yasa_mcp_bin"],
      "env": {}
    }
  }
}
```

**Codex**（`~/.codex-ds/config.toml`）：

```toml
[mcp_servers.yasamcp]
command = "/path/to/yasamcp"
args = ["server", "-b", "/path/to/yasa_mcp_bin"]
startup_timeout_sec = 60

[mcp_servers.yasamcp.env]
```

配置后重启会话，`/mcp` 看到 `yasamcp` 及 9 个工具即接入成功（`Auth: Unsupported` 对本地 stdio 属正常）。

## 许可证

yasamcp 与 yasa 一致，采用 [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0)。引用的第三方开源工具（均为 MIT）声明见 [NOTICE.md](NOTICE.md)。

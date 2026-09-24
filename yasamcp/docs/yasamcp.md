# yasamcp 详细文档

本文覆盖 yasamcp 的安装与使用、CLI 工具、MCP 工具、CC/Codex 集成、以及参与贡献（运行集成测试 / 配置 xast 靶场）。

## 目录

- [安装](#安装)
- [快速使用](#快速使用)
- [CLI 工具](#cli-工具)
- [MCP 工具](#mcp-工具)
- [CC / Codex 集成](#cc--codex-集成)
- [参与贡献](#参与贡献)
- [许可证](#许可证)

## 安装

yasamcp 由 **打包好的 CLI 二进制** + **4 个 native 引擎**（`yasa` / `codegraph` / `ripgrep` / `scc`，按 OS+架构分平台）组成，统一安装到 `~/.yasamcp/<os>-<arch>/`，路径写入 `~/.yasamcp/config.json`，CLI 与 MCP 自动定位。

### 一键安装脚本（推荐）

```bash
bash install.sh
```

脚本会检测 OS+CPU 架构（`darwin-arm64` / `darwin-x86_64` / `linux-x86_64`）→ 从 OSS 拉取对应平台制品 → 解压到 `~/.yasamcp/<os>-<arch>/` → 校验二进制 → 写入 `config.json` → 安装 `yasamcp` 到 `PATH` → 末尾自检 `yasamcp --version`。

> OSS 下载地址（待补充）：`darwin-arm64` / `darwin-x86_64` / `linux-x86_64` 各一份。

也支持指定本地压缩包安装（跳过联网下载）：

```bash
bash install.sh --archive /path/to/yasamcp-darwin-arm64.tar.gz
```

### 手动安装

1. 下载并解压平台制品到 `~/.yasamcp/<os>-<arch>/`（含 `yasa`、`codegraph`、`ripgrep`、`scc`、`yasamcp`）。
2. `chmod +x ~/.yasamcp/<os>-<arch>/*`。
3. 首次任一 `yasamcp init <项目> -b <引擎目录>` 会校验并持久化引擎路径。
4. 把 `yasamcp` 放入 `PATH` 或软链：`ln -s ~/.yasamcp/darwin-arm64/yasamcp /usr/local/bin/yasamcp`。

### 验证

```bash
yasamcp --version
yasamcp -h
```

### 开发者环境（贡献者）

本仓库用 `uv` 管理依赖，`pyproject.toml` 为依赖来源，`uv.lock` 为可复现锁定。

```bash
git clone <repo-url> && cd yasa_mcp
# 方式 A：uv（推荐，复现锁定）
uv sync --extra test --extra packaging
# 方式 B：纯 pip
python -m venv .venv && . .venv/bin/activate
pip install -e ".[test,packaging]"
```

打包 CLI：`bash script/build_macos_arm64.sh`（产物在 `dist/yasamcp/`）。

## 快速使用

```bash
# 1. 预处理生成缓存（init 只能用 CLI；耗时较长）
yasamcp init /path/to/project -b /path/to/yasa_mcp_bin
# 缓存落在 <project>/.yasa/yasamcp/，含 project_config.json / yasa.db / .codegraph/codegraph.db

# 2. 检查缓存状态
yasamcp status -p /path/to/project
# 合法：分析已完成；非法：分析数据不完整 / 分析已过期 / 无分析结果（提示执行 init）

# 3. 查询（非 init 工具必填 -p/--project，加 -j 以 JSON 输出）
yasamcp search HttpUtil -p /path/to/project
yasamcp class HttpUtil -p /path/to/project -j
```

## CLI 工具

通用约定：非 `init` 工具需 `-p/--project <项目>`（或环境变量 `YASA_MCP_PROJECT`），`-j/--json` JSON 输出，`-h` 查看帮助。标注「多值」的参数支持一次传多个。

### `init` —— 初始化缓存

```bash
yasamcp init /path/to/project -b /path/to/yasa_mcp_bin
yasamcp init /path/to/project --no-progress      # CI 场景关进度条
```

### `status` —— 查缓存状态

```bash
yasamcp status -p /path/to/project
```

### `search` —— 统一符号搜索

```bash
yasamcp search HttpUtil -p /path/to/project --max-results 10
yasamcp search HttpUtil OrderService -p /path/to/project -k class -j
```

### `class` —— 查询类定义

```bash
yasamcp class HttpUtil -p /path/to/project
yasamcp class HttpUtil Order -p /path/to/project --include-methods -j
```

### `func` —— 查询函数定义

按入参互斥路由：`--name/--fqn` 按名查；`--file-path` 按文件查；`--code` 按代码片段定位。优先级 `name/fqn > file_path > code`。

```bash
yasamcp func --name handleRequest -p /path/to/project
yasamcp func --file-path src/main/Foo.java -p /path/to/project --detail full
```

### `keywords` —— 按关键字搜文件内容

```bash
yasamcp keywords Logger Timer -p /path/to/project
yasamcp keywords "TODO|FIXME" -p /path/to/project --use-regex
```

### `api` —— 按接口名反查实现

```bash
yasamcp api /api/order/query -p /path/to/project
yasamcp api UserService.query -p /path/to/project -j
```

### `callers` —— 查函数被调用位置

```bash
yasamcp callers handleRequest -p /path/to/project
yasamcp callers handleRequest --file-path src/web/Foo.java --line 42 -p /path/to/project
```

### `callees` —— 根据调用点反查被调用函数

```bash
yasamcp callees "service.query(" -p /path/to/project
yasamcp callees "mapper.insert(" --file-path src/svc/X.java --line 88 -p /path/to/project
```

### `callgraph` —— 获取调用图

```bash
yasamcp callgraph Controller.query -p /path/to/project --depth 3
yasamcp callgraph handle -p /path/to/project --maxcallees 5 -j
```

### `server` —— 启动 MCP 进程

```bash
yasamcp server -b /path/to/yasa_mcp_bin
yasamcp server -t streamable-http --port 8000
```

完整参数表见 `yasamcp <子命令> -h`。

## MCP 工具

yasamcp 以 MCP 常驻进程（默认 stdio）对外提供 **9 个只读查询工具**：`search_symbol` / `get_class_by_name` / `get_function` / `get_file_by_keyword` / `get_api_by_name` / `get_function_by_call` / `get_reference_by_function` / `get_call_graph` / `get_import_by_file`。

通用约定：
- 每个工具都需 `project_path`（**必填**，`string`）：已通过 CLI `init` 分析好、缓存就绪的项目路径。
- 标注「多值」的参数接受单值或字符串数组，传多个时一次性查询多个结果。
- 部分 MCP 客户端（如 Codex）会把数组形参序列化成 JSON 字符串（如 `["A","B"]` 传成 `"[\"A\",\"B\"]"`），yasamcp 入口已自动还原为列表，按多值查询，客户端无需特殊处理。

| MCP 工具 | 作用 | 多值参数 |
|----------|------|----------|
| `search_symbol` | 统一符号搜索（函数/类/接口/文件） | `search` |
| `get_class_by_name` | 按类名查类定义，可返回方法列表 | `name`、`class_fqn` |
| `get_function` | 按名/文件/代码片段查询函数定义 | `name`、`function_fqn`、`file_path` |
| `get_file_by_keyword` | 按关键字搜文件内容 | `keyword` |
| `get_api_by_name` | 按接口名反查实现函数 | `api_name` |
| `get_function_by_call` | 根据调用点反查被调用函数 | —— |
| `get_reference_by_function` | 查函数被调用的位置 | —— |
| `get_call_graph` | 获取函数调用图 | —— |
| `get_import_by_file` | 查询指定文件 import 语句 | —— |

> ⚠️ **`init` 不在 MCP 工具中**。MCP 进程只用于只读查询，不写缓存、不跑增量；初始化必须先用 CLI `yasamcp init`。

### 输入输出示范

以 xast sast-java 仓库查询 `HttpUtil` 类为例。

**输入**（MCP 工具 `get_class_by_name` 的 `arguments`）：

```json
{
  "project_path": "/path/to/sast-java",
  "name": ["HttpUtil"],
  "max_results": 10
}
```

**输出**（`class_fqn` / `file_path` / `location` / `content` / `methods`）：

```json
{
  "results": [
    {
      "class_fqn": "com.sast.astbenchmark.common.utils::HttpUtil",
      "file_path": "src/main/java/com/sast/astbenchmark/common/utils/HttpUtil.java",
      "location": {
        "file_path": "src/main/java/com/sast/astbenchmark/common/utils/HttpUtil.java",
        "start_line": 20, "start_column": 0,
        "end_line": 109, "end_column": 1
      },
      "content": "public class HttpUtil {\n    public static String doGet(...) { ... }\n    public static String doPost(...) { ... }\n}",
      "methods": []
    }
  ],
  "truncated": false,
  "total_count": 1
}
```

> `content` 为类完整源码（此处为节省篇幅做了省略）；`location` 含起止行列；`methods` 在未传 `include_methods` 时为空。

更多工具的输入输出约定见 `tests/integration/test_cases/`（基于 xast 各语言模块构造，含 `*_input.json` 与 `*.expected.json` 对照）。

## CC / Codex 集成

先确保目标项目已 `yasamcp init` 生成缓存，再启动 MCP 进程：

```bash
yasamcp server -b /path/to/yasa_mcp_bin
```

执行过安装或首次 `init -b` 后引擎路径会持久化，`args` 可简化为 `["server"]`。

**Claude Code**（`~/.claude.json`，`mcpServers`）：

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

**验证**：重启会话 → `/mcp` 看到 `yasamcp` 及 9 个工具即成功（`Auth: Unsupported` 对本地 stdio 属正常，不阻断调用）→ 让模型带 `project_path` 调一个工具验证有结果。若返回「未找到已初始化的项目，请先通过 yasamcp init 生成分析结果」，说明该 `project_path` 缓存缺失/过期，回终端执行 `yasamcp init <项目路径>`。

## 参与贡献

### 开发环境

```bash
git clone <repo-url> && cd yasa_mcp
uv sync --extra test --extra packaging      # 或 pip install -e ".[test,packaging]"
bash script/build_macos_arm64.sh           # 产出 dist/yasamcp/yasamcp
```

### 运行集成测试

集成测试需要 **xast 靶场**：[alipay/ant-application-security-testing-benchmark](https://github.com/alipay/ant-application-security-testing-benchmark)。测试框架会自动准备靶场——首次运行时 `conftest` 调用 `tests/integration/yasamcp_client_integration/prepare_dataset.py`，从 GitHub clone xast 并把 5 个语言模块（sast-java / sast-go / sast-js / sast-php / sast-python3）复制到 `tests/dataset/{lang}/`，再对每个项目 `init` 生成缓存。后续运行会复用已有 dataset 与缓存。

**确保能从 GitHub clone xast**：优先 SSH（`git@github.com:alipay/...`），失败自动回退 HTTPS；两者都失败时脚本会提示配置 GitHub 公钥后重试（`ssh -T git@github.com`）。若离线/CI 想跳过拉取，可设 `YASA_AUTO_FETCH=0`（缺失用例按 skip 处理）。

集成测试用例位于 `tests/integration/test_cases/`（按语言分目录，各含 `*_input.json` 与 `*.expected.json`）。

运行命令（`YASAMCP_BINARY` 指向打包好的 CLI，`YASA_BIN_DIR` 指向 native 引擎根）：

```bash
# CLI 通道（pytest）
YASAMCP_BINARY=dist/yasamcp/yasamcp \
YASA_BIN_DIR=/path/to/yasa_mcp_bin \
python -m pytest tests/integration/yasamcp_client_integration/test_cli_tools.py -q -p no:cacheprovider

# MCP 通道（脚本，端到端 spawn yasamcp server）
YASAMCP_BINARY=dist/yasamcp/yasamcp \
YASA_BIN_DIR=/path/to/yasa_mcp_bin \
python tests/integration/yasamcp_client_integration/test_mcp_server.py

# 也可单独准备靶场（不跑测试）
python tests/integration/yasamcp_client_integration/prepare_dataset.py
```

期望：CLI 全绿、MCP 全绿、无 failed（缓存就绪后热请求通常 <100ms）。

## 许可证

yasamcp 采用 Apache License 2.0；集成的第三方工具（`codegraph` MIT / `ripgrep` MIT / `scc` MIT·Unlicense / `duckdb` MIT）声明与版权见 [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md)。

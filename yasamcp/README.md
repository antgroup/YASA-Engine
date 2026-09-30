# yasamcp

**yasamcp** 是基于静态分析引擎 [yasa](https://github.com/antgroup/YASA-Engine) 的仓库结构化查询工具：先用 CLI `init` 把代码工程预处理为结构化缓存，再用 CLI 查询、或启动 MCP 进程供 Claude Code / Codex 调用，对类、函数、调用图、关键字等做毫秒级查询。

支持 Java / Python / Go / JavaScript / PHP。

> ⚠️ **`init` 只能通过 CLI 执行，MCP 不提供 `init`**：预处理耗时长（数十秒到数分钟），经 MCP 调用极易因超时断链。务必先在终端 `yasamcp init <项目>` 生成缓存，再让 MCP 进程消费。

## 安装

yasamcp 由一个 **CLI 二进制** + **4 个 native 引擎**（`yasa` / `codegraph` / `ripgrep` / `scc`，按 OS+架构分平台）组成。仅支持 `mac-arm64` / `mac-x64` / `linux-x64`，其余平台会报错退出。统一安装到 `~/.yasamcp/`：

```
~/.yasamcp/
  ├─ tools/<平台>/{yasa,codegraph,ripgrep,scc}   # native 引擎(OSS 下载)
  ├─ yasamcp-cli/yasamcp                          # CLI 二进制(GitHub 下载)
  └─ config.json                                  # {"binary_path":"~/.yasamcp/tools"}
```

### 1. 一键安装（推荐）

```bash
bash script/install.sh
```

脚本依次做：检测 OS+架构 → 从 OSS 下载 4 个 native 引擎到 `~/.yasamcp/tools/<平台>/` → 从 [GitHub Releases](https://github.com/antgroup/YASA-Engine/releases) 解析最新 release tag 并下载 `yasamcp-<plat>.tar.gz` 到 `~/.yasamcp/yasamcp-cli/` → 写 `config.json` → 把 `~/.yasamcp/yasamcp-cli` 加入 `PATH`、导出 `YASA_MCP_BIN_DIR=~/.yasamcp/tools` → 末尾自检 `yasamcp --version`。

**自动跳过已安装部件**：若 `tools/<平台>` 下 4 个引擎目录齐全，跳过引擎下载；若 `yasamcp-cli/yasamcp` 已存在且可执行，跳过 CLI 下载。重复运行只会补装缺失部分，不会覆盖已装好的。

### 2. 可配置安装

| 选项 / 环境变量 | 作用 |
|----------------|------|
| `--home <目录>` ／ `YASAMCP_HOME` | 自定义安装目录（默认 `~/.yasamcp`） |
| `--skip-path` | 不改 shell rc（不写 `PATH`/`YASA_MCP_BIN_DIR`） |
| `--tools <文件>` | 用本地 OSS 引擎压缩包，跳过联网下载引擎 |
| `--yasamcp <文件>` | 用本地 yasamcp 压缩包，跳过联网下载 CLI |
| `YASAMCP_VERSION` | 要安装的 release tag，默认 `latest`（解析最新版）；可设 `yasamcp-v1.0.3` 固定版本 |
| `YASAMCP_REPO` | 发布仓库，默认 `antgroup/YASA-Engine` |
| `YASAMCP_ASSET` | 资源文件名，默认 `yasamcp-<平台>.tar.gz` |

```bash
bash script/install.sh --home /opt/yasamcp             # 安装到自定义目录
bash script/install.sh --skip-path                      # 不改 shell rc
```

**GitHub 下载慢时挂代理**：`curl` 会自动识别 `HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY` 环境变量。若直连 GitHub 很慢（国内常见），把代理传给脚本即可秒下：

```bash
HTTPS_PROXY=http://127.0.0.1:7890 bash script/install.sh   # 换成你本地代理地址
```

### 3. 脚本下载失败？手动下载再装（兜底）

如果脚本联网下载卡住或失败（比如 GitHub 访问受限），自己用浏览器/代理把两个产物下到本地，再让脚本跳过联网、直接用本地包安装即可。

**要下载的两个产物**（按你的平台替换 `<plat>`：mac-ARM 用 `darwin-aarch64`，mac-Intel 用 `darwin-x86-64`，Linux-x64 用 `linux-x86-64`）：

1. **native 引擎压缩包**（OSS，国内快）：
   `https://yasa.oss-cn-beijing.aliyuncs.com/<plat>.zip`
2. **yasamcp CLI 压缩包**（GitHub Releases）：
   `https://github.com/antgroup/YASA-Engine/releases/download/<version>/yasamcp-<plat>.tar.gz`
   （`<version>` 取最新 tag，见 [Releases](https://github.com/antgroup/YASA-Engine/releases)，例如 `yasamcp-v1.0.3`）

下载好之后，把两个文件路径传给脚本——脚本检测到本地包就跳过联网下载，只做解压、写 `config.json`、配置 `PATH`：

```bash
bash script/install.sh \
  --tools   ~/Downloads/darwin-aarch64.zip \
  --yasamcp ~/Downloads/yasamcp-darwin-aarch64.tar.gz
```

> 也可以只传其中一个：脚本会联网下载缺失的另一部分。比如只本地备了 yasamcp CLI，引擎仍联网拉：

```bash
bash script/install.sh --yasamcp ~/Downloads/yasamcp-darwin-aarch64.tar.gz
```

### 验证

```bash
yasamcp --version        # 确认 CLI 可运行
yasamcp -h               # 查看命令列表
```

若 `yasamcp` 命令找不到：`source ~/.zshrc`（macOS）或 `source ~/.bashrc`（Linux）让 `PATH` 生效。

### 日志

CLI 与 MCP 进程的运行日志按天写入 `~/.yasamcp/logs/YYYY-MM-DD.log`（每行带时间戳与阶段耗时），排障时直接查看当天日志文件即可。

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

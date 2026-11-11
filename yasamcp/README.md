# yasamcp

[English](README.md) / [简体中文](README_ZH.md)

**yasamcp** is a structured code repository query tool built on the [yasa](https://github.com/antgroup/YASA-Engine) static analysis engine. First, use the CLI `init` command to preprocess a project into a structured cache. Then query it through the CLI, or start an MCP process for Claude Code / Codex to query classes, functions, call graphs, keywords, and more in milliseconds.

Supports Java / Python / Go / JavaScript / PHP.

> ⚠️ **`init` is available only through the CLI, not through MCP**: preprocessing can take tens of seconds to several minutes, making MCP calls prone to timeouts and disconnections. Always run `yasamcp init <project>` in a terminal first to generate the cache, then let the MCP process consume it.

## Contents

- [Installation](#installation)
- [Available Tools](#available-tools)
- [Quick Start](#quick-start)
- [CLI Tools](#cli-tools)
- [MCP Tools](#mcp-tools)
- [CC / Codex Integration](#cc--codex-integration)
- [Contributing](#contributing)
- [License](#license)

## Installation

yasamcp consists of a **CLI binary** and **four native engines** (`yasa` / `codegraph` / `ripgrep` / `scc`, packaged by OS and architecture). Only `mac-arm64` / `mac-x64` / `linux-x64` are supported; installation exits with an error on other platforms. All components are installed under `~/.yasamcp/`:

```text
~/.yasamcp/
  ├─ tools/<platform>/{yasa,codegraph,ripgrep,scc}  # Native engines (downloaded from OSS)
  ├─ yasamcp-cli/yasamcp                          # CLI binary (downloaded from GitHub)
  └─ config.json                                 # {"binary_path":"~/.yasamcp/tools"}
```

### One-command installation (no clone required)

```bash
curl -fsSL https://raw.githubusercontent.com/antgroup/YASA-Engine/main/yasamcp/script/install.sh | sh
```

You can also pass options, including `--home`, `--skip-path`, `--tools`, and `--yasamcp`:

```bash
curl -fsSL https://raw.githubusercontent.com/antgroup/YASA-Engine/main/yasamcp/script/install.sh | sh -s -- --home /opt/yasamcp
```

### Installing from a cloned repository

```bash
bash script/install.sh
```

The script detects the OS and architecture, downloads the four native engines from OSS into `~/.yasamcp/tools/<platform>/`, resolves the latest release tag from [GitHub Releases](https://github.com/antgroup/YASA-Engine/releases), and downloads `yasamcp-<plat>.tar.gz` into `~/.yasamcp/yasamcp-cli/`. It then writes `config.json`, adds `~/.yasamcp/yasamcp-cli` to `PATH`, exports `YASA_MCP_BIN_DIR=~/.yasamcp/tools`, and finishes by checking `yasamcp --version`.

**Already installed components are skipped automatically**: if all four engine directories exist under `tools/<platform>`, the engine download is skipped. If `yasamcp-cli/yasamcp` already exists and is executable, the CLI download is skipped. Running the installer again only installs missing components; it does not overwrite existing installations.

### Installation options

| Option / Environment variable | Purpose |
|-------------------------------|---------|
| `--home <directory>` / `YASAMCP_HOME` | Custom installation directory (default: `~/.yasamcp`) |
| `--skip-path` | Leave shell rc files unchanged; do not configure `PATH` or `YASA_MCP_BIN_DIR` |
| `--tools <file>` | Use a local OSS engine archive instead of downloading the engines |
| `--yasamcp <file>` | Use a local yasamcp archive instead of downloading the CLI |
| `YASAMCP_VERSION` | Release tag to install; defaults to `latest` (resolves the latest release). Set a tag such as `yasamcp-v1.0.3` to pin a version |
| `YASAMCP_REPO` | Release repository (default: `antgroup/YASA-Engine`) |
| `YASAMCP_ASSET` | Asset filename (default: `yasamcp-<platform>.tar.gz`) |

```bash
bash script/install.sh --home /opt/yasamcp             # Install to a custom directory
bash script/install.sh --skip-path                    # Leave shell rc files unchanged
```

**Use a proxy if GitHub downloads are slow**: `curl` automatically recognizes the `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` environment variables. If direct access to GitHub is slow, as is common in mainland China, pass your proxy to the script to speed up downloads:

```bash
HTTPS_PROXY=http://127.0.0.1:7890 bash script/install.sh   # Replace with your local proxy address
```

> The `curl | sh` method also supports a proxy: `HTTPS_PROXY=http://127.0.0.1:7890 curl -fsSL <url> | sh`.

### If downloads fail: install from manually downloaded archives

If the script's downloads stall or fail, for example because access to GitHub is restricted, download the two archives using a browser or proxy. Then pass the local files to the installer so it can skip downloading them.

**Download these two archives**. Replace `<plat>` with your platform: `darwin-aarch64` for Mac ARM, `darwin-x86-64` for Mac Intel, or `linux-x86-64` for Linux x64.

1. **Native engine archive** (OSS, with fast access in mainland China):
   `https://yasa.oss-cn-beijing.aliyuncs.com/<plat>.zip`
2. **yasamcp CLI archive** (GitHub Releases):
   `https://github.com/antgroup/YASA-Engine/releases/download/<version>/yasamcp-<plat>.tar.gz`
   Use the latest tag for `<version>`; see [Releases](https://github.com/antgroup/YASA-Engine/releases), for example `yasamcp-v1.0.3`.

Pass both file paths to the script. When local archives are supplied, it skips downloading them and only extracts them, writes `config.json`, and configures `PATH`:

```bash
bash script/install.sh \
  --tools   ~/Downloads/darwin-aarch64.zip \
  --yasamcp ~/Downloads/yasamcp-darwin-aarch64.tar.gz
```

> You can also supply just one archive; the script downloads the other component. For example, to use a local CLI archive while downloading the engines:

```bash
bash script/install.sh --yasamcp ~/Downloads/yasamcp-darwin-aarch64.tar.gz
```

> Browser downloads are often faster because the browser uses a proxy or VPN. Pass the same proxy to the script with `HTTPS_PROXY=...` to use the same network route.

### Verification

```bash
yasamcp --version        # Check that the CLI runs
yasamcp -h               # List commands
```

If the `yasamcp` command is not found, run `source ~/.zshrc` on macOS or `source ~/.bashrc` on Linux to apply the `PATH` change.

### Logs

The CLI and MCP processes write daily logs to `~/.yasamcp/logs/YYYY-MM-DD.log`. Each line includes a timestamp and timing information for the processing stage. Check the current day's log when troubleshooting.

## Available Tools

| CLI subcommand | MCP tool | Purpose |
|----------------|----------|---------|
| `init` | — | Initialize the project's analysis cache (CLI only) |
| `status` | — | Check cache status (CLI only) |
| `search` | `search_symbol` | Unified symbol search |
| `class` | `get_class_by_name` | Look up class definitions by name |
| `func` | `get_function` | Look up function definitions by name, file, or code snippet |
| `keywords` | `get_file_by_keyword` | Search file contents by keyword |
| `api` | `get_api_by_name` | Find implementing functions by API name |
| `callers` | `get_reference_by_function` | Find locations where a function is called |
| `callees` | `get_function_by_call` | Resolve the function invoked at a call site |
| `callgraph` | `get_call_graph` | Retrieve a function call graph |
| — | `get_import_by_file` | Retrieve import statements from a file (MCP only) |
| `server` | — | Start a persistent MCP process for CC/Codex to spawn |

MCP provides **nine read-only query tools**. See [CLI Tools](#cli-tools) and [MCP Tools](#mcp-tools) below for parameter details and input/output examples.

## Quick Start

```bash
# 1. Preprocess the project to generate its cache (init is CLI-only and may take some time)
yasamcp init /path/to/project
# Cache location: <project>/.yasa/yasamcp/, containing project_config.json / yasa.db / .codegraph/codegraph.db

# 2. Check cache status
yasamcp status -p /path/to/project
# Valid: analysis is complete. Invalid: incomplete, outdated, or missing analysis data (prompts you to run init).

# 3. Query the project (commands other than init require -p/--project; add -j for JSON output)
yasamcp search HttpUtil -p /path/to/project
yasamcp class HttpUtil -p /path/to/project -j
```

## CLI Tools

Common conventions: tools other than `init` require `-p/--project <project>` or the `YASA_MCP_PROJECT` environment variable. Use `-j/--json` for JSON output and `-h` for help. Parameters marked as accepting multiple values can take several values in one call.

### `init` — Initialize the cache

> The default installer writes the engine path to `~/.yasamcp/config.json`, so `-b` is unnecessary. If you did not use the installer or want to override the engine directory, add `-b <engine-directory>`.

```bash
yasamcp init /path/to/project
yasamcp init /path/to/project --no-progress      # Disable the progress bar in CI
```

### `status` — Check cache status

```bash
yasamcp status -p /path/to/project
```

### `search` — Unified symbol search

```bash
yasamcp search HttpUtil -p /path/to/project --max-results 10
yasamcp search HttpUtil OrderService -p /path/to/project -k class -j
```

### `class` — Query class definitions

```bash
yasamcp class HttpUtil -p /path/to/project
yasamcp class HttpUtil Order -p /path/to/project --include-methods -j
```

### `func` — Query function definitions

The arguments select one lookup mode: `--name/--fqn` searches by name, `--file-path` searches by file, and `--code` locates a function by a code snippet. Precedence is `name/fqn > file_path > code`.

```bash
yasamcp func --name handleRequest -p /path/to/project
yasamcp func --file-path src/main/Foo.java -p /path/to/project --detail full
```

### `keywords` — Search file contents by keyword

```bash
yasamcp keywords Logger Timer -p /path/to/project
yasamcp keywords "TODO|FIXME" -p /path/to/project --use-regex
```

### `api` — Find implementations by API name

```bash
yasamcp api /api/order/query -p /path/to/project
yasamcp api UserService.query -p /path/to/project -j
```

### `callers` — Find function call sites

```bash
yasamcp callers handleRequest -p /path/to/project
yasamcp callers handleRequest --file-path src/web/Foo.java --line 42 -p /path/to/project
```

### `callees` — Resolve functions from call sites

```bash
yasamcp callees "service.query(" -p /path/to/project
yasamcp callees "mapper.insert(" --file-path src/svc/X.java --line 88 -p /path/to/project
```

### `callgraph` — Retrieve a call graph

```bash
yasamcp callgraph Controller.query -p /path/to/project --depth 3
yasamcp callgraph handle -p /path/to/project --maxcallees 5 -j
```

### `server` — Start the MCP process

> With the default installation, `-b` is unnecessary: engines are located automatically through `~/.yasamcp/config.json`. See [CC / Codex Integration](#cc--codex-integration) for complete client configuration examples.

```bash
yasamcp server
yasamcp server -t streamable-http --port 8000
```

Run `yasamcp <subcommand> -h` for the full list of parameters.

## MCP Tools

yasamcp exposes **nine read-only query tools** through a persistent MCP process using stdio by default: `search_symbol` / `get_class_by_name` / `get_function` / `get_file_by_keyword` / `get_api_by_name` / `get_function_by_call` / `get_reference_by_function` / `get_call_graph` / `get_import_by_file`.

Common conventions:

- Every tool requires `project_path` (**required**, `string`): the path to a project already analyzed with CLI `init`, with its cache ready.
- Parameters that accept multiple values take either a single value or an array of strings. Passing multiple values queries multiple results in one call.
- Some MCP clients, such as Codex, serialize array arguments as JSON strings, for example sending `["A","B"]` as `"[\"A\",\"B\"]"`. yasamcp automatically converts these back to lists and performs the query with multiple values; no special client-side handling is needed.

| MCP tool | Purpose | Parameters accepting multiple values |
|----------|---------|--------------------------------------|
| `search_symbol` | Unified symbol search (functions/classes/interfaces/files) | `search` |
| `get_class_by_name` | Look up class definitions by name, optionally including methods | `name`, `class_fqn` |
| `get_function` | Look up function definitions by name, file, or code snippet | `name`, `function_fqn`, `file_path` |
| `get_file_by_keyword` | Search file contents by keyword | `keyword` |
| `get_api_by_name` | Find implementing functions by API name | `api_name` |
| `get_function_by_call` | Resolve the function invoked at a call site | — |
| `get_reference_by_function` | Find locations where a function is called | — |
| `get_call_graph` | Retrieve a function call graph | — |
| `get_import_by_file` | Retrieve import statements from a file | — |

> ⚠️ **`init` is not an MCP tool**. The MCP process only performs read-only queries; it does not write caches or run incremental analysis. Initialize the project first with CLI `yasamcp init`.

### Input/output example

This example queries the `HttpUtil` class in the xast sast-java repository.

**Input** (`arguments` for the MCP tool `get_class_by_name`):

```json
{
  "project_path": "/path/to/sast-java",
  "name": ["HttpUtil"],
  "max_results": 10
}
```

**Output** (`class_fqn` / `file_path` / `location` / `content` / `methods`):

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

> `content` contains the complete class source code, abbreviated here for brevity. `location` includes the starting and ending line and column numbers. `methods` is empty when `include_methods` is not supplied.

For more tools' input/output conventions, see `tests/integration/test_cases/`. These cases are based on xast language modules and include corresponding `*_input.json` and `*.expected.json` files.

## CC / Codex Integration

> Prerequisite: generate the target project's cache with `yasamcp init <project>`. Initialization is CLI-only; MCP does not provide `init`.

The following examples use macOS arm64 with the default installation under `~/.yasamcp/`. The installer writes `~/.yasamcp/config.json` (`{"binary_path":"~/.yasamcp/tools"}`). At startup, `yasamcp` reads this file to locate the native engines; for mac-arm64, they are under `~/.yasamcp/tools/darwin-aarch64/`. Therefore, `server` does not need `-b`.

> ⚠️ CC/Codex spawns the process directly without a shell, so paths in the configuration must be **absolute**: neither `~` nor `$HOME` is expanded. Replace `yourname` below with your macOS username. Run `echo $HOME` to check your home directory, for example `/Users/zhangsan`.

First, confirm that the binary and configuration are ready:

```bash
ls -l ~/.yasamcp/yasamcp-cli/yasamcp          # CLI binary in the default installation
cat ~/.yasamcp/config.json                  # {"binary_path":"/Users/yourname/.yasamcp/tools"}
```

**Claude Code** (`mcpServers` in `~/.claude.json`):

```json
{
  "mcpServers": {
    "yasamcp": {
      "type": "stdio",
      "command": "/Users/yourname/.yasamcp/yasamcp-cli/yasamcp",
      "args": ["server"],
      "env": {}
    }
  }
}
```

**Codex** (`~/.codex-ds/config.toml`):

```toml
[mcp_servers.yasamcp]
command = "/Users/yourname/.yasamcp/yasamcp-cli/yasamcp"
args = ["server"]
startup_timeout_sec = 60

[mcp_servers.yasamcp.env]
```

> To let the MCP process locate the engines without relying on `config.json`, explicitly add `"YASA_MCP_BIN_DIR": "/Users/yourname/.yasamcp/tools"` to `env`. In Codex TOML, add `YASA_MCP_BIN_DIR = "..."` to the environment section. Either configuration method is sufficient; the default installer already configures `config.json`.

**Verify the integration**: restart the session, then run `/mcp`. If `yasamcp` and its nine tools appear, the server is connected. `Auth: Unsupported` is normal for local stdio and does not prevent tool calls. Ask the model to call a tool with `project_path` and confirm that it returns results. If the response says that no initialized project was found and asks you to generate analysis results with `yasamcp init`, the cache for that `project_path` is missing or outdated. Run `yasamcp init <project-path>` in a terminal.

## Contributing

### Development environment

```bash
git clone <repo-url> && cd yasa_mcp
uv sync --extra test --extra packaging      # Or: pip install -e ".[test,packaging]"
bash script/build_macos_arm64.sh            # Produces dist/yasamcp/yasamcp
```

### Running integration tests

Integration tests require the **xast benchmark suite**: [alipay/ant-application-security-testing-benchmark](https://github.com/alipay/ant-application-security-testing-benchmark). The test framework prepares it automatically. On the first run, `conftest` calls `tests/integration/yasamcp_client_integration/prepare_dataset.py` to clone xast from GitHub, copy its five language modules (sast-java / sast-go / sast-js / sast-php / sast-python3) into `tests/dataset/{lang}/`, and run `init` on each project to generate caches. Subsequent runs reuse the existing datasets and caches.

**Ensure that you can clone xast from GitHub**: the script tries SSH first (`git@github.com:alipay/...`) and automatically falls back to HTTPS. If both fail, it prompts you to configure your GitHub public key and retry (`ssh -T git@github.com`). To skip fetching in an offline or CI environment, set `YASA_AUTO_FETCH=0`; cases with missing data are skipped.

Integration test cases are in `tests/integration/test_cases/`, organized by language, with `*_input.json` and `*.expected.json` files in each directory.

Run the following commands with `YASAMCP_BINARY` pointing to the packaged CLI and `YASA_BIN_DIR` pointing to the native engine root directory:

```bash
# CLI channel (pytest)
YASAMCP_BINARY=dist/yasamcp/yasamcp \
YASA_BIN_DIR=/path/to/yasa_mcp_bin \
python -m pytest tests/integration/yasamcp_client_integration/test_cli_tools.py -q -p no:cacheprovider

# MCP channel (script that spawns yasamcp server for end-to-end testing)
YASAMCP_BINARY=dist/yasamcp/yasamcp \
YASA_BIN_DIR=/path/to/yasa_mcp_bin \
python tests/integration/yasamcp_client_integration/test_mcp_server.py

# Prepare the benchmark suite separately without running tests
python tests/integration/yasamcp_client_integration/prepare_dataset.py
```

Expected result: all CLI and MCP tests pass, with no failures. Once caches are ready, warm requests typically take less than 100 ms.

## License

yasamcp is licensed under the Apache License 2.0. For notices and copyright information for bundled third-party tools (`codegraph` MIT / `ripgrep` MIT / `scc` MIT·Unlicense / `duckdb` MIT), see [NOTICE.md](NOTICE.md).

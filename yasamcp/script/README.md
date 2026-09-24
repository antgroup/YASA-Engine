# yasa-mcp 打包说明

## 构建步骤 (macOS arm64)

```bash
cd <repo_root>
bash script/build_macos_arm64.sh
```

产物：`dist/yasamcp/yasamcp`（onedir 目录，包含 Python 运行时和所有依赖）。

## 运行

### native binary 目录

yasa-mcp CLI 只是 Python 编排层，实际分析由 5 个 native binary 执行：
`codegraph`、`yasa`、`yasa_scan`、`ripgrep`、`scc`。

通过 `-b/--bin` 指定 binary 根目录，结构约定：

```
<bin_dir>/
  darwin-aarch64/
    bin/
      codegraph
      yasa
      yasa_scan
      ripgrep
      scc
```

### 基本用法

```bash
# 初始化项目缓存（缓存落 <project>/.yasa/）
yasamcp -b <bin_dir> -p <project_path> init <project_path>

# 符号搜索
yasamcp -b <bin_dir> -p <project_path> search ModuleBootstrapApplication

# 类查询
yasamcp -b <bin_dir> -p <project_path> class ModuleBootstrapApplication

# 函数查询（func / function 互为别名）
yasamcp -b <bin_dir> -p <project_path> func --name query
yasamcp -b <bin_dir> -p <project_path> func --file-path src/main/java/Foo.java

# 启动 MCP server（供 CC/Codex spawn）
yasamcp server -t stdio -b <bin_dir> -p <project_path>
```

## CC/Codex 集成

```json
{
  "mcpServers": {
    "yasa": {
      "command": "/path/to/dist/yasamcp/yasamcp",
      "args": ["server", "-t", "stdio", "-b", "<bin_dir>", "-p", "<project_path>"]
    }
  }
}
```

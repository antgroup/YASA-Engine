# YASA MCP 服务框架 — 需求文档

> 对应 Issue: [antgroup/YASA-Engine#129](https://github.com/antgroup/YASA-Engine/issues/129)
> 任务名称: `bootstrap_mcp_framework`
> 版本: v0.1.0
> 状态: 草案

---

## 1. 背景

YASA (Yet Another Static Analyzer) 计划对外开放一组程序分析能力作为 MCP (Model Context Protocol) 服务。MCP 是一种让 LLM 客户端（如 Claude Desktop、Cline 等）可以统一调用外部工具的协议。

在开发具体的 MCP 工具之前，需要先搭建一个**统一的 MCP Server 框架**，作为后续 14 个分析工具的运行底座。本任务不实现具体的分析能力，而是提供：

- 可启动的 MCP Server 进程
- 双传输模式（stdio / streamable-http）
- Tool 注册机制
- 统一的入参校验、错误处理、日志、健康检查

## 2. 目标读者

- MCP 框架开发者（本任务执行者）
- 后续 MCP Tool 开发者（基于此框架编写分析工具）
- 集成方 / 最终用户（在 Claude Desktop / Cline 等客户端中配置使用）

## 3. 功能性需求

### 3.1 FR-1: MCP Server 进程启动

| 编号 | 需求 | 优先级 |
|------|------|--------|
| FR-1.1 | 框架可作为 Python 模块启动: `python -m yasa_mcp` | P0 |
| FR-1.2 | 支持命令行参数配置启动行为 | P0 |
| FR-1.3 | 支持环境变量配置（至少 `YASA_MCP_REPO_ROOT`） | P0 |
| FR-1.4 | 启动时打印 server 名称、版本、传输模式等基本信息 | P1 |

### 3.2 FR-2: 传输模式

| 编号 | 需求 | 优先级 |
|------|------|--------|
| FR-2.1 | 支持 `stdio` 传输模式（默认），通过标准输入/输出与 MCP 客户端通信 | P0 |
| FR-2.2 | 支持 `streamable-http` 传输模式，监听指定端口提供 HTTP 服务 | P0 |
| FR-2.3 | HTTP 模式下提供 `GET /healthz` 健康检查端点，返回 200 | P0 |
| FR-2.4 | 传输模式通过 `--transport` 参数切换，默认 `stdio` | P0 |

### 3.3 FR-3: Tool 注册机制

| 编号 | 需求 | 优先级 |
|------|------|--------|
| FR-3.1 | 提供装饰器或注册表方式注册 MCP Tool | P0 |
| FR-3.2 | 后续 Tool 开发者只需编写 tool 函数本身，无需关心传输层细节 | P0 |
| FR-3.3 | Tool 注册时自动生成 MCP schema（名称、描述、参数定义） | P0 |
| FR-3.4 | 框架内置一个 demo tool `ping`，返回 server 状态信息 | P0 |

### 3.4 FR-4: 入参校验

| 编号 | 需求 | 优先级 |
|------|------|--------|
| FR-4.1 | 框架对每个 tool 的入参进行类型与必填校验 | P0 |
| FR-4.2 | 校验失败时返回结构化错误信息，不导致进程崩溃 | P0 |
| FR-4.3 | 校验规则基于 tool 注册时声明的参数 schema 自动生成 | P0 |

### 3.5 FR-5: 错误处理

| 编号 | 需求 | 优先级 |
|------|------|--------|
| FR-5.1 | Tool 执行异常被框架统一捕获，返回 MCP 错误响应 | P0 |
| FR-5.2 | 框架自身异常（如端口占用、配置缺失）有明确错误提示并优雅退出 | P0 |
| FR-5.3 | 错误响应包含错误码、错误消息、可选堆栈（debug 模式） | P1 |

### 3.6 FR-6: 日志

| 编号 | 需求 | 优先级 |
|------|------|--------|
| FR-6.1 | 框架提供统一日志器，支持 debug/info/warn/error 四级 | P0 |
| FR-6.2 | 日志级别通过 `--log-level` 参数控制，默认 info | P0 |
| FR-6.3 | stdio 模式下日志输出到 stderr（不干扰 stdout 上的 MCP 通信） | P0 |
| FR-6.4 | 日志格式包含时间戳、级别、模块名、消息 | P1 |

### 3.7 FR-7: 健康检查

| 编号 | 需求 | 优先级 |
|------|------|--------|
| FR-7.1 | HTTP 模式下 `GET /healthz` 返回 200 及 server 状态 JSON | P0 |
| FR-7.2 | 健康检查响应包含 server_name、version、status 字段 | P0 |

## 4. 非功能性需求

### 4.1 NFR-1: 技术选型

| 编号 | 需求 | 优先级 |
|------|------|--------|
| NFR-1.1 | 使用 Python 实现 MCP Server 框架 | P0 |
| NFR-1.2 | 优先使用 `fastmcp` SDK，备选官方 `mcp` 包 | P0 |
| NFR-1.3 | Python 版本 >= 3.10 | P0 |

### 4.2 NFR-2: 可维护性

| 编号 | 需求 | 优先级 |
|------|------|--------|
| NFR-2.1 | 框架代码结构清晰，Tool 注册与传输层解耦 | P0 |
| NFR-2.2 | 后续新增 Tool 只需在一个目录下新增文件，无需修改框架核心代码 | P0 |
| NFR-2.3 | 提供类型注解（type hints） | P1 |

### 4.3 NFR-3: 可测试性

| 编号 | 需求 | 优先级 |
|------|------|--------|
| NFR-3.1 | 单元测试覆盖 Tool 注册流程 | P0 |
| NFR-3.2 | 单元测试覆盖参数校验失败场景 | P0 |
| NFR-3.3 | 单元测试覆盖日志输出格式 | P0 |

### 4.4 NFR-4: 文档

| 编号 | 需求 | 优先级 |
|------|------|--------|
| NFR-4.1 | README 包含本地启动说明 | P0 |
| NFR-4.2 | README 包含 Claude Desktop 配置示例（`claude_desktop_config.json` 片段） | P0 |
| NFR-4.3 | README 包含 Cline 配置示例 | P1 |

## 5. 启动参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `--transport` | enum(stdio, http) | 否 | stdio | 传输模式 |
| `--port` | int | 否 | 8765 | http 模式监听端口 |
| `--log-level` | enum(debug, info, warn, error) | 否 | info | 日志级别 |
| `YASA_MCP_REPO_ROOT` | env | 是 | — | 被分析的代码仓库根目录 |

## 6. Demo Tool `ping` 输出

```json
{
  "status": "ok",
  "server_name": "yasa-mcp",
  "version": "0.1.0",
  "transports_supported": ["stdio", "streamable-http"]
}
```

## 7. 验收标准

- [ ] `python -m yasa_mcp --transport stdio` 能启动并通过 MCP inspector 通信
- [ ] `python -m yasa_mcp --transport http --port 8765` 能启动 HTTP 服务，`GET /healthz` 返回 200
- [ ] 注册一个 demo tool `ping`，在 Claude Desktop / Cline 客户端中可被发现并调用
- [ ] README 包含至少一个 Claude Desktop 配置示例（`claude_desktop_config.json` 片段）
- [ ] 单元测试覆盖：tool 注册、参数校验失败、日志输出格式

## 8. 预估工作量

2-3 人日（熟悉 MCP 协议的同学 1 人日即可）

## 9. 术语表

| 术语 | 说明 |
|------|------|
| MCP | Model Context Protocol，LLM 客户端与外部工具通信的标准协议 |
| stdio | 标准输入/输出传输模式，适用于本地集成 |
| streamable-http | HTTP 传输模式，适用于远程/网络集成 |
| MCP Inspector | MCP 官方提供的调试工具，用于测试 MCP Server |
| Claude Desktop | Anthropic 的桌面客户端，支持 MCP |
| Cline | VS Code 插件，支持 MCP |

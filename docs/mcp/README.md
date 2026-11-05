# YASA MCP 服务框架文档

> 对应 Issue: [antgroup/YASA-Engine#129](https://github.com/antgroup/YASA-Engine/issues/129) — `bootstrap_mcp_framework`

本目录包含 YASA MCP Server 框架的全部设计文档。

## 文档列表

| 文档 | 说明 | 读者 |
|------|------|------|
| [需求文档](requirements.md) | 功能性与非功能性需求、验收标准 | 全体成员 |
| [系统设计文档](system-design.md) | 架构、模块划分、接口设计、数据流、部署方案 | 框架开发者、Tool 开发者 |
| [开发文档](development-guide.md) | 环境准备、分步实现、代码示例、测试、客户端配置 | 框架开发者、Tool 开发者 |

## 概述

YASA 计划对外开放一组程序分析能力作为 MCP (Model Context Protocol) 服务。本任务 (`bootstrap_mcp_framework`) 的目标是搭建统一的 MCP Server 框架，作为后续 14 个分析工具的运行底座。

框架提供:
- **双传输模式**: stdio / streamable-http
- **Tool 注册机制**: 装饰器 + 自动发现，后续开发者只需写 tool 函数
- **统一横切关注点**: 入参校验、错误处理、日志、健康检查

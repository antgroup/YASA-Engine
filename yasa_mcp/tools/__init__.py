# -*- coding: utf-8 -*-
"""
yasa_mcp.tools —— 业务 MCP 工具包
=================================

框架启动时通过 auto_discover_tools() 自动扫描本目录下所有模块，
把被 @mcp_tool 装饰的函数注册为 MCP Tool。

新增工具三步：
    1. 在本目录新建模块文件（如 search_code_by_keyword.py）；
    2. 用 @mcp_tool(name=..., description=...) 装饰 tool 函数；
    3. 重启服务，工具自动生效（无需修改框架核心代码）。
"""
from __future__ import annotations

__all__ = []

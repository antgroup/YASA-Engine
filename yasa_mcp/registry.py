# -*- coding: utf-8 -*-
"""
registry.py —— Tool 自动发现与注册
==================================

服务启动时调用 auto_discover_tools()，自动扫描 yasa_mcp/tools/ 目录下
所有使用 @mcp_tool 装饰器标记的函数，并注册到 FastMCP 实例。

后续 Tool 开发者只需：
    1. 在 yasa_mcp/tools/ 下新建一个模块文件；
    2. 用 @mcp_tool(name=..., description=...) 装饰 tool 函数。
无需修改任何框架核心代码，重启服务即自动生效。
"""
from __future__ import annotations

import importlib
import logging
import pkgutil
from typing import Any, Callable, List, Set

from fastmcp import FastMCP

from yasa_mcp.config import LOGGER_NAME
from yasa_mcp.decorators import _MCP_TOOL_META_ATTR

logger = logging.getLogger(LOGGER_NAME)


def auto_discover_tools(
    mcp: FastMCP,
    package_name: str = "yasa_mcp.tools",
) -> List[str]:
    """
    自动扫描指定包下所有模块，把被 @mcp_tool 装饰的函数注册到 FastMCP 实例。

    Args:
        mcp:         FastMCP 实例。
        package_name: 要扫描的包名（默认 "yasa_mcp.tools"）。

    Returns:
        已注册的 tool 名称列表（顺序与扫描到的模块顺序一致）。

    Note:
        已在当前 mcp 实例上注册过的工具会被跳过（幂等，避免重复注册报错）。
        幂等状态挂在 mcp 实例属性上，因此不同 mcp 实例互不影响。
    """
    registered: List[str] = []

    # 每个 mcp 实例单独记录已注册集合，保证多次调用 / 多实例测试互不干扰
    registered_set: Set[str] = getattr(mcp, "_yasa_registered_tools", set())

    try:
        package = importlib.import_module(package_name)
    except ImportError as exc:
        logger.error("无法导入 tools 包 '%s': %s", package_name, exc)
        return registered

    package_path = getattr(package, "__path__", None)
    if package_path is None:
        logger.error("包 '%s' 没有 __path__，无法扫描", package_name)
        return registered

    for _, module_name, _ in pkgutil.iter_modules(package_path):
        full_name = f"{package_name}.{module_name}"
        try:
            module = importlib.import_module(full_name)
        except Exception as exc:  # noqa: BLE001 —— 单个 tool 失败不阻塞整体启动
            logger.error("导入 tool 模块 '%s' 失败: %s", full_name, exc)
            continue

        for attr_name in dir(module):
            obj = getattr(module, attr_name)
            meta = getattr(obj, _MCP_TOOL_META_ATTR, None)
            # 仅注册「被 @mcp_tool 装饰」的可调用对象
            if meta is None or not callable(obj):
                continue

            tool_name: str = meta.get("name") or attr_name
            if tool_name in registered_set:
                logger.debug("Tool '%s' 已注册，跳过", tool_name)
                continue

            try:
                mcp.tool(
                    name=tool_name,
                    description=meta.get("description") or "",
                )(obj)
            except Exception as exc:  # noqa: BLE001
                logger.error("注册 tool '%s' 失败: %s", tool_name, exc)
                continue

            registered_set.add(tool_name)
            registered.append(tool_name)
            logger.info("已注册 tool: %s", tool_name)

    setattr(mcp, "_yasa_registered_tools", registered_set)
    return registered

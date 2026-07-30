"""
Tool 注册机制: 装饰器 + 自动发现

后续 Tool 开发者只需在 yasa_mcp/tools/ 目录下新建文件，
使用 @mcp_tool 装饰器标记函数，框架启动时自动扫描并注册。
无需修改任何框架核心代码。
"""

from __future__ import annotations

import importlib
import pkgutil
import logging
from typing import Callable, Any

from fastmcp import FastMCP

logger = logging.getLogger("yasa_mcp.registry")

# 属性名，用于在函数上标记 tool 元数据
_MCP_TOOL_META_ATTR = "_mcp_tool_meta"


def mcp_tool(
    name: str,
    description: str,
) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
    """
    装饰器: 将函数标记为 MCP Tool。

    框架启动时，auto_discover_tools() 会扫描 tools/ 目录，
    找到所有被此装饰器标记的函数，注册到 FastMCP 实例。

    用法::

        @mcp_tool(name="ping", description="Health check")
        async def ping() -> dict:
            return {"status": "ok"}

    Args:
        name: MCP tool 名称（在 tools/list 中显示）
        description: tool 描述（在 tools/list 中显示）
    """

    def decorator(func: Callable[..., Any]) -> Callable[..., Any]:  # 装饰器，装饰一下这个东西
        setattr(func, _MCP_TOOL_META_ATTR, { # 属性名为_MCP_TOOL_META_ATTR，内部有两个属性
            "name": name,
            "description": description,
        })
        logger.debug("Tool marked for registration: %s", name)
        return func

    return decorator


def auto_discover_tools(
    mcp: FastMCP,
    package_name: str = "yasa_mcp.tools",
) -> list[str]:
    """
    自动扫描指定包下所有模块，找到使用 @mcp_tool 装饰的函数，
    注册到 FastMCP 实例。

    Args:
        mcp: FastMCP 实例
        package_name: 要扫描的包名（默认 "yasa_mcp.tools"）

    Returns:
        已注册的 tool 名称列表
    """
    registered: list[str] = []

    try:
        package = importlib.import_module(package_name) # 自动扫描，动态导入包
    except ImportError as e:
        logger.error("Failed to import tools package '%s': %s", package_name, e)
        return registered

    package_path = getattr(package, "__path__", None) # 获取包路径
    if package_path is None:
        logger.error("Package '%s' has no __path__, cannot scan", package_name)
        return registered

    for _, module_name, _ in pkgutil.iter_modules(package_path):
        full_name = f"{package_name}.{module_name}"
        try:
            module = importlib.import_module(full_name)
        except Exception as e:
            logger.error("Failed to import tool module '%s': %s", full_name, e)
            continue

        for attr_name in dir(module):  # 遍历模块中的所有属性
            attr = getattr(module, attr_name)
            if (
                callable(attr)
                and hasattr(attr, _MCP_TOOL_META_ATTR)
                and getattr(attr, "__module__", None) == full_name
            ):  #  找到在本模块中定义且有mcptoolmeta属性的对象
                meta = getattr(attr, _MCP_TOOL_META_ATTR)
                tool_name = meta["name"]
                try:
                    mcp.tool(  #  注册到FastMCP
                        name=tool_name,
                        description=meta["description"],
                    )(attr)
                    registered.append(tool_name)
                    logger.info("Registered MCP tool: %s", tool_name)
                except Exception as e:
                    logger.error(
                        "Failed to register tool '%s': %s", tool_name, e
                    )

    return registered

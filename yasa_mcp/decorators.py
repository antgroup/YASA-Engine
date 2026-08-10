# -*- coding: utf-8 -*-
"""
decorators.py —— 统一工具注册装饰器 @mcp_tool
=============================================

脚手架为后续业务 MCP Tool 提供的「唯一注册入口」。在 tools/ 目录下
用 @mcp_tool 装饰的函数，会在服务启动时被 auto_discover_tools() 自动扫描、
注册到 FastMCP 实例，全程无需修改任何框架核心代码。

装饰器底层封装了三件事：
    1. 入参类型校验   —— 由 fastmcp / pydantic 依据函数签名自动生成参数模型；
    2. 必填非空校验   —— 对「必填（无默认值）的字符串参数」额外做非空增强；
    3. 统一异常捕获   —— 工具抛错不崩溃服务，转为标准化错误 JSON 返回。

典型用法：
    from yasa_mcp.decorators import mcp_tool

    @mcp_tool(name="add", description="两数相加")
    async def add(a: int, b: int) -> int:
        \"\"\"两数相加\"\"\"
        return a + b

说明：装饰器内部用 functools.wraps + __signature__ 保留原函数签名，
      fastmcp 才能据此自动生成 pydantic 参数模型（类型校验 / 必填校验）。
"""
from __future__ import annotations

import functools
import inspect
import logging
from typing import Any, Callable, Dict, Optional

from yasa_mcp.config import LOGGER_NAME
from yasa_mcp.errors import make_error_response

logger = logging.getLogger(LOGGER_NAME)

# 用于在函数对象上标记 tool 元数据的属性名
_MCP_TOOL_META_ATTR = "_mcp_tool_meta"


# ---------------------------------------------------------------------------
# 内部校验逻辑
# ---------------------------------------------------------------------------
def _validate_required_not_empty(
    func: Callable, kwargs: Dict[str, Any]
) -> Optional[Dict[str, Any]]:
    """
    对「必填（无默认值）的字符串参数」做非空校验。

    空串 / 纯空格判定为非法，返回标准化错误；校验通过返回 None。
    （类型校验交给 fastmcp / pydantic 在调用前自动完成，这里只做非空增强）
    """
    try:
        sig = inspect.signature(func)
    except (TypeError, ValueError):
        return None  # 拿不到签名则不校验，保持向后兼容

    for name, param in sig.parameters.items():
        # 跳过带默认值（即可选）的参数
        if param.default is not inspect.Parameter.empty:
            continue
        value = kwargs.get(name)
        # 只对字符串做非空判断；None / 其它类型交由 pydantic 处理
        if isinstance(value, str) and not value.strip():
            return make_error_response(
                code="INVALID_PARAM",
                message=f"参数 '{name}' 不能为空",
                error_type="ValidationError",
                params={name: value},
            )
    return None


def _invoke_with_error_guard(
    func: Callable, kwargs: Dict[str, Any]
) -> Any:
    """
    统一异常捕获：调用原函数，抛错时返回标准化错误 JSON（不崩溃服务）。

    注意：调用 async 函数返回的是协程（此时异常尚未发生），因此本函数
    不负责 await；由外层包装函数在 try 块内 await。这里只兜底「同步抛错」
    （如函数体在创建协程前抛错、或同步函数直接抛错）。
    """
    try:
        return func(**kwargs)
    except Exception as exc:  # noqa: BLE001 —— 工具层异常必须全量兜底
        return _build_error_response(exc, kwargs, getattr(func, "__name__", func))


def _build_error_response(exc: Exception, kwargs: Dict[str, Any], func_name: str) -> Dict[str, Any]:
    """把异常转为标准化错误 JSON。"""
    logger.error("Tool '%s' 执行异常: %s: %s", func_name, type(exc).__name__, exc)
    return make_error_response(
        code="INTERNAL_ERROR",
        message=f"{type(exc).__name__}: {exc}",
        error_type=type(exc).__name__,
        params=kwargs,
    )


# ---------------------------------------------------------------------------
# 注册装饰器
# ---------------------------------------------------------------------------
def mcp_tool(
    name: Optional[str] = None,
    description: Optional[str] = None,
) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
    """
    将函数标记为 MCP Tool，并注入统一的校验 / 错误处理逻辑。

    用法：:

        @mcp_tool(name="ping", description="探测服务在线状态")
        async def ping() -> dict:
            return {"status": "ok"}

    Args:
        name:        MCP tool 名称（tools/list 中显示；缺省用函数名）。
        description: tool 描述（tools/list 中显示；缺省用 docstring 首行）。

    Returns:
        装饰器。返回的包装函数保留了原始函数签名（供 fastmcp 生成参数模型），
        同时带有 _mcp_tool_meta 元数据，供 auto_discover_tools 识别注册。
    """
    def decorator(func: Callable[..., Any]) -> Callable[..., Any]:
        tool_name = name or func.__name__
        tool_desc = description or _docstring_first_line(func)
        meta: Dict[str, Any] = {"name": tool_name, "description": tool_desc}
        setattr(func, _MCP_TOOL_META_ATTR, meta)

        @functools.wraps(func)
        async def async_wrapper(*args: Any, **kwargs: Any) -> Any:
            err = _validate_required_not_empty(func, kwargs)
            if err is not None:
                return err
            try:
                result = func(**kwargs)
                if inspect.isawaitable(result):
                    result = await result  # 在 try 内 await，异常才能被捕获
                return result
            except Exception as exc:  # noqa: BLE001 —— 工具层异常必须全量兜底
                return _build_error_response(exc, kwargs, tool_name)

        @functools.wraps(func)
        def sync_wrapper(*args: Any, **kwargs: Any) -> Any:
            err = _validate_required_not_empty(func, kwargs)
            if err is not None:
                return err
            return _invoke_with_error_guard(func, kwargs)

        # 选择与原函数一致的包装形态（异步工具 / 同步工具）
        wrapper = async_wrapper if inspect.iscoroutinefunction(func) else sync_wrapper

        # 显式保留原函数签名，fastmcp 据此生成 pydantic 参数模型
        wrapper.__signature__ = inspect.signature(func)
        setattr(wrapper, _MCP_TOOL_META_ATTR, meta)

        logger.debug("Tool marked for registration: %s", tool_name)
        return wrapper

    return decorator


def _docstring_first_line(func: Callable) -> str:
    """提取函数 docstring 的第一行作为默认描述。"""
    doc = inspect.getdoc(func)
    if not doc:
        return ""
    first = doc.strip().splitlines()[0].strip()
    return first

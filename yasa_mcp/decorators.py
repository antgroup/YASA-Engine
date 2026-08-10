# -*- coding: utf-8 -*-
"""
decorators.py —— 统一工具注册装饰器 @yasa_tool
=============================================

脚手架为后续业务 MCP Tool 提供的「唯一注册入口」，底层封装了：

    1. 基于 pydantic 的入参类型校验（由 fastmcp 依据函数签名自动生成参数模型）；
    2. 必填字符串参数的「非空」校验（脚手架额外增强）；
    3. 全局统一异常捕获：工具抛错不会让服务崩溃，而是返回标准化错误 JSON；
    4. 注册到 FastMCP 实例（等价于 mcp.tool()）。

典型用法：
    from yasa_mcp.decorators import yasa_tool
    from yasa_mcp.server import mcp

    @yasa_tool(mcp)                       # 统一注册 + 校验 + 异常捕获
    def add(a: int, b: int) -> int:
        \"\"\"两数相加\"\"\"
        return a + b

说明：装饰器内部用 functools.wraps + __signature__ 保留原函数签名，
      fastmcp 才能据此自动生成 pydantic 参数模型（类型校验 / 必填校验）。
"""
from __future__ import annotations

import functools
import inspect
import logging
from typing import Any, Callable, Dict, Optional, TypeVar

from yasa_mcp.config import LOGGER_NAME

logger = logging.getLogger(LOGGER_NAME)

# 类型变量，保持装饰器对函数签名 / 返回值类型的友好性
F = TypeVar("F", bound=Callable[..., Any])


# ---------------------------------------------------------------------------
# 标准化错误 JSON
# ---------------------------------------------------------------------------
def make_error_response(
    code: str,
    message: str,
    error_type: str = "Error",
    params: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """
    构造统一的「标准化错误」返回结构（工具报错不崩溃服务）。

    约定字段：
        status       : 固定为 "error"
        error.code   : 机器可读错误码
        error.type   : Python 异常类型名
        error.message: 人类可读错误信息
        error.params : 触发错误的入参快照（调试用，成功时为可选）
    """
    return {
        "status": "error",
        "error": {
            "code": code,
            "type": error_type,
            "message": message,
            "params": params or {},
        },
    }


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


def _execute_tool(func: Callable, args: tuple, kwargs: Dict[str, Any]) -> Any:
    """统一执行入口：非空校验 -> 执行函数 -> 全局异常捕获。"""
    # 1) 非空校验（类型校验由 fastmcp/pydantic 在调用前完成）
    err = _validate_required_not_empty(func, kwargs)
    if err is not None:
        return err

    # 2) 执行工具函数；任何异常都不向上抛，转为标准化错误 JSON，服务不崩溃
    try:
        return func(*args, **kwargs)
    except Exception as exc:  # noqa: BLE001 —— 全局兜底，刻意捕获所有异常
        logger.exception(
            "[yasa_tool] 工具执行失败: %s.%s", func.__module__, func.__qualname__
        )
        return make_error_response(
            code="TOOL_EXECUTION_ERROR",
            message=str(exc) or exc.__class__.__name__,
            error_type=exc.__class__.__name__,
        )


# ---------------------------------------------------------------------------
# 公开装饰器
# ---------------------------------------------------------------------------
def yasa_tool(mcp, name: Optional[str] = None, description: Optional[str] = None):
    """
    统一工具注册装饰器（脚手架底层通用能力 #1）。

    参数：
        mcp         : FastMCP 实例（通常传入 yasa_mcp.server 中的全局 mcp）
        name        : 可选，覆盖工具名（默认取函数名）
        description : 可选，覆盖工具描述（默认取函数 docstring）

    返回：
        等价于 fastmcp 的 mcp.tool() 注册结果。

    内部实现要点：
        - 用 functools.wraps 保留函数名、docstring、__annotations__；
        - 显式设置 __signature__ = 原函数签名，
          使 fastmcp 能据此自动生成 pydantic 参数模型（类型/必填校验）；
        - 依据原函数「同步/异步」特性生成对应包装器，保持行为一致。
    """

    def decorator(func: F) -> F:
        # ---- 依据原函数同步 / 异步特性，生成对应包装器 ----
        if inspect.iscoroutinefunction(func):

            @functools.wraps(func)
            async def async_wrapper(*args: Any, **kwargs: Any) -> Any:
                return await _execute_tool(func, args, kwargs)

            wrapper = async_wrapper
        else:

            @functools.wraps(func)
            def sync_wrapper(*args: Any, **kwargs: Any) -> Any:
                return _execute_tool(func, args, kwargs)

            wrapper = sync_wrapper

        # 显式声明原始签名：fastmcp 依赖它生成工具参数模型
        wrapper.__signature__ = inspect.signature(func)  # type: ignore[attr-defined]

        # ---- 注册到 FastMCP 实例 ----
        return mcp.tool(name=name, description=description)(wrapper)

    return decorator

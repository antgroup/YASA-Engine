# -*- coding: utf-8 -*-
"""
errors.py —— 标准化错误结构
============================

所有 tool 抛出的异常统一转换为如下结构返回（工具不崩溃服务）：

    {
        "status": "error",
        "error": {
            "code":     "机器可读错误码",
            "type":     "Python 异常类型名",
            "message":  "人类可读错误信息",
            "params":   "触发错误的入参快照（调试用）",
        },
    }
"""
from __future__ import annotations

from typing import Any, Dict, Optional


def make_error_response(
    code: str,
    message: str,
    error_type: str = "Error",
    params: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """
    构造统一的「标准化错误」返回结构。

    Args:
        code:       机器可读错误码，如 INVALID_PARAM / REGEX_ERROR。
        message:    人类可读错误信息。
        error_type: Python 异常类型名（默认 "Error"）。
        params:     触发错误的入参快照（调试用，可省略）。

    Returns:
        符合框架约定结构的错误字典，可直接作为 tool 返回值。
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

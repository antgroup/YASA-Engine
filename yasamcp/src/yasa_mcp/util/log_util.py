from __future__ import annotations

import logging
import uuid
from contextvars import ContextVar
from dataclasses import dataclass, field
from typing import Any
from pathlib import Path


@dataclass
class Task:
    """上游传入的任务上下文信息，用于统一打日志前缀。"""

    task_id: str | None = None
    project_path: Path | None = None
    language: str | None = None
    # 预留扩展字段，比如 request_id / user_id 等
    extra: dict[str, Any] = field(default_factory=dict)

    def to_prefix(self) -> str:
        """格式化为日志前缀字符串，例如: [task_id=xxx project=yyy lang=java]."""
        parts: list[str] = []
        if self.task_id:
            parts.append(f"task_id={self.task_id}")
        if self.project_path:
            parts.append(f"project={self.project_path}")
        if self.language:
            parts.append(f"lang={self.language}")
        for k, v in self.extra.items():
            parts.append(f"{k}={v}")
        return "[" + " ".join(parts) + "]"


# ----------------------------------------------------------------------
# 全局 Task 上下文：用于自动给日志加上当前任务前缀
# ----------------------------------------------------------------------
_current_task: ContextVar[Task | None] = ContextVar("current_task", default=None)
_current_logger: ContextVar[logging.Logger | None] = ContextVar("current_logger", default=None)


def set_current_task(task: Task | None) -> None:
    """设置当前线程/协程中的 Task，上下层所有 log_util 调用都会带上它。"""
    _current_task.set(task)


def get_current_task() -> Task | None:
    """获取当前线程/协程中的 Task。"""
    return _current_task.get()


def new_default_task(project_path: Path | None = None) -> None:
    """创建一个新的默认 Task，用于自动给日志加上当前任务前缀。"""

    # 初始化日志上下文
    task_id = str(uuid.uuid4())
    task = Task(task_id=task_id, project_path=project_path)
    _current_task.set(task)


def set_current_logger(logger: logging.Logger | None) -> None:
    """设置当前上下文的 Logger，设置后 log_util 将优先使用该 Logger 输出日志。"""
    _current_logger.set(logger)


def get_current_logger() -> logging.Logger | None:
    """获取当前上下文的 Logger。"""
    return _current_logger.get()


_logger_hierarchy_attached = False


def _attach_to_host_logger():
    """将 yasa_mcp 根 logger 的 parent 指向宿主 yasamcpserver logger，
    使 SDK 深层模块（logger name 以 yasa_mcp. 开头）的日志也能写入 yasamcpserver.log。
    """
    global _logger_hierarchy_attached
    if _logger_hierarchy_attached:
        return
    yasa_mcp_logger = logging.getLogger('yasa_mcp')
    for name, lg in logging.Logger.manager.loggerDict.items():
        if isinstance(lg, logging.Logger) and name == 'yasamcpserver' and lg.handlers:
            yasa_mcp_logger.parent = lg
            yasa_mcp_logger.propagate = True
            _logger_hierarchy_attached = True
            break


def _ensure_logger(logger: logging.Logger | None) -> logging.Logger:
    # 方案1：挂载 logger 层级关系，使 yasa_mcp.* 日志传播到 yasamcpserver FileHandler
    _attach_to_host_logger()
    # 优先使用上下文注入的 Logger
    ctx_logger = get_current_logger()
    if ctx_logger:
        return ctx_logger
    return logger or logging.getLogger(__name__)



def _format_message(task: Task | None, message: str) -> str:
    task = task or get_current_task()
    if task is None:
        return message
    return f"{task.to_prefix()} {message}"


def debug(message: str, task: Task | None = None, logger: logging.Logger | None = None, *args, **kwargs) -> None:
    """调试日志：统一带上 Task 前缀。"""
    if "stacklevel" not in kwargs:
        kwargs["stacklevel"] = 2
    _ensure_logger(logger).debug(_format_message(task, message), *args, **kwargs)


def info(message: str, task: Task | None = None, logger: logging.Logger | None = None, *args, **kwargs) -> None:
    """信息日志：统一带上 Task 前缀。"""
    if "stacklevel" not in kwargs:
        kwargs["stacklevel"] = 2
    _ensure_logger(logger).info(_format_message(task, message), *args, **kwargs)


def warning(message: str, task: Task | None = None, logger: logging.Logger | None = None, *args, **kwargs) -> None:
    """告警日志：统一带上 Task 前缀。"""
    if "stacklevel" not in kwargs:
        kwargs["stacklevel"] = 2
    _ensure_logger(logger).warning(_format_message(task, message), *args, **kwargs)


def error(message: str, task: Task | None = None, logger: logging.Logger | None = None, *args, **kwargs) -> None:
    """错误日志：统一带上 Task 前缀。"""
    if "stacklevel" not in kwargs:
        kwargs["stacklevel"] = 2
    _ensure_logger(logger).error(_format_message(task, message), *args, **kwargs)


def exception(message: str, task: Task | None = None, logger: logging.Logger | None = None, *args, **kwargs) -> None:
    """异常日志：统一带上 Task 前缀，并附带堆栈。"""
    if "stacklevel" not in kwargs:
        kwargs["stacklevel"] = 2
    _ensure_logger(logger).exception(_format_message(task, message), *args, **kwargs)


def log_time(task: Task | None, message: str, logger: logging.Logger | None = None) -> None:
    """兼容旧接口的简单计时日志封装。"""
    info(message, task=task, logger=logger, stacklevel=3)

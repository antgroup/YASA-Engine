import inspect
import json
import logging
import time
from functools import wraps
from pathlib import Path

from yasa_mcp.config import global_config
from yasa_mcp.util import log_util


_SLOW_ARG_LOG_LEVELS = {
    "authscan_service",
    "code_search_service",
    "callgraph_service",
    "realtime_analysis",
}

_SKIP_ARG_NAMES = {"self", "cls", "context"}
_MAX_STRING_LENGTH = 500


def _get_slow_request_threshold_ms() -> int:
    return global_config.service_slow_request_log_threshold_ms or 3_000


def _should_log_slow_args(level1: str, duration_ms: int) -> bool:
    threshold_ms = _get_slow_request_threshold_ms()
    return (
            0 < threshold_ms <= duration_ms
            and level1 in _SLOW_ARG_LOG_LEVELS
    )


def _truncate_text(value: str, max_length: int = _MAX_STRING_LENGTH) -> str:
    if len(value) <= max_length:
        return value
    return f"{value[:max_length]}...(truncated, length={len(value)})"


def _is_context_like(value: object) -> bool:
    type_name = type(value).__name__
    module_name = type(value).__module__
    return "Context" in type_name or module_name.endswith(".context")


def _serialize_arg(value: object, seen: set[int] | None = None) -> object:
    if _is_context_like(value):
        return None
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        return _truncate_text(value)
    if isinstance(value, Path):
        return str(value)

    if seen is None:
        seen = set()
    value_id = id(value)
    if value_id in seen:
        return "<recursive>"
    seen.add(value_id)

    try:
        try:
            from pydantic import BaseModel

            if isinstance(value, BaseModel):
                return _serialize_arg(value.model_dump(mode="json"), seen)
        except Exception:
            pass

        if isinstance(value, dict):
            return {str(k): _serialize_arg(v, seen) for k, v in value.items()}
        if isinstance(value, (list, tuple, set)):
            return [_serialize_arg(item, seen) for item in value]

        return _truncate_text(repr(value))
    finally:
        seen.discard(value_id)


def _format_slow_args(bound_arguments: dict[str, object] | None) -> str:
    if not bound_arguments:
        return "{}"

    safe_args: dict[str, object] = {}
    for name, value in bound_arguments.items():
        if name in _SKIP_ARG_NAMES or _is_context_like(value):
            continue
        if value is None:
            safe_args[name] = None
            continue
        serialized = _serialize_arg(value)
        if serialized is not None:
            safe_args[name] = serialized

    try:
        args_json = json.dumps(safe_args, ensure_ascii=False, separators=(",", ":"))
    except Exception:
        args_json = json.dumps(
            {k: _truncate_text(repr(v), 200) for k, v in safe_args.items()},
            ensure_ascii=False,
            separators=(",", ":"),
        )
    return args_json


class Timer:
    """
    记录耗时日志：
    level1: 阶段名
    level2: 子阶段名
    """

    def __init__(self, logger: logging.Logger, level1: str, level2: str, project_name: str = None):
        self.logger = logger
        self.level1 = level1
        self.level2 = level2
        self.project_name = project_name
        self.start_time = None
        self.end_time = None

    def start(self, func_name):
        self.start_time = time.perf_counter_ns()

    def stop(self, func_name, bound_arguments: dict[str, object] | None = None):
        self.end_time = time.perf_counter_ns()
        time_in_millis = (self.end_time - self.start_time) // 1_000_000
        msg = f"level1={self.level1}, level2={self.level2}, duration={time_in_millis} ms"
        if self.project_name:
            msg += f", project={self.project_name}"
        if _should_log_slow_args(self.level1, time_in_millis):
            msg += f", function={func_name}, args={_format_slow_args(bound_arguments)}"
        log_util.info(
            msg,
            logger=self.logger,
            stacklevel=3,
        )


def timed(logger: logging.Logger, level1: str, level2: str):
    """用 Timer 统计函数耗时的装饰器。"""

    def decorator(func):
        sig = inspect.signature(func)

        @wraps(func)
        def wrapper(*args, **kwargs):
            project_name = None
            bound_arguments = None
            try:
                bound_args = sig.bind(*args, **kwargs)
                bound_args.apply_defaults()
                bound_arguments = dict(bound_args.arguments)
                if "project_path" in bound_args.arguments:
                    val = bound_args.arguments["project_path"]
                    if val:
                        project_name = Path(val).name
            except Exception:
                pass

            timer = Timer(logger, level1, level2, project_name=project_name)
            timer.start(func.__name__)
            try:
                return func(*args, **kwargs)
            finally:
                timer.stop(func.__name__, bound_arguments=bound_arguments)

        return wrapper

    return decorator

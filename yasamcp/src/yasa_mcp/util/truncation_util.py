import asyncio
import json
import functools
import logging
import time
from typing import TypeVar

from pydantic import BaseModel

from yasa_mcp.service.models import YasaMcpResults
from yasa_mcp.util import log_util

logger = logging.getLogger(__name__)

T = TypeVar("T")

CHARS_PER_TOKEN = 4  # 保守估算：4 字符 ≈ 1 token


class _TruncationMeta(BaseModel):
    """截断工具内部使用的元信息类型"""
    truncated: bool = False
    total_count: int = 0


def estimate_tokens(text: str) -> int:
    """字符数整除估算 token 数，O(1) 操作"""
    return len(text) // CHARS_PER_TOKEN


def _serialize_item(item) -> str:
    """单条序列化，支持 Pydantic Model 和 dict"""
    if isinstance(item, BaseModel):
        return item.model_dump_json()
    return json.dumps(item, ensure_ascii=False)


def truncate_list_by_tokens(
    items: list[T],
    max_output_tokens: int,
) -> tuple[list[T], _TruncationMeta]:
    """
    对 items 列表按 token 数进行截断。

    算法：逐条序列化并累加 token 数，超限时立即停止。
    每条 item 只序列化一次，时间复杂度 O(k)，k 为实际返回条目数。

    返回 (truncated_items, meta)
    """
    start = time.perf_counter()
    total = len(items)

    if max_output_tokens <= 0:
        elapsed_ms = (time.perf_counter() - start) * 1000
        log_util.info(
            f"truncate_list_by_tokens: total={total}, kept={total}, "
            f"truncated=False, max_output_tokens={max_output_tokens}, duration={elapsed_ms:.1f} ms",
            logger=logger,
        )
        return items, _TruncationMeta(truncated=False, total_count=total)

    # 预留 JSON 数组外框开销: "[]" + 逗号分隔符
    overhead_chars = 2 + max(total - 1, 0)  # [] + commas
    accumulated_tokens = estimate_tokens(" " * overhead_chars)  # 转换为 token

    kept_count = 0
    for item in items:
        item_json = _serialize_item(item)
        item_tokens = estimate_tokens(item_json)

        if accumulated_tokens + item_tokens > max_output_tokens:
            break

        accumulated_tokens += item_tokens
        kept_count += 1

    truncated = kept_count < total
    kept_count = 1 if kept_count == 0 and total > 0 else kept_count  # 至少保留一条（如果有的话）
    elapsed_ms = (time.perf_counter() - start) * 1000
    log_util.info(
        f"truncate_list_by_tokens: total={total}, kept={kept_count}, "
        f"truncated={truncated}, max_output_tokens={max_output_tokens}, duration={elapsed_ms:.1f}ms",
        logger=logger,
    )
    return items[:kept_count], _TruncationMeta(
        truncated=truncated,
        total_count=kept_count,
    )


def _build_result(items, max_output_tokens):
    """将 list 截断并包装为 YasaMcpResults。"""
    # 如果已经是 YasaMcpResults，直接返回（避免实时分析路径的二次包装）
    if isinstance(items, YasaMcpResults):
        return items
    if not isinstance(items, list):
        items = [items] if items else []
    truncated_items, meta = truncate_list_by_tokens(items, max_output_tokens)
    return YasaMcpResults(
        results=truncated_items,
        truncated=meta.truncated,
        total_count=meta.total_count,
    )


def with_truncation(func):
    """
    Service 层截断切面装饰器。

    拦截返回的 list[T]，根据 max_output_tokens 参数截断后包装为 YasaMcpResults[T]。
    自动识别同步/异步函数，返回对应类型的 wrapper。

    要求调用时通过关键字参数传入 max_output_tokens。
    装饰器会从 kwargs 中提取并移除该参数，service 函数体内无需使用。
    """
    if asyncio.iscoroutinefunction(func):
        @functools.wraps(func)
        async def async_wrapper(*args, **kwargs):
            max_output_tokens = kwargs.pop("max_output_tokens", 0)
            items = await func(*args, **kwargs)
            return _build_result(items, max_output_tokens)
        return async_wrapper
    else:
        @functools.wraps(func)
        def sync_wrapper(*args, **kwargs):
            max_output_tokens = kwargs.pop("max_output_tokens", 0)
            items = func(*args, **kwargs)
            return _build_result(items, max_output_tokens)
        return sync_wrapper

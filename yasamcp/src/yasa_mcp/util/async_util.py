"""
异步工具模块

提供将同步阻塞调用提交到隔离线程池执行的包装器，
避免 IO 同步调用阻塞事件循环。

线程池分为 **fast** 和 **slow** 两个独立的 ``ThreadPoolExecutor``：
- fast（默认）：用于 code_search_service 等轻量 DuckDB 索引查询
- slow：用于 callgraph_service 等图遍历 + 大量文件 IO 的重操作

两个池完全隔离，慢接口的突发流量不会阻塞快接口。

用法：
1. run_sync_in_thread(func, *args, pool="fast") — 手动提交
2. @async_wrap             — 装饰器，默认进入 fast 池
3. @async_wrap(pool="slow") — 装饰器，进入 slow 池

注意：被 @async_wrap 装饰后的函数已是 async def，调用方应直接 await，
     不要再套 run_sync_in_thread，否则会在线程中创建未执行的协程对象。
"""

import asyncio
import atexit
import functools
import logging
import threading
from concurrent.futures import ThreadPoolExecutor
from contextvars import copy_context

from yasa_mcp.util import log_util

logger = logging.getLogger(__name__)

_pools_lock = threading.Lock()
_fast_pool: ThreadPoolExecutor | None = None
_slow_pool: ThreadPoolExecutor | None = None


def _get_pool(pool: str) -> ThreadPoolExecutor:
    """获取指定线程池（懒初始化，线程安全）。"""
    global _fast_pool, _slow_pool

    if pool == "fast" and _fast_pool is not None:
        return _fast_pool
    if pool == "slow" and _slow_pool is not None:
        return _slow_pool

    with _pools_lock:
        if pool == "fast":
            if _fast_pool is None:
                from yasa_mcp.config import global_config
                _fast_pool = ThreadPoolExecutor(
                    max_workers=global_config.fast_pool_size,
                    thread_name_prefix="yasa-fast-thread-pool",
                )
                log_util.info(f"fast 线程池已初始化: max_workers={global_config.fast_pool_size}", logger=logger)
            return _fast_pool
        else:
            if _slow_pool is None:
                from yasa_mcp.config import global_config
                _slow_pool = ThreadPoolExecutor(
                    max_workers=global_config.slow_pool_size,
                    thread_name_prefix="yasa-slow-thread-pool",
                )
                log_util.info(f"slow 线程池已初始化: max_workers={global_config.slow_pool_size}", logger=logger)
            return _slow_pool


async def run_sync_in_thread(func, *args, pool: str = "fast", **kwargs):
    """
    将同步函数提交到指定线程池执行，返回可 await 的协程。

    用法：
        result = await run_sync_in_thread(some_sync_func, arg1, pool="slow", key=val)
    """
    loop = asyncio.get_running_loop()
    executor = _get_pool(pool)
    ctx = copy_context()
    return await loop.run_in_executor(
        executor,
        ctx.run,
        functools.partial(func, *args, **kwargs),
    )


def async_wrap(func=None, *, pool: str = "fast"):
    """
    装饰器：将同步函数包装为 async 函数，提交到指定线程池执行。

    - ``@async_wrap``              — 默认进入 fast 池
    - ``@async_wrap(pool="slow")`` — 进入 slow 池

    示例::

        @async_wrap
        def light_query(ctx, param):
            ...

        @async_wrap(pool="slow")
        def heavy_traversal(ctx, param):
            ...

        result = await light_query(ctx, param)
        result = await heavy_traversal(ctx, param)
    """
    def decorator(fn):
        @functools.wraps(fn)
        async def wrapper(*args, **kwargs):
            loop = asyncio.get_running_loop()
            executor = _get_pool(pool)
            ctx = copy_context()
            return await loop.run_in_executor(
                executor,
                ctx.run,
                functools.partial(fn, *args, **kwargs),
            )
        return wrapper

    if func is not None:
        return decorator(func)
    return decorator


def shutdown_pools(wait: bool = True) -> None:
    """关闭所有线程池（用于进程退出清理）。"""
    global _fast_pool, _slow_pool
    with _pools_lock:
        for name, p in [("fast", _fast_pool), ("slow", _slow_pool)]:
            if p is not None:
                p.shutdown(wait=wait)
                log_util.info(f"{name} 线程池已关闭", logger=logger)
        _fast_pool = None
        _slow_pool = None


atexit.register(shutdown_pools)

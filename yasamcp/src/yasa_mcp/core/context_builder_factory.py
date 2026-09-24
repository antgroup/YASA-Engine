"""Builder 注册与并发执行。

Factory 只保存 Builder *类型*，每次请求都重新创建 Builder/Context；因此默认
Facade 可以安全复用，而不会把项目级状态泄漏到下一次构建。
"""

from __future__ import annotations

from collections import OrderedDict
from concurrent.futures import Future, ThreadPoolExecutor, as_completed, wait
import time
from typing import Callable

from yasa_mcp.core.context import YasaMcpContext
from yasa_mcp.core.context_builder import (
    CodeGraphContextBuilder,
    ContextBuilder,
    ContextBuildMode,
    ContextBuildRequest,
    ContextBuildResult,
    YasaContextBuilder,
)
from yasa_mcp.core.enums import Tool


class ContextBuildError(RuntimeError):
    """带 Tool 和 mode 归因的统一构建异常。"""

    def __init__(self, tool: Tool, mode: ContextBuildMode, cause: BaseException):
        super().__init__(
            f"Context build failed: tool={tool.value}, mode={mode.value}, "
            f"error={type(cause).__name__}: {cause}"
        )
        self.tool = tool
        self.mode = mode
        self.__cause__ = cause


class ContextBuilderFactory:
    """维护有序、唯一的 Builder 注册表并执行单批并行任务。

    Builder 在 Factory 组装阶段串行注册；请求执行阶段只读取注册表，不支持在
    ``execute`` 运行期间并发修改注册表。
    """

    def __init__(self) -> None:
        self._registry: OrderedDict[Tool, type[ContextBuilder]] = OrderedDict()

    @classmethod
    def default(cls) -> ContextBuilderFactory:
        factory = cls()
        factory.register(CodeGraphContextBuilder)
        factory.register(YasaContextBuilder)
        return factory

    def register(self, builder_type: type[ContextBuilder]) -> None:
        tool = builder_type.tool
        if tool in self._registry:
            # 注册接口保持幂等：同一 Tool 的首次绑定与顺序不会被后续调用覆盖。
            return
        self._registry[tool] = builder_type

    @property
    def registered_tools(self) -> tuple[Tool, ...]:
        return tuple(self._registry)

    def create_builders(
        self,
        request: ContextBuildRequest,
        root_context: YasaMcpContext,
    ) -> list[ContextBuilder]:
        # 每轮先复制有序注册表；Builder 初始化和本轮并发数都基于同一份快照。
        builder_types = tuple(self._registry.values())
        # Builder 持有单次 request/context，绝不能缓存到单例 Factory 的 registry 中。
        return [builder_type(request, root_context) for builder_type in builder_types]

    def execute(
        self,
        mode: ContextBuildMode,
        request: ContextBuildRequest,
        root_context: YasaMcpContext,
        on_done: Callable[[Tool, bool, float], None] | None = None,
    ) -> list[ContextBuildResult]:
        builders = self.create_builders(request, root_context)
        if not builders:
            return []

        # future → builder 映射；future 返回 (result, elapsed_ms) 元组，
        # 所以 elapsed 可在 on_done 回调里直接读到，不依赖线程局部变量。
        builder_by_future: dict[Future, ContextBuilder] = {}
        with ThreadPoolExecutor(max_workers=len(builders)) as executor:
            for builder in builders:
                fut = executor.submit(self._execute_with_elapsed, builder, mode)
                builder_by_future[fut] = builder
            # as_completed：每完成一个 builder 立即调 on_done，支持 init 进度条实时标记。
            for fut in as_completed(builder_by_future):
                builder = builder_by_future[fut]
                exc = fut.exception()
                if exc is not None:
                    elapsed = -1.0
                    ok = False
                else:
                    _, elapsed = fut.result()
                    ok = True
                if on_done is not None:
                    try:
                        on_done(builder.tool, ok, elapsed)
                    except Exception:
                        logger.exception("on_done 回调异常")

        # 即使先完成的 Future 已失败，也等待整批写任务退出；避免后台继续改缓存。
        # 归因按注册顺序而非完成顺序，确保并发下错误稳定、可复现。
        results: list[ContextBuildResult] = []
        for builder in builders:
            fut = next(f for f, b in builder_by_future.items() if b is builder)
            error = fut.exception()
            if error is not None:
                raise ContextBuildError(builder.tool, mode, error) from error
            result, _ = fut.result()
            results.append(result)
        return results

    @staticmethod
    def _execute_with_elapsed(
        builder: ContextBuilder,
        mode: ContextBuildMode,
    ) -> tuple[ContextBuildResult, float]:
        """执行单个 builder，返回 (result, elapsed_ms)。"""
        t0 = time.perf_counter()
        if mode == ContextBuildMode.LOAD:
            result = builder.load()
        else:
            result = builder.build(incremental=mode == ContextBuildMode.INCREMENTAL)
        return result, (time.perf_counter() - t0) * 1000.0

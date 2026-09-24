"""各分析 Tool 的 Context 构建契约与三态生命周期适配。

本模块只处理单个 Tool 的 create/build/load 差异；跨 Tool 并发、缓存提交和
readiness 发布分别由 Factory 与 Facade 负责。
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from types import MappingProxyType
from typing import ClassVar, Final, Mapping, cast

from yasa_mcp.config import global_config
from yasa_mcp.core.cache_status import CacheStatus
from yasa_mcp.core.context import YasaMcpContext
from yasa_mcp.core.enums import Language, Tool
from yasa_mcp.core.models import ReadPoolAware, ToolContext
from yasa_mcp.core.project_config import JSONValue, ProjectConfig
from yasa_mcp.layout.cache_layout import CacheLayout
from yasa_mcp.tools.codegraph.codegraph_context import CodeGraphContext
from yasa_mcp.tools.codegraph.codegraph_tool import CodeGraphTool
from yasa_mcp.tools.yasa.yasa_context import YasaContext
from yasa_mcp.tools.yasa.yasa_tool import YasaTool


class ContextBuildMode(str, Enum):
    """Factory 支持的三种 Context 生命周期。"""

    FULL = "full"
    INCREMENTAL = "incremental"
    LOAD = "load"


# 缓存检查结果与构建策略是稳定的领域映射，集中在 core，避免每个入口重复分支。
# 未列出的状态可能来自未来枚举或异常调用；安全起见回退全量构建，避免在未知基线上增量。
CACHE_STATUS_TO_BUILD_MODE: Final[Mapping[CacheStatus, ContextBuildMode]] = (
    MappingProxyType(
        {
            CacheStatus.FULL_UPDATE: ContextBuildMode.FULL,
            CacheStatus.NO_UPDATE: ContextBuildMode.LOAD,
            CacheStatus.INCREMENTAL_UPDATE: ContextBuildMode.INCREMENTAL,
        }
    )
)


def build_mode_for_cache_status(cache_status: object) -> ContextBuildMode:
    """把缓存检查结果转换为 Context 生命周期，未知状态默认走全量。"""

    return CACHE_STATUS_TO_BUILD_MODE.get(cache_status, ContextBuildMode.FULL)


@dataclass(frozen=True)
class ContextBuildRequest:
    """单次项目构建的不可变输入，Builder 不得把请求状态写回 Facade。"""

    project_path: Path
    cache_layout: CacheLayout
    resolved_languages: tuple[Language, ...]
    languages_from_scc: bool
    project_config: ProjectConfig | None = None


@dataclass(frozen=True)
class ContextBuildResult:
    """Builder 返回给 Facade 的统一结果，不暴露具体 Context 私有字段。"""

    tool: Tool
    context: ToolContext
    project_languages: tuple[Language, ...] | None = None
    codegraph_metadata: dict[str, JSONValue] | None = None
    read_pool_target: ReadPoolAware | None = None


class ContextBuilder(ABC):
    """单个 Tool 的 Context 生命周期适配器。"""

    tool: ClassVar[Tool]

    def __init__(self, request: ContextBuildRequest, root_context: YasaMcpContext):
        self.request = request
        self.root_context = root_context

    @abstractmethod
    def create_context(self) -> ToolContext:
        ...

    @abstractmethod
    def build(self, *, incremental: bool) -> ContextBuildResult:
        ...

    @abstractmethod
    def load(self) -> ContextBuildResult:
        ...


class CodeGraphContextBuilder(ContextBuilder):
    """构建 CodeGraph Context，并向 Facade 提交持久化 metadata。"""

    tool = Tool.CODEGRAPH

    def __init__(self, request: ContextBuildRequest, root_context: YasaMcpContext):
        super().__init__(request, root_context)
        self.context = self.create_context()

    def create_context(self) -> CodeGraphContext:
        tool = cast(CodeGraphTool, self.root_context.get_tool(self.tool))
        return CodeGraphContext(tool, self.request.cache_layout)

    def _result(self) -> ContextBuildResult:
        return ContextBuildResult(
            tool=self.tool,
            context=self.context,
            codegraph_metadata=dict(self.context.metadata),
        )

    def build(self, *, incremental: bool) -> ContextBuildResult:
        languages = list(self.request.resolved_languages)
        # 增量决策由入口统一转换为 mode，Builder 只适配具体 Context 的方法名。
        if incremental:
            self.context.build_context_use_incremental_mode(self.request.project_path, languages)
        else:
            self.context.build_context(self.request.project_path, languages)
        return self._result()

    def load(self) -> ContextBuildResult:
        project_config = self.request.project_config
        if project_config is None:
            raise ValueError("ProjectConfig is required to load CodeGraph context")
        # LOAD 必须使用已提交配置，不能重新推导 consumer DB 后悄悄改变缓存版本。
        self.context.load_context_from_cache(
            global_config.support_languages,
            project_config.project_path,
            project_config.codegraph,
        )
        return self._result()


class YasaContextBuilder(ContextBuilder):
    """构建 Yasa callgraph Context，并上报实际分析语言。"""

    tool = Tool.YASA

    def __init__(self, request: ContextBuildRequest, root_context: YasaMcpContext):
        super().__init__(request, root_context)
        self.context = self.create_context()

    def create_context(self) -> YasaContext:
        tool = cast(YasaTool, self.root_context.get_tool(self.tool))
        return YasaContext(tool, self.request.cache_layout)

    def _result(self) -> ContextBuildResult:
        # Facade 只消费统一结果，避免反向感知 YasaContext 的私有字段。
        return ContextBuildResult(
            tool=self.tool,
            context=self.context,
            project_languages=tuple(self.context.callgraph_languages),
        )

    def build(self, *, incremental: bool) -> ContextBuildResult:
        languages = list(self.request.resolved_languages)
        if incremental:
            self.context.build_context_use_incremental_mode(self.request.project_path, languages)
        else:
            self.context.build_context(self.request.project_path, languages)
        return self._result()

    def load(self) -> ContextBuildResult:
        project_config = self.request.project_config
        if project_config is None:
            raise ValueError("ProjectConfig is required to load Yasa context")
        self.context.load_context_from_cache(
            global_config.support_languages,
            project_config.project_path,
        )
        return self._result()

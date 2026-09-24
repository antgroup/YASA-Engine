"""项目 Context 生命周期的统一编排门面。

Facade 本身不保存请求、Builder 或 Tool Context，只持有组装完成的默认注册表；
模块级默认实例可由所有 project_service 入口并发复用。
"""

from __future__ import annotations

import logging
from pathlib import Path

from yasa_mcp import __binary_version__
from yasa_mcp.config import global_config
from yasa_mcp.core.cache_status import CacheStatusMask
from yasa_mcp.core.context import YasaMcpContext
from yasa_mcp.core.context_builder import (
    ContextBuildMode,
    ContextBuildRequest,
    ContextBuildResult,
)
from yasa_mcp.core.context_builder_factory import ContextBuildError, ContextBuilderFactory
from yasa_mcp.core.runtime import get_runtime
from yasa_mcp.core.enums import Language, Tool
from yasa_mcp.core.exceptions import LanguageNotSupportedError, ProjectNotFoundError
from yasa_mcp.core.project_config import JSONValue, ProjectConfig
from yasa_mcp.layout.cache_layout import CacheLayout
from yasa_mcp.repository.shared_analysis_duckdb import (
    SHARED_ANALYSIS_READ_POOL_KEY,
    SharedDuckDBReadPool,
)
from yasa_mcp.util import log_util
from yasa_mcp.util.fingerprint_util import FolderFingerprint

logger = logging.getLogger(__name__)


def resolve_languages(
    language: str | None,
    project_path: Path | None = None,
) -> tuple[bool, list[Language]]:
    """按 SCC 主语言、显式语言、全局支持语言的既有优先级解析语言。"""
    supported = global_config.support_languages
    if project_path is not None:
        runtime = get_runtime()
        scc_tool = None
        if runtime is not None:
            try:
                # 懒加载 runtime：首次访问才按需创建 SCC 工具（廉价存在检测，不跑 --version）
                scc_tool = runtime.get_tool(Tool.SCC)
            except Exception:
                scc_tool = None
        if scc_tool is not None:
            detected = scc_tool.detect_languages(project_path)
            primary = next((item for item in detected if item in supported), None)
            if primary is not None:
                return True, [primary]

    if not language:
        return False, supported

    resolved = Language.from_string(language)
    if resolved not in supported:
        raise LanguageNotSupportedError(
            f"不支持的语言: {language}，当前支持: {[item.value for item in supported]}"
        )
    return False, [resolved]


class ContextBuilderFacade:
    """统一编排 runtime、Builder、配置提交、read pool 与 readiness。"""

    def __init__(self, factory: ContextBuilderFactory | None = None) -> None:
        self._factory = factory or ContextBuilderFactory.default()

    def execute(
        self,
        mode: ContextBuildMode,
        project_path: Path,
        cache_dir_path: Path,
        language: str | None = None,
        on_done: Callable[[Tool, bool, float], None] | None = None,
    ) -> YasaMcpContext:
        # 所有请求级对象都保持为局部变量，使默认单例不携带跨项目可变状态。
        # runtime 为进程级单例，由入口解析 binary_path 后建好；这里不再传/读 binary_path。
        if not project_path.exists():
            raise ProjectNotFoundError(f"项目路径不存在: {project_path}")

        root_context = YasaMcpContext()
        languages_from_scc, resolved_languages = resolve_languages(language, project_path)
        cache_layout = CacheLayout(root_path=cache_dir_path)
        if mode == ContextBuildMode.INCREMENTAL:
            root_context.reset_cache_status(CacheStatusMask.REPO)
        else:
            root_context.update_cache_status(CacheStatusMask.REPO)

        project_config: ProjectConfig | None = None
        if mode == ContextBuildMode.LOAD:
            if not cache_layout.is_full_cache_exists():
                # 缓存不完整时只发布 REPO，不能创建半就绪 Tool Context 或发布 ALL。
                self._publish_repo_only(root_context, project_path, resolved_languages)
                return root_context
            project_config = ProjectConfig.read_project_config_json(
                cache_layout.get_project_config_json()
            )
            if project_config is None or not project_config.codegraph:
                raise ValueError("project_config missing CodeGraph metadata")

        request = ContextBuildRequest(
            project_path=project_path,
            cache_layout=cache_layout,
            resolved_languages=tuple(resolved_languages),
            languages_from_scc=languages_from_scc,
            project_config=project_config,
        )
        try:
            results = self._factory.execute(mode, request, root_context, on_done=on_done)
        except ContextBuildError as error:
            cause = error.__cause__
            error_type = type(cause).__name__ if cause is not None else type(error).__name__
            # 统一记录并发 Builder 的稳定归因；上层仍决定 FULL/INCREMENTAL/LOAD 的返回语义。
            log_util.exception(
                f"Context Builder 执行失败: project={project_path}, cache={cache_dir_path}, "
                f"mode={mode.value}, tool={error.tool.value}, error_type={error_type}, "
                f"error={cause or error}",
                logger=logger,
            )
            raise
        except Exception as error:
            # 自定义 Factory 也可能在调度层失败；此时没有可靠 Tool，明确记录为 unknown。
            log_util.exception(
                f"Context Builder 执行失败: project={project_path}, cache={cache_dir_path}, "
                f"mode={mode.value}, tool=unknown, error_type={type(error).__name__}, "
                f"error={error}",
                logger=logger,
            )
            raise

        if mode == ContextBuildMode.LOAD:
            assert project_config is not None
            final_languages = (
                resolved_languages if languages_from_scc else list(project_config.languages)
            )
        else:
            final_languages = self._resolve_built_languages(
                results,
                resolved_languages,
                languages_from_scc,
            )
            codegraph_metadata = self._resolve_codegraph_metadata(results)
            fingerprint_path = cache_layout.get_fingerprint_cache_json()
            project_hash = FolderFingerprint.calculate_incremental(
                project_path,
                fingerprint_path,
            )
            ProjectConfig(
                project_path=project_path,
                project_hash=project_hash,
                version=__binary_version__,
                languages=final_languages,
                codegraph=codegraph_metadata,
            ).write_project_config_json(cache_layout.get_project_config_json())

        # ProjectConfig 是完整缓存提交凭据；它持久化成功后才对外注册各 Tool Context。
        for result in results:
            root_context.set_tool_context(result.tool, result.context)
        self._attach_read_pool(root_context, cache_layout, results)
        root_context.set_project_path(project_path)
        root_context.set_project_languages(final_languages)
        root_context.update_cache_status(CacheStatusMask.ALL)
        return root_context

    def fastload(
        self,
        project_path: Path,
        cache_dir_path: Path,
    ) -> YasaMcpContext:
        """CLI 快速加载：复用 factory 并行加载已注册 builder，跳过 SCC/指纹。

        runtime 为进程级单例，由入口解析 binary_path 后建好；这里不再建 runtime。
        builder 集合与并行调度完全复用 _factory.execute(LOAD)。
        """
        if not project_path.exists():
            raise ProjectNotFoundError(f"项目路径不存在: {project_path}")
        cache_layout = CacheLayout(root_path=cache_dir_path)
        if not cache_layout.is_full_cache_exists():
            raise ProjectNotFoundError(
                f"缓存不完整，请先通过 yasamcp init 生成分析结果: project={project_path}, cache={cache_dir_path}"
            )
        project_config = ProjectConfig.read_project_config_json(
            cache_layout.get_project_config_json()
        )
        if project_config is None or not project_config.codegraph:
            raise ValueError(
                f"project_config 缺失或缺少 CodeGraph 元数据: project={project_path}, cache={cache_dir_path}"
            )
        languages = list(project_config.languages) or list(global_config.support_languages)

        root_context = YasaMcpContext()
        root_context.set_project_path(project_path)
        root_context.set_project_languages(languages)
        root_context.update_cache_status(CacheStatusMask.REPO)

        request = ContextBuildRequest(
            project_path=project_path,
            cache_layout=cache_layout,
            resolved_languages=tuple(languages),
            languages_from_scc=False,
            project_config=project_config,
        )
        # 复用 factory 并行加载（LOAD），与 execute(LOAD) 的 builder 调度一致。
        results = self._factory.execute(ContextBuildMode.LOAD, request, root_context)
        for result in results:
            root_context.set_tool_context(result.tool, result.context)
        self._attach_read_pool(root_context, cache_layout, results)
        root_context.update_cache_status(CacheStatusMask.ALL)
        return root_context

    @staticmethod
    def _publish_repo_only(
        root_context: YasaMcpContext,
        project_path: Path,
        languages: list[Language],
    ) -> None:
        root_context.set_project_path(project_path)
        root_context.set_project_languages(languages)

    @staticmethod
    def _resolve_built_languages(
        results: list[ContextBuildResult],
        resolved_languages: list[Language],
        languages_from_scc: bool,
    ) -> list[Language]:
        if languages_from_scc:
            return list(resolved_languages)
        for result in results:
            if result.project_languages is not None:
                return list(result.project_languages)
        return list(resolved_languages)

    @staticmethod
    def _resolve_codegraph_metadata(
        results: list[ContextBuildResult],
    ) -> dict[str, JSONValue]:
        for result in results:
            if result.codegraph_metadata is not None:
                return dict(result.codegraph_metadata)
        raise ValueError("CodeGraph builder did not return metadata")

    @staticmethod
    def _attach_read_pool(
        root_context: YasaMcpContext,
        cache_layout: CacheLayout,
        results: list[ContextBuildResult],
    ) -> None:
        shared_path = cache_layout.get_shared_analysis_duckdb_path()
        if not shared_path.is_file():
            return
        pool = SharedDuckDBReadPool(str(shared_path.resolve()))
        root_context.__dict__[SHARED_ANALYSIS_READ_POOL_KEY] = pool
        for result in results:
            if result.read_pool_target is not None:
                result.read_pool_target.set_read_pool(pool)

        log_util.info(
            f"已挂载共享 DuckDB 只读连接池: path={shared_path}",
            logger=logger,
        )


# 默认组合在进程内只创建一次。Facade/Factory 不保存请求级状态，具体 Builder 仍逐次新建。
DEFAULT_CONTEXT_BUILDER_FACADE = ContextBuilderFacade(ContextBuilderFactory.default())

"""项目缓存构建与加载的公开服务入口。"""

from __future__ import annotations

from typing import Callable

import logging
from pathlib import Path

from yasa_mcp import __binary_version__
from yasa_mcp.core.cache_status import CacheStatus
from yasa_mcp.core.context import YasaMcpContext
from yasa_mcp.core.context_builder import ContextBuildMode, build_mode_for_cache_status
from yasa_mcp.core.context_builder_facade import DEFAULT_CONTEXT_BUILDER_FACADE
from yasa_mcp.core.exceptions import ProjectNotFoundError
from yasa_mcp.core.project_config import ProjectConfig
from yasa_mcp.layout.cache_layout import CacheLayout
from yasa_mcp.util import log_util
from yasa_mcp.util.fingerprint_util import FolderFingerprint
from yasa_mcp.util.timer_util import timed

logger = logging.getLogger(__name__)


@timed(logger, "init_project_service", "check_cache_update_required")
def check_cache_update_required(
    project_path: Path,
    binary_path: Path,
    cache_dir_path: Path,
) -> tuple[CacheStatus, CacheStatus]:
    if not project_path.exists():
        logger.error(f"项目路径不存在: {project_path}")
        raise ProjectNotFoundError(f"项目路径不存在: {project_path}")

    cache_layout = CacheLayout(root_path=cache_dir_path)
    if not cache_layout.is_full_cache_exists():
        log_util.info(
            f"完整缓存不存在，需重新生成: project={project_path}, cache_dir={cache_dir_path}",
            logger=logger,
        )
        return CacheStatus.CACHE_L1_OK, CacheStatus.FULL_UPDATE

    project_config = ProjectConfig.read_project_config_json(
        cache_layout.get_project_config_json()
    )
    if project_config is None or not project_config.codegraph:
        log_util.info(
            f"项目配置或 CodeGraph metadata 不存在，需重新生成缓存: "
            f"project={project_path}, cache_dir={cache_dir_path}",
            logger=logger,
        )
        return CacheStatus.CACHE_L1_OK, CacheStatus.FULL_UPDATE
    if project_config.version != __binary_version__:
        log_util.info(
            f"版本号不一致，需重新生成缓存: project={project_path}, "
            f"cache_dir={cache_dir_path}",
            logger=logger,
        )
        return CacheStatus.CACHE_L1_OK, CacheStatus.FULL_UPDATE

    hash_diff: list = []
    current_hash = FolderFingerprint.calculate_incremental(
        project_path,
        cache_layout.get_fingerprint_cache_json(),
        diff_out=hash_diff,
    )
    if project_config.project_hash != current_hash:
        top5 = hash_diff[:5]
        if top5:
            detail = "\n".join(
                f"  [{kind}] {relative} ({old or '-'}->{new or '-'})"
                for kind, relative, old, new in top5
            )
            diff_summary = f"变动文件(top5), 共 {len(hash_diff)} 个:\n{detail}"
        else:
            diff_summary = "无文件级差异（疑似缓存损坏）"
        log_util.info(
            f"项目hash不一致，增量生成缓存: project={project_path}, "
            f"cache_dir={cache_dir_path}; {diff_summary}",
            logger=logger,
        )
        return CacheStatus.CACHE_L1_OK, CacheStatus.INCREMENTAL_UPDATE
    return CacheStatus.CACHE_L3_OK, CacheStatus.NO_UPDATE


@timed(logger, "init_project_service", "generate_project_cache")
def generate_project_cache(
    project_path: Path,
    binary_path: Path,
    cache_dir_path: Path,
    language: str | None = None,
    on_done=None,
) -> YasaMcpContext | None:
    return DEFAULT_CONTEXT_BUILDER_FACADE.execute(
        ContextBuildMode.FULL,
        project_path,
        cache_dir_path,
        language,
        on_done=on_done,
    )


@timed(logger, "init_project_service", "generate_project_cache_with_incremental")
def generate_project_cache_with_incremental(
    project_path: Path,
    binary_path: Path,
    cache_dir_path: Path,
    cache_status: CacheStatus | None = None,
    language: str | None = None,
    on_done=None,
) -> YasaMcpContext | None:
    if cache_status is None:
        _, cache_status = check_cache_update_required(
            project_path,
            cache_dir_path,
        )
    mode = build_mode_for_cache_status(cache_status)
    if mode == ContextBuildMode.LOAD:
        return build_yasa_mcp_context_from_cache(
            project_path,
            binary_path,
            cache_dir_path,
            language,
            on_done=on_done,
        )
    return DEFAULT_CONTEXT_BUILDER_FACADE.execute(
        mode,
        project_path,
        cache_dir_path,
        language,
        on_done=on_done,
    )


@timed(logger, "init_project_service", "build_yasa_mcp_context_from_cache")
def build_yasa_mcp_context_from_cache(
    project_path: Path,
    binary_path: Path,
    cache_dir_path: Path,
    language: str | None = None,
    on_done=None,
) -> YasaMcpContext | None:
    if not project_path.exists():
        logger.error(f"项目路径不存在: {project_path}")
        raise ProjectNotFoundError(f"项目路径不存在: {project_path}")
    try:
        return DEFAULT_CONTEXT_BUILDER_FACADE.execute(
            ContextBuildMode.LOAD,
            project_path,
            cache_dir_path,
            language,
            on_done=on_done,
        )
    except Exception as error:
        log_util.exception(
            f"从缓存加载项目上下文失败: project={project_path}, "
            f"cache={cache_dir_path}, error={error}",
            logger=logger,
        )
        return None

"""init 编排服务。

从 server.py 抽取，供 CLI init 命令直接调用，不经 fastmcp MCP 包装。
支持阶段回调(on_stage)与 builder 完成回调(on_done)，供 CLI 渲染进度条。
"""

from __future__ import annotations

import logging
import shutil
from pathlib import Path
from typing import Callable

from yasa_mcp.config import global_config
from yasa_mcp.core.cache_manager import set_project_cache_dir
from yasa_mcp.core.context_manager import get_context_manager
from yasa_mcp.core.enums import Tool
from yasa_mcp.core.exceptions import ToolError
from yasa_mcp.core.cache_manager import get_or_create_cache_for_project
from yasa_mcp.service.project_service import (
    CacheStatus,
    check_cache_update_required,
    generate_project_cache,
    generate_project_cache_with_incremental,
)
from yasa_mcp.util import log_util
from yasa_mcp.util.timer_util import timed

logger = logging.getLogger(__name__)


_CACHE_GITIGNORE = """\
# yasamcp 分析结果缓存（本机本地数据，不提交到 git）
*
!.gitignore
"""


def ensure_cache_gitignore(cache_root: Path) -> None:
    """在 .yasa 目录写一份 .gitignore，忽略其中全部内容（仅保留 .gitignore 自身）。"""
    cache_root.mkdir(parents=True, exist_ok=True)
    (cache_root / ".gitignore").write_text(_CACHE_GITIGNORE, encoding="utf-8")

StageCallback = Callable[[str], None]
DoneCallback = Callable[[Tool, bool, float], None]


@timed(logger, "init_service", "init_project")
def init_project(
    project_path: Path,
    save_cg_dump: bool = False,
    use_cache: bool = True,
    on_stage: StageCallback | None = None,
    on_done: DoneCallback | None = None,
) -> str:
    """初始化项目分析缓存，支持增量更新；对外不暴露全量重建。

    阶段回调 ``on_stage(stage_name)`` 在阶段边界调用；
    builder 完成回调 ``on_done(tool, ok, elapsed_ms)`` 在并行 build 期间调用，
    透传到 ``facade.execute`` 支持进度条实时标记。
    返回串含「完成」给 CLI 做断言。
    """
    def stage(name: str) -> None:
        if on_stage is not None:
            try:
                on_stage(name)
            except Exception:
                logger.exception("on_stage 回调异常")

    log_util.new_default_task(project_path)
    log_util.info(f"project {project_path} 初始化开始", logger=logger)

    project_cache_dir = project_path / ".yasa"
    set_project_cache_dir(project_cache_dir)
    global_config.cache_path = project_cache_dir
    cache_layout = get_or_create_cache_for_project(project_path)

    yasa_mcp_context = None
    if use_cache and cache_layout.root_path.exists():
        stage("checking_cache")
        _cache_level, cache_status = check_cache_update_required(
            project_path, global_config.binary_path, cache_layout.root_path
        )

        # 快速路径：内存中已有上下文 + 项目文件未变 → 直接复用
        if cache_status == CacheStatus.NO_UPDATE:
            context_manager = get_context_manager()
            existing_context = context_manager.get_context(project_path)
            if existing_context is not None:
                log_util.info(
                    f"project {project_path} 上下文已存在且项目无变更，跳过重新加载",
                    logger=logger,
                )
                stage("done")
                return f"{project_path} 初始化完成"

        stage("building_analysis")
        yasa_mcp_context = generate_project_cache_with_incremental(
            project_path=project_path,
            binary_path=global_config.binary_path,
            cache_dir_path=cache_layout.root_path,
            cache_status=cache_status,
            on_done=on_done,
        )
        if yasa_mcp_context is None:
            log_util.info(
                f"project : {project_path} 初始化失败,未找到缓存或缓存失效, 尝试重新生成缓存",
                logger=logger,
            )

    if yasa_mcp_context is None:
        stage("building_analysis")
        yasa_mcp_context = generate_project_cache(
            project_path=project_path,
            binary_path=global_config.binary_path,
            cache_dir_path=cache_layout.root_path,
            on_done=on_done,
        )
        if yasa_mcp_context is None:
            raise ToolError(f"project : {project_path} 初始化失败")

    yasa_mcp_context.set_project_path(project_path)

    context_manager = get_context_manager()
    context_manager.set_context(project_path, yasa_mcp_context)

    # init 成功后默认删除 yasacg/（CG dump 已导入 duckdb，不再需要）
    if not save_cg_dump:
        yasacg_path = cache_layout.yasa_cache.root_path
        if yasacg_path.exists():
            shutil.rmtree(yasacg_path, ignore_errors=True)
            log_util.info(f"已删除 CG dump 目录: {yasacg_path}", logger=logger)

    ensure_cache_gitignore(cache_layout.root_path)

    stage("done")
    return f"{project_path} 初始化完成"

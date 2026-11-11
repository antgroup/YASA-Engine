"""项目缓存管理器。

从项目 .yasa 目录快速加载分析上下文，不走 init_project 的指纹校验和增量流程。
runtime 为进程级单例，由 CLI group 回调 / server 启动时按持久化 binary_path 建好；
此处不读/不设 binary_path，直接走已在 global_config.binary_path 上的 fastload。
"""

from __future__ import annotations

import logging
from enum import Enum
from dataclasses import dataclass
from pathlib import Path

from yasa_mcp import __binary_version__
from yasa_mcp.config import global_config
from yasa_mcp.core.exceptions import InvalidCacheError
from yasa_mcp.layout.cache_layout import CacheLayout, PROJECT_CONFIG_FILENAME
from yasa_mcp.util import json_util

logger = logging.getLogger("yasa_mcp.core")


class CacheState(str, Enum):
    """缓存状态枚举，state.value 即对外展示文案。"""

    COMPLETE = "分析已完成"
    INCOMPLETE = "分析数据不完整"
    OUTDATED = "分析已过期"
    NONE = "无分析结果"


@dataclass(frozen=True)
class CacheValidationResult:
    """缓存校验结果。"""

    state: CacheState
    detail: str = ""

    @property
    def is_valid(self) -> bool:
        return self.state is CacheState.COMPLETE

    @property
    def message(self) -> str:
        """state 文案（合法时不带详情，非法时拼接 detail）。"""
        if self.state is CacheState.COMPLETE:
            return self.state.value
        return f"{self.state.value}：{self.detail}" if self.detail else self.state.value

    @property
    def advice(self) -> str:
        """对非法状态给出的处置建议；合法状态为空。
        INCOMPLETE 可能是 init 尚未完成，故提示耐心等待或重新执行。
        """
        if self.is_valid:
            return ""
        if self.state is CacheState.INCOMPLETE:
            return "耐心等待缓存生成，或重新通过 yasamcp init 生成分析结果"
        return "请通过 yasamcp init 生成分析结果"


class ProjectCacheManager:
    """管理指定项目的缓存加载与上下文复用。

    利用 CacheLayout 获取 codegraph.db 和 yasa.db 路径，避免硬编码。
    不持有 binary_path；runtime 由进程入口已建好。
    """

    def __init__(self, project_path: Path) -> None:
        self.project_path = project_path.resolve()
        self.cache_layout = CacheLayout(root_path=self.project_path / ".yasa")

    def _codegraph_db(self) -> Path:
        return self.cache_layout.codegraph_cache.get_db_path()

    def _yasa_db(self) -> Path:
        return self.cache_layout.get_shared_analysis_duckdb_path()

    def _project_config_path(self) -> Path:
        return self.cache_layout.get_project_config_json()

    def validate_cache(self) -> CacheValidationResult:
        """校验缓存是否可用，判定顺序：先存在性、再完整性、最后版本。

          1. .yasa 目录不存在 → 缓存不存在（NONE / 无分析结果）
          2. project_config.json 不存在 / 解析失败 / 缺少非空 version 字段
             → 数据不完整（INCOMPLETE / 分析数据不完整）
          3. codegraph.db / yasa.db 任一缺失 → 数据不完整，detail 说明缺哪个（INCOMPLETE）
          4. 缓存 version != __binary_version__ → 已过期（OUTDATED / 分析已过期）
          5. 以上校验全部通过即认为缓存就绪（COMPLETE / 分析已完成）
        """
        yasa_dir = self.project_path / ".yasa"
        if not yasa_dir.exists():
            return CacheValidationResult(CacheState.NONE, ".yasa 目录不存在")

        cfg_path = self._project_config_path()
        if not cfg_path.exists():
            return CacheValidationResult(
                CacheState.INCOMPLETE, f"缺少 {PROJECT_CONFIG_FILENAME}"
            )
        try:
            cfg = json_util.load_json_from_file(cfg_path)
        except Exception as exc:
            return CacheValidationResult(
                CacheState.INCOMPLETE, f"{PROJECT_CONFIG_FILENAME} 解析失败: {exc}"
            )
        if not isinstance(cfg, dict) or not cfg.get("version"):
            return CacheValidationResult(
                CacheState.INCOMPLETE, f"{PROJECT_CONFIG_FILENAME} 缺少 version 字段"
            )

        missing_db = []
        cg = self._codegraph_db()
        yasa = self._yasa_db()
        if not cg.exists():
            missing_db.append(cg.name)
        if not yasa.exists():
            missing_db.append(yasa.name)
        if missing_db:
            return CacheValidationResult(
                CacheState.INCOMPLETE, f"缺少数据库 {', '.join(missing_db)}"
            )

        cache_version = cfg["version"]
        if cache_version != __binary_version__:
            return CacheValidationResult(
                CacheState.OUTDATED,
                f"缓存版本 {cache_version} 与当前版本 {__binary_version__} 不一致",
            )
        return CacheValidationResult(CacheState.COMPLETE)

    def validate_or_abort(self) -> CacheValidationResult:
        """校验缓存，非法状态直接抛 InvalidCacheError，不继续加载/执行工具。"""
        result = self.validate_cache()
        if result.is_valid:
            return result
        raise InvalidCacheError(f"{result.message}；{result.advice}")

    def load_context(self) -> None:
        """加载项目缓存上下文到 context_manager。

        优先从 context_manager 取缓存上下文，没有则从缓存 DB 构建。
        不走 init_project 的指纹校验、不触发增量分析。
        runtime 已由进程入口建好（见 binary_manager / group 回调）。
        """
        if not self._codegraph_db().exists() or not self._yasa_db().exists():
            return

        from yasa_mcp.core.context_manager import get_context_manager

        cm = get_context_manager()
        if cm.get_context(self.project_path) is not None:
            return

        # fastload：复用 ContextBuilderFacade.fastload，并行加载已注册 builder；
        # 不走 init_tools（不跑 native binary --version）、不调 SCC 语言探测、
        # 不做指纹/增量；语言直接取自缓存 project_config，工具实例按需懒加载。
        from yasa_mcp.core.context_builder_facade import DEFAULT_CONTEXT_BUILDER_FACADE
        context = DEFAULT_CONTEXT_BUILDER_FACADE.fastload(
            self.project_path,
            self.cache_layout.root_path,
        )
        context.set_project_path(self.project_path)
        cm.set_context(self.project_path, context)

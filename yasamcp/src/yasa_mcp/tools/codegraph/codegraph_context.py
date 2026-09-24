from __future__ import annotations

import logging
import shutil
import sqlite3
import sys
import time
from pathlib import Path
from typing import Any

from yasa_mcp.core import exceptions
from yasa_mcp.core.enums import Language
from yasa_mcp.core.models import ToolContext
from yasa_mcp.layout.cache_layout import CacheLayout
from yasa_mcp.tools.codegraph.codegraph_tool import CodeGraphTool
from yasa_mcp.util import log_util
from yasa_mcp.util.timer_util import timed

logger = logging.getLogger(__name__)
CORE_TABLES = ("nodes", "edges", "files", "project_metadata")


class CodeGraphContext(ToolContext):
    """构建、恢复并发布 CodeGraph 缓存。

    CodeGraph 在项目目录的 ``.codegraph`` 中维护完整运行状态，其中不仅有
    ``codegraph.db``，还可能包含后续增量分析需要的其他状态文件。本类将项目目录视为
    CodeGraph 命令的工作区，将 cache 中的完整 ``.codegraph`` 视为持久化恢复源。

    构建完成后优先用 ``VACUUM INTO`` 生成更紧凑的候选 DB；运行环境不支持该语法或
    VACUUM 失败时，回退为完整目录复制。无论采用哪条路径，都先写 staging，再发布到
    固定 consumer 路径，避免直接覆盖正在使用的有效缓存。
    """

    def __init__(self, codegraph_tool: CodeGraphTool | None, project_cache_layout: CacheLayout):
        self.codegraph_tool = codegraph_tool
        self._project_cache_layout = project_cache_layout
        self.source_db_path: Path | None = None
        self.consumer_db_path: Path = project_cache_layout.codegraph_cache.get_db_path()
        self.status: dict[str, Any] | None = None
        self.metadata: dict[str, Any] = {}

    @staticmethod
    def get_source_dir_path(project_path: Path) -> Path:
        return project_path / ".codegraph"

    @staticmethod
    def get_source_db_path(project_path: Path) -> Path:
        return CodeGraphContext.get_source_dir_path(project_path) / "codegraph.db"

    @timed(logger, "codegraph_context", "build_context")
    def build_context(self, project_path: Path, languages: list[Language] | None = None) -> None:
        """从干净的项目状态执行全量初始化并发布缓存。"""
        if self.codegraph_tool is None:
            raise exceptions.InvalidToolError("CodeGraph tool is not initialized")
        self._validate_distinct_state_dirs(project_path)
        self._build_full_context(project_path)

    def _build_full_context(self, project_path: Path) -> None:
        """执行单次全量构建，供正常全量路径和增量失败兜底共同使用。"""
        if self.codegraph_tool is None:
            raise exceptions.InvalidToolError("CodeGraph tool is not initialized")
        # init 前必须删除历史状态；否则 CodeGraph 可能复用旧索引，使所谓“全量”结果
        # 受到上次失败、旧版本格式或残留文件干扰。
        self._remove_project_state(project_path)
        self.codegraph_tool.init_project(project_path)
        self._finalize_from_project(project_path)

    @timed(logger, "codegraph_context", "build_context_incremental")
    def build_context_use_incremental_mode(
        self, project_path: Path, languages: list[Language] | None = None
    ) -> None:
        """从已发布 cache 恢复完整状态，再执行增量同步。"""
        if self.codegraph_tool is None:
            raise exceptions.InvalidToolError("CodeGraph tool is not initialized")
        self._validate_distinct_state_dirs(project_path)
        # 项目目录中的状态不是增量分析的权威输入。先校验并恢复 cache，确保 sync
        # 不会意外使用项目目录里不完整或被其他分析遗留的状态。
        try:
            self._restore_project_state_from_cache(project_path)
            self.codegraph_tool.sync_project(project_path)
            self._finalize_from_project(project_path)
        except Exception as incremental_exc:
            # cache 损坏、复制失败、sync 失败以及增量结果发布失败都意味着本轮增量不可用。
            # 统一清理项目状态并执行一次 init；直接调用全量 helper，避免递归进入增量。
            log_util.warning(
                "CodeGraph incremental build failed; falling back to full init: "
                f"project={project_path}, error={type(incremental_exc).__name__}: {incremental_exc}",
                logger=logger,
            )
            try:
                self._build_full_context(project_path)
            except Exception as full_exc:
                raise exceptions.InvalidCacheError(
                    "CodeGraph incremental and full fallback both failed: "
                    f"project={project_path}, incremental_error={incremental_exc}, "
                    f"full_error={full_exc}"
                ) from full_exc

    @timed(logger, "codegraph_context", "load_context_from_cache")
    def load_context_from_cache(
        self,
        languages: list[Language] | None = None,
        project_path: Path | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        self._recover_publish_state()
        self._validate_consumer_db(self.consumer_db_path)
        self.metadata = dict(metadata or {})
        if project_path is not None:
            self.source_db_path = self.get_source_db_path(project_path)
        self.metadata.setdefault("consumer_db", str(self.consumer_db_path))

    def _validate_distinct_state_dirs(self, project_path: Path) -> None:
        """拒绝工作目录与 cache 指向同一路径，防止清理源目录时误删 cache。"""
        source_dir = self.get_source_dir_path(project_path).resolve(strict=False)
        cache_dir = self._project_cache_layout.codegraph_cache.get_dir_path().resolve(strict=False)
        if source_dir == cache_dir:
            raise exceptions.InvalidCacheError(
                f"CodeGraph project state and cache directory must differ: {source_dir}"
            )

    def _remove_project_state(self, project_path: Path) -> None:
        """仅删除由 ``project_path`` 派生出的 ``.codegraph`` 状态。"""
        state_dir = self.get_source_dir_path(project_path)
        # 必须先判断 symlink。若直接对 symlink 调用 rmtree，可能跟随链接删除项目外目录；
        # 对意外出现的普通文件也只删除该文件，不扩大清理范围。
        if state_dir.is_symlink() or state_dir.is_file():
            state_dir.unlink()
        elif state_dir.exists():
            shutil.rmtree(state_dir)

    def _restore_project_state_from_cache(self, project_path: Path) -> None:
        """校验 cache 后，将完整状态目录恢复到 CodeGraph 工作区。"""
        # 上次进程若恰好在发布期间退出，可能留下 staging 或只有 backup。
        # 恢复发布状态后再做 cache 校验，避免将可恢复缓存误判为缺失。
        self._recover_publish_state()
        cache_dir = self._project_cache_layout.codegraph_cache.get_dir_path()
        # 校验必须发生在删除项目旧目录之前。cache 无效时保留现场，且绝不调用 sync。
        self._validate_consumer_db(self.consumer_db_path, remove_invalid=False)
        self._remove_project_state(project_path)
        source_dir = self.get_source_dir_path(project_path)
        try:
            # copytree 复制整个目录，而非只复制 codegraph.db；CodeGraph 管理的其他状态文件
            # 可能影响 sync 的增量语义，不能由业务代码猜测或筛选。
            shutil.copytree(cache_dir, source_dir)
            self._validate_source_db(self.get_source_db_path(project_path))
        except Exception as exc:
            # 恢复失败的目录不能留给后续调用复用，否则下一次 sync 可能基于半成品运行。
            self._remove_path(source_dir)
            if isinstance(exc, exceptions.InvalidCacheError):
                raise
            raise exceptions.InvalidCacheError(
                f"CodeGraph cache restore failed: source={cache_dir}, target={source_dir}, error={exc}"
            ) from exc

    def _finalize_from_project(self, project_path: Path) -> None:
        """校验 CodeGraph 命令产物，构建候选缓存并完成发布。"""
        # status 和源 DB 都通过后才进入 staging 阶段。这样 init/sync 的半成品不会触碰
        # 已发布 cache；metadata 也只在最终 consumer 再次校验成功后生成。
        self.status = self._load_ready_status(project_path)
        self.source_db_path = self.get_source_db_path(project_path)
        self._validate_source_db(self.source_db_path)
        publish_metadata = self._prepare_and_publish_cache(project_path)
        self._validate_consumer_db(self.consumer_db_path)
        self.metadata = self._build_metadata(
            self.status,
            self.source_db_path,
            self.consumer_db_path,
            publish_metadata,
        )

    def _load_ready_status(self, project_path: Path) -> dict[str, Any]:
        if self.codegraph_tool is None:
            raise exceptions.InvalidToolError("CodeGraph tool is not initialized")
        status = self.codegraph_tool.status(project_path)
        if status.get("initialized") is not True:
            raise exceptions.InvalidCacheError(f"CodeGraph status is not initialized: {status}")
        pending = status.get("pendingChanges") or {}
        if any(int(pending.get(key, 0) or 0) != 0 for key in ("added", "modified", "removed")):
            raise exceptions.InvalidCacheError(f"CodeGraph has pending changes: {pending}")
        index = status.get("index") or {}
        if index.get("reindexRecommended") is True:
            raise exceptions.InvalidCacheError(f"CodeGraph reindex is recommended: {index}")
        return status

    def _validate_source_db(self, source_db: Path) -> None:
        if not source_db.is_file() or source_db.stat().st_size == 0:
            raise exceptions.InvalidCacheError(f"CodeGraph source DB missing or empty: {source_db}")
        self._validate_sqlite_db(source_db)

    def _validate_consumer_db(self, consumer_db: Path, *, remove_invalid: bool = True) -> None:
        """校验 consumer DB；仅在明确允许时删除无效 DB 文件。"""
        if not consumer_db.is_file() or consumer_db.stat().st_size == 0:
            raise exceptions.InvalidCacheError(f"CodeGraph consumer DB missing or empty: {consumer_db}")
        try:
            self._validate_sqlite_db(consumer_db)
        except Exception:
            # 增量恢复前使用 remove_invalid=False，以保留损坏 cache 供诊断；正常加载路径
            # 维持旧行为，删除不可消费的 DB，防止后续仅凭“文件存在”误判 cache ready。
            if remove_invalid:
                consumer_db.unlink(missing_ok=True)
            raise

    def _validate_sqlite_db(self, db_path: Path) -> None:
        try:
            conn = sqlite3.connect(str(db_path))
            try:
                rows = conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
                tables = {row[0] for row in rows}
                missing = set(CORE_TABLES) - tables
                if missing:
                    raise exceptions.InvalidCacheError(
                        f"CodeGraph DB missing required tables {sorted(missing)}: {db_path}"
                    )
                for table in CORE_TABLES:
                    conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()
            finally:
                conn.close()
        except exceptions.InvalidCacheError:
            raise
        except Exception as exc:
            raise exceptions.InvalidCacheError(f"CodeGraph DB validation failed: {db_path}: {exc}") from exc

    def _prepare_and_publish_cache(self, project_path: Path) -> dict[str, Any]:
        """构建候选目录，并按 VACUUM 优先、完整复制降级的策略发布。"""
        source_dir = self.get_source_dir_path(project_path)
        cache_layout = self._project_cache_layout.codegraph_cache
        staging_dir = cache_layout.get_staging_dir_path()
        staging_db = staging_dir / "codegraph.db"

        self._recover_publish_state()
        self._remove_path(staging_dir)
        try:
            # 先复制完整目录，保留除 DB 外的所有 CodeGraph 状态；随后 VACUUM 只替换
            # staging 中的 DB，绝不直接操作已发布 final cache。
            shutil.copytree(source_dir, staging_dir)
        except Exception as exc:
            self._remove_path(staging_dir)
            raise exceptions.InvalidCacheError(
                f"CodeGraph staging copy failed: source={source_dir}, target={staging_dir}, error={exc}"
            ) from exc

        try:
            publish_metadata = self._vacuum_into_consumer(self.source_db_path, staging_db)
            publish_metadata["publish_method"] = "vacuum_into"
        except Exception as vacuum_exc:
            # VACUUM 是空间优化而不是正确性门禁。旧 SQLite 不识别 INTO、磁盘空间不足、
            # 临时 I/O 等任意异常都进入同一条可靠降级路径。
            log_util.warning(
                "CodeGraph VACUUM INTO failed; falling back to full directory copy: "
                f"source={source_dir}, target={staging_dir}, sqlite={sqlite3.sqlite_version}, "
                f"error={type(vacuum_exc).__name__}: {vacuum_exc}",
                logger=logger,
            )
            # VACUUM 失败可能留下部分 DB。必须废弃整个 staging 并从源目录重建，
            # 不能仅覆盖 DB，否则其他文件也可能来自不完整的第一次复制。
            self._remove_path(staging_dir)
            try:
                shutil.copytree(source_dir, staging_dir)
                self._validate_sqlite_db(staging_db)
            except Exception as fallback_exc:
                self._remove_path(staging_dir)
                raise exceptions.InvalidCacheError(
                    "CodeGraph cache fallback copy failed after VACUUM INTO failure: "
                    f"source={source_dir}, target={staging_dir}, "
                    f"vacuum_error={vacuum_exc}, fallback_error={fallback_exc}"
                ) from fallback_exc
            publish_metadata = {
                "source_db_size_bytes": self.source_db_path.stat().st_size,
                "consumer_db_size_bytes": staging_db.stat().st_size,
                "vacuum_duration_ms": None,
                "vacuum_success": False,
                "vacuum_error": f"{type(vacuum_exc).__name__}: {vacuum_exc}",
                "publish_method": "directory_copy_fallback",
            }

        self._validate_sqlite_db(staging_db)
        self._publish_staging(staging_dir)
        publish_metadata["consumer_db_size_bytes"] = self.consumer_db_path.stat().st_size
        publish_metadata["sqlite_runtime_version"] = sqlite3.sqlite_version
        publish_metadata["python_version"] = sys.version.split()[0]
        return publish_metadata

    def _vacuum_into_consumer(self, source_db: Path, consumer_db: Path) -> dict[str, Any]:
        """使用当前 Python SQLite runtime 将源 DB 瘦身到候选路径。

        该方法只负责一次 VACUUM 尝试：异常会清理候选 DB 并原样抛出，由上层统一
        决定是否回退完整目录复制。目标必须是 staging DB，不能传入 final consumer。
        """
        consumer_db.parent.mkdir(parents=True, exist_ok=True)
        # VACUUM INTO 要求目标不存在；第一次完整目录复制已经带来了源 DB 副本。
        consumer_db.unlink(missing_ok=True)
        start = time.perf_counter()
        try:
            conn = sqlite3.connect(str(source_db))
            try:
                escaped_target = str(consumer_db).replace("'", "''")
                conn.execute(f"VACUUM INTO '{escaped_target}'")
            finally:
                conn.close()
            self._validate_sqlite_db(consumer_db)
        except Exception:
            consumer_db.unlink(missing_ok=True)
            raise
        duration_ms = int((time.perf_counter() - start) * 1000)
        log_util.info(
            "CodeGraph VACUUM INTO complete: "
            f"source={source_db}, target={consumer_db}, sqlite={sqlite3.sqlite_version}, "
            f"duration={duration_ms}ms",
            logger=logger,
        )
        return {
            "source_db_size_bytes": source_db.stat().st_size,
            "consumer_db_size_bytes": consumer_db.stat().st_size,
            "vacuum_duration_ms": duration_ms,
            "vacuum_success": True,
        }

    def _publish_staging(self, staging_dir: Path) -> None:
        """以同文件系统 rename 发布 staging，失败时恢复上一版 cache。"""
        cache_layout = self._project_cache_layout.codegraph_cache
        final_dir = cache_layout.get_dir_path()
        backup_dir = cache_layout.get_backup_dir_path()
        final_dir.parent.mkdir(parents=True, exist_ok=True)
        self._remove_path(backup_dir)
        moved_old = False
        try:
            # staging、final、backup 是同级目录，因此 rename 不需要跨文件系统复制。
            # 先把旧 final 移到 backup，确保新 final 校验失败时仍有可恢复版本。
            if final_dir.exists() or final_dir.is_symlink():
                final_dir.rename(backup_dir)
                moved_old = True
            staging_dir.rename(final_dir)
            self._validate_consumer_db(final_dir / "codegraph.db", remove_invalid=False)
        except Exception as exc:
            # 新 final 无论完整与否都不能保留；恢复 backup 后再清理 staging。
            self._remove_path(final_dir)
            if moved_old and backup_dir.exists():
                backup_dir.rename(final_dir)
            self._remove_path(staging_dir)
            raise exceptions.InvalidCacheError(
                f"CodeGraph cache publish failed: target={final_dir}, error={exc}"
            ) from exc
        self._remove_path(backup_dir)

    def _recover_publish_state(self) -> None:
        """恢复上次异常退出留下的 staging/backup 状态。"""
        cache_layout = self._project_cache_layout.codegraph_cache
        final_dir = cache_layout.get_dir_path()
        backup_dir = cache_layout.get_backup_dir_path()
        staging_dir = cache_layout.get_staging_dir_path()
        # staging 永远是未提交候选，进程重启后可以直接丢弃。
        self._remove_path(staging_dir)
        if backup_dir.exists() or backup_dir.is_symlink():
            if final_dir.exists() or final_dir.is_symlink():
                # final 已存在说明切换已完成，backup 只是未清理的旧版本。
                self._remove_path(backup_dir)
            else:
                # final 缺失说明进程可能在“旧 final -> backup”之后退出，恢复旧版本。
                backup_dir.rename(final_dir)

    @staticmethod
    def _remove_path(path: Path) -> None:
        """删除内部构造的 staging/backup 路径，并避免跟随 symlink。"""
        if path.is_symlink() or path.is_file():
            path.unlink(missing_ok=True)
        elif path.exists():
            shutil.rmtree(path)

    def _build_metadata(
        self,
        status: dict[str, Any],
        source_db: Path,
        consumer_db: Path,
        publish_metadata: dict[str, Any],
    ) -> dict[str, Any]:
        index = status.get("index") or {}
        metadata = {
            "source_db": str(source_db),
            "consumer_db": str(consumer_db),
            "version": status.get("version"),
            "backend": status.get("backend"),
            "journal_mode": status.get("journalMode"),
            "initialized": status.get("initialized"),
            "pending_changes": status.get("pendingChanges") or {},
            "file_count": status.get("fileCount"),
            "node_count": status.get("nodeCount"),
            "edge_count": status.get("edgeCount"),
            "built_with_version": index.get("builtWithVersion"),
            "built_with_extraction_version": index.get("builtWithExtractionVersion"),
            "current_extraction_version": index.get("currentExtractionVersion"),
            "reindex_recommended": index.get("reindexRecommended"),
        }
        metadata.update(publish_metadata)
        return metadata

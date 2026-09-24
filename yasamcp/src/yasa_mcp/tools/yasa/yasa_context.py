import logging
import time
from pathlib import Path

import duckdb

from yasa_mcp.config import global_config
from yasa_mcp.core.enums import CallgraphAlgorithm, Language, Mode
from yasa_mcp.core.models import ToolContext
from yasa_mcp.layout.cache_layout import CacheLayout
from yasa_mcp.repository.callgraph_db import CallGraphDBBuilder
from yasa_mcp.tools.yasa.yasa_tool import YasaTool
from yasa_mcp.util import log_util
from yasa_mcp.util.timer_util import timed

logger = logging.getLogger(__name__)


class YasaContext(ToolContext):

    def __init__(
        self,
        yasa_tool: YasaTool,
        project_cache_layout: CacheLayout,
    ):
        self.yasa_tool = yasa_tool
        self._project_cache_layout = project_cache_layout
        self._callgraph_duckdb_available: bool = False
        self._callgraph_languages: tuple[Language, ...] = ()

    def check_ready(self, db_path: Path) -> None:
        """
        根据共用库内是否已有 CallGraph 表数据，更新 ``_callgraph_duckdb_available``。

        共库时文件可能已由 UQL 创建，不能仅凭文件存在认为调用图已就绪。
        """
        if self._callgraph_duckdb_available:
            return
        if not db_path.is_file() or db_path.stat().st_size == 0:
            return
        try:
            conn = duckdb.connect(str(db_path), read_only=True)
        except Exception:
            logger.debug("Yasa 探测 DuckDB 失败: %s", db_path, exc_info=True)
            return
        try:
            for tbl in ("cg_nodes", "cg_edges", "cg_call_sites"):
                conn.execute(f"SELECT 1 FROM {tbl} LIMIT 1")
            row = conn.execute("SELECT COUNT(*) FROM cg_nodes").fetchone()
            if row is not None and int(row[0]) > 0:
                self._callgraph_duckdb_available = True
        except Exception:
            self._callgraph_duckdb_available = False
        finally:
            try:
                conn.close()
            except Exception:
                pass

    @property
    def yasa_cache_layout(self):
        return self._project_cache_layout.yasa_cache

    @property
    def analysis_duckdb_path(self) -> Path:
        """与 UQL 共用的 ``project_analysis.db``（单一事实来源：项目 CacheLayout）。"""
        return self._project_cache_layout.get_shared_analysis_duckdb_path()

    @property
    def callgraph_duckdb_path(self) -> Path | None:
        """共用分析库路径；不可用时返回 None（与旧行为一致，供 callgraph_service 等判断）。"""
        if not self._callgraph_duckdb_available:
            return None
        return self.analysis_duckdb_path

    @property
    def callgraph_languages(self) -> tuple[Language, ...]:
        """
        当前项目（yasa 缓存根）下实际具备 callgraph 数据的语言。

        在 ``global_config.support_languages`` 范围内扫描：仅当
        ``<yasa>/<language>/callgraph.json`` 存在且非空时纳入。
        每次读取前根据磁盘重新扫描（候选项为 ``support_languages``，体量小）；
        ``build_context`` / ``load_context_from_cache`` 结束也会在 ``finally`` 中刷新。
        """
        return self._callgraph_languages

    def _refresh_callgraph_languages_from_cache(self, project_path: Path | None = None) -> None:
        """根据磁盘上的 callgraph 报告刷新 ``_callgraph_languages``。"""
        found: list[Language] = []
        for lang in global_config.support_languages:
            report = self.yasa_cache_layout.get_callgraph_report(lang)
            try:
                if not report.is_file() or report.stat().st_size == 0:
                    continue
                graph = self.yasa_tool.parse_callgraph_report(report, project_path)
                if graph is not None and graph.nodes:
                    found.append(lang)
            except Exception:
                logger.debug("检测 callgraph 报告失败: %s", report, exc_info=True)
        self._callgraph_languages = tuple(found)

    def _iter_callgraphs_from_cache_reports(
        self, languages: list[Language], project_path: Path
    ):
        """按语言依次解析缓存目录下的 callgraph 报告；每步只保留当前语言的一份 CallGraph。"""
        for language in languages:
            report_path = self.yasa_cache_layout.get_callgraph_report(language)
            graph = self.yasa_tool.parse_callgraph_report(report_path, project_path)
            yield language, graph

    def _build_callgraph_duckdb(
        self,
        languages: list[Language],
        project_path: Path | None,
        *,
        force_rebuild: bool,
    ) -> None:
        """
        构建或复用到共用 ``project_analysis.db`` 中的 CallGraph 数据。

        - ``force_rebuild=True``：DROP cg_* 后按语言**逐个**读报告写入。
        - ``force_rebuild=False``：仅当 ``_callgraph_duckdb_available`` 经探测已为真时复用；
          否则在提供 ``project_path`` 时再导入。是否就绪只由该标志表示（由探测或导入结果更新）。
        """
        db_path = self.analysis_duckdb_path

        try:
            self.check_ready(db_path)
            if not languages:
                return

            if not force_rebuild and self._callgraph_duckdb_available:
                return

            if project_path is None:
                log_util.warning(
                    "未提供 project_path，无法构建 CallGraph DuckDB；"
                    "若库中尚无 cg_* 数据则本次不可用",
                    logger=logger,
                )
                return

            db_path.parent.mkdir(parents=True, exist_ok=True)
            t0 = time.perf_counter()
            try:
                # CallGraph builder 使用自己的独立 DuckDB 连接，并且只改写 cg_* 表。
                # DuckDB 支持同库不同表的并行事务，因此无需用库级锁串行化其他 builder。
                builder = CallGraphDBBuilder(
                    project_path,
                    db_path,
                    rebuild=True,
                    build_indexes=True,
                )
                builder.build_callgraph_db(
                    self._iter_callgraphs_from_cache_reports(languages, project_path),
                )
                ms = (time.perf_counter() - t0) * 1000
                log_util.info(
                    f"CallGraph DuckDB 构建成功: path={db_path}, "
                    f"languages={[lg.value for lg in languages]}, duration={ms:.0f}ms",
                    logger=logger,
                )
                self._callgraph_duckdb_available = True
            except Exception as e:
                log_util.error(
                    f"CallGraph DuckDB 构建失败: path={db_path}, error={e}",
                    logger=logger,
                )
                self._callgraph_duckdb_available = False
                return
        finally:
            if not self._callgraph_languages:
                self._refresh_callgraph_languages_from_cache(project_path)

    def _dump_callgraph_languages(
        self,
        project_path: Path,
        languages: list[Language],
        mode: Mode,
    ) -> list[Language]:
        """
        依次对每种语言执行 dump_callgraph，返回实际产生了有效节点的语言列表。

        dump 时以 return_graph=True 拿回 CallGraph，若 nodes 非空才纳入结果。
        """
        valid_languages: list[Language] = []
        for language in languages:
            algorithm = CallgraphAlgorithm.DEFAULT
            if language in [Language.JAVA, Language.GO]:
                algorithm = CallgraphAlgorithm.CHA
            graph = self.yasa_tool.dump_callgraph(
                project_path,
                language,
                self.yasa_cache_layout.get_language_dir(language),
                algorithm,
                mode,
                return_graph=True,
            )
            if graph is not None and graph.nodes:
                valid_languages.append(language)
            else:
                log_util.info(
                    f"dump_callgraph 返回空图，跳过该语言: language={language}, project={project_path}",
                    logger=logger,
                )
        return valid_languages

    @timed(logger, "yasa_context", "build_context")
    def build_context(self, project_path: Path, languages: list[Language] = None):
        if languages is None:
            languages = [Language.JAVA]

        valid_languages = self._dump_callgraph_languages(project_path, languages, Mode.FULL)
        self._callgraph_languages = tuple(valid_languages)
        self._build_callgraph_duckdb(valid_languages, project_path, force_rebuild=True)

    @timed(logger, "yasa_context", "build_context_incremental")
    def build_context_use_incremental_mode(
        self, project_path: Path, languages: list[Language] = None
    ):
        if languages is None:
            languages = [Language.JAVA]

        valid_languages = self._dump_callgraph_languages(project_path, languages, Mode.INCREMENTAL)
        self._callgraph_languages = tuple(valid_languages)
        self._build_callgraph_duckdb(valid_languages, project_path, force_rebuild=True)

    @timed(logger, "yasa_context", "load_context_from_cache")
    def load_context_from_cache(
        self, languages: list[Language] = None, project_path: Path = None
    ):
        if languages is None:
            languages = global_config.support_languages

        db_path = self.analysis_duckdb_path
        self.check_ready(db_path)
        if self._callgraph_duckdb_available:
            self._callgraph_languages = tuple(languages)
            log_util.info(f"复用已有 DuckDB（CallGraph 数据已就绪）: {db_path}", logger=logger)
        else:
            log_util.info(
                f"duckdb库不存在或 CallGraph 数据未导入，从 callgraph.json 导入至: {db_path}",
                logger=logger,
            )
            self._build_callgraph_duckdb(languages, project_path, force_rebuild=False)

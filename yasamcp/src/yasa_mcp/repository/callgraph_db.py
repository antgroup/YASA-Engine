"""
CallGraph DuckDB 写入模块

将内存中的 callgraph 数据持久化到三张 DuckDB 表：
- cg_nodes:      函数节点表（用户定义函数 + 外部函数）
- cg_call_sites: 调用点信息表（去重后的调用点，call_site_id 唯一列）
- cg_edges:      调用关系表（自增主键 id，source_node_id + target_node_id + call_site_id）

设计要点：
- 三张表**均不使用 PRIMARY KEY 约束**（历史兼容与部分 DuckDB 版本行为），唯一性由 Python 层保证：
    · cg_nodes:      以 callgraph.nodes dict 的 key 天然唯一
    · cg_call_sites: Python set 去重后再写入
    · cg_edges:      自增整型 id，原始 edge_id 仅作普通列
- **默认在所有平台建索引**；仅当调用方传入 ``build_indexes=False`` 时跳过（例如测试）。
- **导入路径**：列式数据先写入临时 **Parquet**（PyArrow），再由 DuckDB ``read_parquet`` 按列名一次性插入，
  避免海量 UNNEST 分批往返；若需 CSV 可自行导出后改用 ``read_csv_auto``（本实现默认 Parquet）。
- **索引**：当前仅建**单列**索引。部分环境下 DuckDB 对大表**多列**索引仍会崩溃，单列索引可稳定建立，
  且优化器可对 ``language`` + ``node_id`` 等条件组合使用多个单列索引。
- call_site_id = sourcefile#start_line:start_col（精确到列号，解决同行多调用歧义）
- language 参与联合索引前缀，支持多语言项目隔离查询
"""
from __future__ import annotations

import logging
import os
import tempfile
import threading
import time
from collections.abc import Iterable
from pathlib import Path

import duckdb
import pyarrow as pa
import pyarrow.parquet as pq

from yasa_mcp.core.enums import Language
from yasa_mcp.repository.shared_analysis_duckdb import SharedDuckDBReadPool
from yasa_mcp.tools.yasa import yasa_module
from yasa_mcp.util import log_util

logger = logging.getLogger(__name__)

# --------------------------------------------------------------------------- #
# DDL — 无 PRIMARY KEY，唯一性由 Python 层保证
# --------------------------------------------------------------------------- #

_CREATE_CG_NODES = """
CREATE TABLE IF NOT EXISTS cg_nodes (
    language            VARCHAR(32)   NOT NULL,
    node_id             TEXT          NOT NULL,

    -- 函数标识
    full_name           TEXT          NOT NULL,
    func_name           VARCHAR(256),

    -- 函数定义位置（外部函数为 NULL）
    func_def_sourcefile TEXT,
    func_def_start_line INTEGER,
    func_def_start_col  INTEGER,
    func_def_end_line   INTEGER,
    func_def_end_col    INTEGER,

    -- 辅助字段
    is_external         BOOLEAN       NOT NULL DEFAULT FALSE,
    full_name_lower     TEXT
)
"""

_CREATE_CG_CALL_SITES = """
CREATE TABLE IF NOT EXISTS cg_call_sites (
    call_site_id            TEXT          NOT NULL,
    language                VARCHAR(32)   NOT NULL,

    call_site_sourcefile    TEXT          NOT NULL,
    call_site_start_line    INTEGER       NOT NULL,
    call_site_start_col     INTEGER,
    call_site_end_line      INTEGER,
    call_site_end_col       INTEGER
)
"""

_CREATE_CG_EDGES = """
CREATE TABLE IF NOT EXISTS cg_edges (
    -- 自增主键，不依赖原始 edge_id 字符串
    id                  BIGINT        NOT NULL,
    language            VARCHAR(32)   NOT NULL,

    -- 原始 edge_id 保留为普通列，便于调试溯源（不作主键）
    raw_edge_id         TEXT,

    source_node_id      TEXT          NOT NULL,
    target_node_id      TEXT          NOT NULL,

    -- 外键关联 cg_call_sites，NULL 表示无调用点信息
    call_site_id        TEXT
)
"""

# 仅使用**单列**索引：在部分 DuckDB 版本 + macOS 上，大表**多列** ART 索引仍会
# SIGSEGV/ABRT；单列索引可稳定建立，且仍能为典型 WHERE / JOIN 提供加速（优化器可多索引配合）。
_INDEXES = [
    # cg_nodes
    "CREATE INDEX IF NOT EXISTS idx_cg_nodes_language          ON cg_nodes (language)",
    "CREATE INDEX IF NOT EXISTS idx_cg_nodes_node_id            ON cg_nodes (node_id)",
    "CREATE INDEX IF NOT EXISTS idx_cg_nodes_func_def_file      ON cg_nodes (func_def_sourcefile)",
    "CREATE INDEX IF NOT EXISTS idx_cg_nodes_func_def_line      ON cg_nodes (func_def_start_line)",
    "CREATE INDEX IF NOT EXISTS idx_cg_nodes_full_name          ON cg_nodes (full_name)",
    "CREATE INDEX IF NOT EXISTS idx_cg_nodes_full_name_lower    ON cg_nodes (full_name_lower)",
    # cg_call_sites
    "CREATE INDEX IF NOT EXISTS idx_cg_cs_language              ON cg_call_sites (language)",
    "CREATE INDEX IF NOT EXISTS idx_cg_cs_call_site_id          ON cg_call_sites (call_site_id)",
    "CREATE INDEX IF NOT EXISTS idx_cg_cs_sourcefile            ON cg_call_sites (call_site_sourcefile)",
    "CREATE INDEX IF NOT EXISTS idx_cg_cs_start_line            ON cg_call_sites (call_site_start_line)",
    # cg_edges
    "CREATE INDEX IF NOT EXISTS idx_cg_edges_language           ON cg_edges (language)",
    "CREATE INDEX IF NOT EXISTS idx_cg_edges_source             ON cg_edges (source_node_id)",
    "CREATE INDEX IF NOT EXISTS idx_cg_edges_target             ON cg_edges (target_node_id)",
    "CREATE INDEX IF NOT EXISTS idx_cg_edges_call_site          ON cg_edges (call_site_id)",
]

# --------------------------------------------------------------------------- #
# 索引与 callgraph_query SQL 的对应关系（仅单列：避免部分平台多列 ART 索引崩溃）
# --------------------------------------------------------------------------- #
# - cg_nodes + node_id + language      → build_function_def_from_node_id
# - cg_nodes + func_def_sourcefile / func_def_start_line → 按 UQL 位置对齐 node（先 file 再行列）
# - cg_nodes + full_name               → 外部节点精确全名；REPLACE+LIKE 模糊名无法走该索引（预期扫描）
# - cg_edges + source_node_id / target_node_id + language → 出边 / 入边
# - cg_edges + call_site_id           → JOIN cg_call_sites
# - cg_call_sites + (call_site_id, language) 由单列 call_site_id + language 组合过滤；JOIN 走 call_site_id
# - cg_call_sites + call_site_sourcefile → iter_edges_with_callsites_filtered IN (...)
# UQL function_defs 侧见 duckdb_repo（含 language 单列，配合 file_path+start_line 复合索引做位置查询）
# --------------------------------------------------------------------------- #


def _apply_bulk_load_settings(conn: duckdb.DuckDBPyConnection) -> None:
    """
    导入阶段 DuckDB 会话级优化（DuckDB 1.5+）：
    - 关闭插入顺序保留，减轻 bulk 写入开销
    - 提高 checkpoint 阈值，减少导入中途刷盘
    - 使用多线程执行（索引构建等可并行）
    """
    threads = min(32, max(1, (os.cpu_count() or 4)))
    conn.execute("SET preserve_insertion_order = false")
    conn.execute("SET enable_progress_bar = false")
    conn.execute(f"SET threads = {threads}")
    conn.execute("SET checkpoint_threshold = '64MB'")


# --------------------------------------------------------------------------- #
# Parquet 暂存 → DuckDB 一次性读入
# --------------------------------------------------------------------------- #


def _write_columns_to_parquet(
    columns: list[str],
    col_data: dict[str, list],
    path: Path,
) -> None:
    """将列式 Python 列表写入单个 Parquet 文件（列名与表字段一致）。"""
    if not columns:
        return
    n = len(col_data[columns[0]])
    if n == 0:
        return
    arrays = {c: pa.array(col_data[c]) for c in columns}
    table = pa.table(arrays)
    path.parent.mkdir(parents=True, exist_ok=True)
    pq.write_table(
        table,
        path,
        compression="zstd",
        use_dictionary=True,
        write_statistics=True,
    )


def _insert_from_parquet(
    conn: duckdb.DuckDBPyConnection,
    table: str,
    columns: list[str],
    parquet_path: Path,
) -> None:
    """按列名从 Parquet 插入，避免与表物理列顺序不一致。"""
    if not columns:
        return
    col_list = ", ".join(columns)
    p = str(parquet_path.resolve())
    sql = (
        f"INSERT INTO {table} ({col_list}) "
        f"SELECT {col_list} FROM read_parquet(?)"
    )
    conn.execute(sql, [p])


# --------------------------------------------------------------------------- #
# 辅助函数
# --------------------------------------------------------------------------- #


def _make_call_site_id(sourcefile: str, start_line: int, start_col: int) -> str:
    """构造 call_site_id：sourcefile#start_line:start_col（精确到列，解决同行多调用歧义）。"""
    return f"{sourcefile}#{start_line}:{start_col}"


def _relative_path(abs_path: str, project_path: Path) -> str:
    """将绝对路径转为相对于 project_path 的 POSIX 路径；转换失败时返回原路径。"""
    try:
        return Path(abs_path).relative_to(project_path).as_posix()
    except ValueError:
        return abs_path


def _normalize_full_name(raw: str | None) -> str:
    """Normalize callgraph display FQN while keeping raw node ids untouched."""
    if not raw:
        return ""
    normalized = raw.strip().replace("\\", "/").lstrip("/").replace("/", ".")
    while ".." in normalized:
        normalized = normalized.replace("..", ".")
    return normalized.strip(".")


def _name_from_full_name(full_name: str) -> str | None:
    if not full_name:
        return None
    return full_name.rsplit(".", 1)[-1] or None


# --------------------------------------------------------------------------- #
# 建表 & 写入
# --------------------------------------------------------------------------- #


def _create_tables(conn: duckdb.DuckDBPyConnection) -> None:
    conn.execute(_CREATE_CG_NODES)
    conn.execute(_CREATE_CG_CALL_SITES)
    conn.execute(_CREATE_CG_EDGES)


def _create_indexes(conn: duckdb.DuckDBPyConnection) -> None:
    start = time.perf_counter()
    try:
        conn.execute("SET threads = 1")
    except Exception:
        pass
    for stmt in _INDEXES:
        conn.execute(stmt)
        time.sleep(0)
    elapsed_ms = (time.perf_counter() - start) * 1000
    log_util.info(f"[callgraph_db] 索引创建完成: count={len(_INDEXES)}, duration={elapsed_ms:.0f}ms", logger=logger)


def _drop_callgraph_tables(conn: duckdb.DuckDBPyConnection) -> None:
    """删除 cg_* 三张表（与 UQL 共库时保留 function_defs / class_defs）。"""
    for tbl in ("cg_edges", "cg_call_sites", "cg_nodes"):
        try:
            conn.execute(f"DROP TABLE IF EXISTS {tbl}")
        except Exception:
            log_util.warning(f"[callgraph_db] DROP TABLE {tbl} 失败", logger=logger)


# --------------------------------------------------------------------------- #
# CallGraph DuckDB 构建器（写入 / 重建 / 删除）
# --------------------------------------------------------------------------- #


class CallGraphDBBuilder:
    """
    将 CallGraph 写入 DuckDB（可与 UQL 共用同一文件）。

    ``rebuild=True`` 时仅 ``DROP`` cg_* 表，不删除整个库文件，以免清空 function_defs 等。
    """

    def __init__(
        self,
        project_path: Path,
        db_path: Path,
        *,
        rebuild: bool = True,
        build_indexes: bool = True,
    ) -> None:
        self.project_path = project_path
        self.db_path = db_path
        self.rebuild = rebuild
        self.build_indexes = build_indexes

    def remove_existing_db_files(self) -> None:
        """
        rebuild 时清理 CallGraph 占用的表。

        若库文件已存在则只删除 cg_* 三张表；若文件不存在则无需操作。
        （不再 unlink 整库，以支持与 UQL 共库。）

        注意：会单独 ``duckdb.connect`` 一次。若紧接着还要 ``build_callgraph_db``，请直接依赖
        ``build_callgraph_db`` 内的单连接流程（先 DROP 再导入），避免对同一文件连续两次连接
        在部分环境下触发 DuckDB 原生 SIGABRT。
        """
        if not self.db_path.exists():
            return
        conn = duckdb.connect(str(self.db_path))
        try:
            _drop_callgraph_tables(conn)
        finally:
            try:
                conn.execute("CHECKPOINT")
            except Exception:
                pass
            conn.close()

    def ensure_parent_dir(self) -> None:
        """确保数据库文件父目录存在。"""
        self.db_path.parent.mkdir(parents=True, exist_ok=True)

    def _import_callgraph_into_db(
        self,
        conn: duckdb.DuckDBPyConnection,
        lang_str: str,
        callgraph: yasa_module.CallGraph,
        edge_id_start: int,
        staging_dir: Path,
    ) -> tuple[int, int, int]:
        """
        将**单个**语言的 CallGraph 经 Parquet 中转写入三张表。

        :param edge_id_start: 自增 edge id 起始值（多语言累加不冲突）
        :return: (nodes_count, call_sites_count, edges_count)
        """
        project_path = self.project_path
        # ------------------------------------------------------------------ #
        # 1. cg_nodes（预分配列表）
        # ------------------------------------------------------------------ #
        nodes_dict = callgraph.nodes
        nodes_count = len(nodes_dict)
        n_language = [lang_str] * nodes_count
        n_node_id = [""] * nodes_count
        n_full_name = [""] * nodes_count
        n_func_name: list[str | None] = [None] * nodes_count
        n_sourcefile: list[str | None] = [None] * nodes_count
        n_start_line: list[int | None] = [None] * nodes_count
        n_start_col: list[int | None] = [None] * nodes_count
        n_end_line: list[int | None] = [None] * nodes_count
        n_end_col: list[int | None] = [None] * nodes_count
        n_is_external = [False] * nodes_count
        n_full_name_lower = [""] * nodes_count

        for i, node in enumerate(nodes_dict.values()):
            normalized_full_name = _normalize_full_name(node.fullName)
            func_name: str | None = _name_from_full_name(normalized_full_name)
            rel_path: str | None = None
            start_line: int | None = None
            start_col: int | None = None
            end_line: int | None = None
            end_col: int | None = None

            func_def = node.funcDef
            if isinstance(func_def, str):
                is_external = True
            else:
                loc = func_def.loc
                if isinstance(loc, str) or loc is None:
                    is_external = True
                else:
                    is_external = False
                    func_name = func_def.name or func_name
                    rel_path = _relative_path(loc.sourcefile, project_path)
                    start_line = loc.start.line
                    start_col = loc.start.column
                    end_line = loc.end.line
                    end_col = loc.end.column

            n_node_id[i] = node.id
            n_full_name[i] = normalized_full_name
            n_func_name[i] = func_name
            n_sourcefile[i] = rel_path
            n_start_line[i] = start_line
            n_start_col[i] = start_col
            n_end_line[i] = end_line
            n_end_col[i] = end_col
            n_is_external[i] = is_external
            n_full_name_lower[i] = normalized_full_name.lower()

        node_cols = [
            "language",
            "node_id",
            "full_name",
            "func_name",
            "func_def_sourcefile",
            "func_def_start_line",
            "func_def_start_col",
            "func_def_end_line",
            "func_def_end_col",
            "is_external",
            "full_name_lower",
        ]
        node_data = {
            "language": n_language,
            "node_id": n_node_id,
            "full_name": n_full_name,
            "func_name": n_func_name,
            "func_def_sourcefile": n_sourcefile,
            "func_def_start_line": n_start_line,
            "func_def_start_col": n_start_col,
            "func_def_end_line": n_end_line,
            "func_def_end_col": n_end_col,
            "is_external": n_is_external,
            "full_name_lower": n_full_name_lower,
        }

        # ------------------------------------------------------------------ #
        # 2. cg_call_sites + cg_edges
        # ------------------------------------------------------------------ #
        seen_call_site_ids: set[str] = set()
        cs_call_site_id: list[str] = []
        cs_language: list[str] = []
        cs_sourcefile: list[str] = []
        cs_start_line: list[int] = []
        cs_start_col: list[int | None] = []
        cs_end_line: list[int | None] = []
        cs_end_col: list[int | None] = []

        edges_dict = callgraph.edges
        edges_count = len(edges_dict)
        e_id = list(range(edge_id_start, edge_id_start + edges_count))
        e_language = [lang_str] * edges_count
        e_raw_edge_id = [""] * edges_count
        e_source = [""] * edges_count
        e_target = [""] * edges_count
        e_call_site_id: list[str | None] = [None] * edges_count

        for i, edge in enumerate(edges_dict.values()):
            call_site_id: str | None = None

            call_site = edge.callSite
            if call_site is not None:
                loc = call_site.loc
                if loc is not None and not isinstance(loc, str):
                    rel_cs_path = _relative_path(loc.sourcefile, project_path)
                    call_site_id = _make_call_site_id(
                        rel_cs_path, loc.start.line, loc.start.column
                    )
                    if call_site_id not in seen_call_site_ids:
                        seen_call_site_ids.add(call_site_id)
                        cs_call_site_id.append(call_site_id)
                        cs_language.append(lang_str)
                        cs_sourcefile.append(rel_cs_path)
                        cs_start_line.append(loc.start.line)
                        cs_start_col.append(loc.start.column)
                        cs_end_line.append(loc.end.line)
                        cs_end_col.append(loc.end.column)

            e_raw_edge_id[i] = edge.id
            e_source[i] = edge.sourceNodeId
            e_target[i] = edge.targetNodeId
            e_call_site_id[i] = call_site_id

        call_sites_count = len(cs_call_site_id)

        safe_lang = lang_str.replace("/", "_").replace("\\", "_")
        nodes_pq = staging_dir / f"cg_nodes_{safe_lang}.parquet"
        cs_pq = staging_dir / f"cg_call_sites_{safe_lang}.parquet"
        edges_pq = staging_dir / f"cg_edges_{safe_lang}_{edge_id_start}.parquet"

        if nodes_count > 0:
            _write_columns_to_parquet(node_cols, node_data, nodes_pq)
            _insert_from_parquet(conn, "cg_nodes", node_cols, nodes_pq)
            nodes_pq.unlink(missing_ok=True)

        cs_cols = [
            "call_site_id",
            "language",
            "call_site_sourcefile",
            "call_site_start_line",
            "call_site_start_col",
            "call_site_end_line",
            "call_site_end_col",
        ]
        if call_sites_count > 0:
            cs_data = {
                "call_site_id": cs_call_site_id,
                "language": cs_language,
                "call_site_sourcefile": cs_sourcefile,
                "call_site_start_line": cs_start_line,
                "call_site_start_col": cs_start_col,
                "call_site_end_line": cs_end_line,
                "call_site_end_col": cs_end_col,
            }
            _write_columns_to_parquet(cs_cols, cs_data, cs_pq)
            _insert_from_parquet(conn, "cg_call_sites", cs_cols, cs_pq)
            cs_pq.unlink(missing_ok=True)

        edge_cols = [
            "id",
            "language",
            "raw_edge_id",
            "source_node_id",
            "target_node_id",
            "call_site_id",
        ]
        if edges_count > 0:
            edge_data = {
                "id": e_id,
                "language": e_language,
                "raw_edge_id": e_raw_edge_id,
                "source_node_id": e_source,
                "target_node_id": e_target,
                "call_site_id": e_call_site_id,
            }
            _write_columns_to_parquet(edge_cols, edge_data, edges_pq)
            _insert_from_parquet(conn, "cg_edges", edge_cols, edges_pq)
            edges_pq.unlink(missing_ok=True)

        return nodes_count, call_sites_count, edges_count

    def _import_all_callgraph_into_db(
        self,
        conn: duckdb.DuckDBPyConnection,
        staging_dir: Path,
        per_language_graphs: Iterable[tuple[Language, yasa_module.CallGraph]],
    ) -> tuple[int, int, int]:
        """
        在已开启的事务中：建空表 → 按语言依次导入。

        ``per_language_graphs`` 宜为生成器，避免多语言图同时驻留内存。
        返回累计 (节点数, 调用点数, 边数)。
        """
        t_ddl = time.perf_counter()
        _create_tables(conn)
        log_util.info(
            f"[callgraph_db] DDL 建表(cg_nodes/cg_call_sites/cg_edges): "
            f"{(time.perf_counter() - t_ddl) * 1000:.1f}ms",
            logger=logger,
        )

        total_nodes = 0
        total_call_sites = 0
        total_edges = 0
        next_edge_id = 0

        for language, graph in per_language_graphs:
            lang_label = language.value
            t_lang = time.perf_counter()

            n_nodes, n_sites, n_edges = self._import_callgraph_into_db(
                conn,
                lang_label,
                graph,
                next_edge_id,
                staging_dir,
            )
            next_edge_id += n_edges
            total_nodes += n_nodes
            total_call_sites += n_sites
            total_edges += n_edges

            ms = (time.perf_counter() - t_lang) * 1000
            log_util.info(
                f"[callgraph_db] 已导入语言 {lang_label}: "
                f"nodes={n_nodes}, call_sites={n_sites}, edges={n_edges}, duration={ms:.0f}ms",
                logger=logger,
            )

        return total_nodes, total_call_sites, total_edges

    def build_callgraph_db(
        self,
        per_language_graphs: Iterable[tuple[Language, yasa_module.CallGraph]],
    ) -> Path:
        """
        将 ``(Language, CallGraph)`` 可迭代对象写入 ``self.db_path``。

        若 ``self.rebuild`` 为 True，会先 ``DROP`` cg_* 表再写入（共库安全）。
        """
        t0 = time.perf_counter()
        log_util.info(
            f"[callgraph_db] CallGraphDBBuilder.build_callgraph_db 开始: "
            f"path={self.db_path}, rebuild={self.rebuild}, build_indexes={self.build_indexes}",
            logger=logger,
        )

        t_prep = time.perf_counter()
        self.ensure_parent_dir()
        log_util.info(
            f"[callgraph_db] 阶段1 准备(建父目录): "
            f"{(time.perf_counter() - t_prep) * 1000:.1f}ms",
            logger=logger,
        )

        with tempfile.TemporaryDirectory(prefix="yasa_mcp_callgraph_") as tmpdir:
            staging_dir = Path(tmpdir)
            t_conn = time.perf_counter()
            # 与 UQL 共库时：勿在 DROP cg_* 后立刻第二次 connect（部分 macOS+DuckDB 会 SIGABRT）
            conn = duckdb.connect(str(self.db_path))
            try:
                _apply_bulk_load_settings(conn)
                if self.rebuild:
                    _drop_callgraph_tables(conn)
                    log_util.info(
                        f"[callgraph_db] 已清理 callgraph 表（文件保留，单连接内）: {self.db_path}",
                        logger=logger,
                    )
                log_util.info(
                    f"[callgraph_db] 阶段2 连接 DuckDB + bulk 会话参数: "
                    f"{(time.perf_counter() - t_conn) * 1000:.1f}ms",
                    logger=logger,
                )

                t_data = time.perf_counter()
                conn.execute("BEGIN")
                try:
                    total_nodes, total_cs, total_edges = self._import_all_callgraph_into_db(
                        conn, staging_dir, per_language_graphs
                    )
                    conn.execute("COMMIT")
                except Exception:
                    try:
                        conn.execute("ROLLBACK")
                    except Exception:
                        pass
                    raise
                log_util.info(
                    f"[callgraph_db] 阶段3 数据事务(逐语言导入+COMMIT): "
                    f"{(time.perf_counter() - t_data) * 1000:.1f}ms, "
                    f"totals nodes={total_nodes}, call_sites={total_cs}, edges={total_edges}",
                    logger=logger,
                )

                if self.build_indexes:
                    t_idx = time.perf_counter()
                    conn.execute("BEGIN")
                    try:
                        _create_indexes(conn)
                        conn.execute("COMMIT")
                    except Exception:
                        try:
                            conn.execute("ROLLBACK")
                        except Exception:
                            pass
                        raise
                    log_util.info(
                        f"[callgraph_db] 阶段4 索引创建+COMMIT: "
                        f"{(time.perf_counter() - t_idx) * 1000:.1f}ms",
                        logger=logger,
                    )
                else:
                    log_util.info("[callgraph_db] 已跳过索引（build_indexes=False）", logger=logger)

            except Exception:
                log_util.exception("[callgraph_db] 写入 DuckDB 失败", logger=logger)
                raise
            finally:
                try:
                    conn.execute("CHECKPOINT")
                except Exception:
                    pass
                conn.close()

        elapsed_ms = (time.perf_counter() - t0) * 1000
        size_kb = self.db_path.stat().st_size / 1024 if self.db_path.exists() else 0
        log_util.info(
            f"[callgraph_db] 写入完成: path={self.db_path}, size={size_kb:.0f}KB, "
            f"nodes={total_nodes}, call_sites={total_cs}, edges={total_edges}, "
            f"duration={elapsed_ms:.0f}ms",
            logger=logger,
        )
        return self.db_path


# --------------------------------------------------------------------------- #
# 模块级便捷函数（兼容测试与脚本）
# --------------------------------------------------------------------------- #


def build_callgraph_db(
    project_path: Path,
    callgraph_data: dict[Language, yasa_module.CallGraph],
    db_path: Path,
    rebuild: bool = True,
    *,
    build_indexes: bool = True,
) -> Path:
    """
    将内存中的 callgraph 数据写入 DuckDB（三张表）。

    :param project_path:    项目根目录，用于路径规范化（绝对 → 相对）
    :param callgraph_data:  {Language: CallGraph}（测试或工具可一次性提供多语言）
    :param db_path:         DuckDB 文件路径（由调用方提供，通常由 YasaCacheLayout 生成）
    :param rebuild:         True 时删除已有文件重建
    :param build_indexes:   默认 True，在所有操作系统上创建索引；False 时跳过（如单元测试）
    :return:                db_path
    """
    log_util.info(
        f"[callgraph_db] build_callgraph_db(dict): languages={[l.value for l in callgraph_data]}",
        logger=logger,
    )
    builder = CallGraphDBBuilder(
        project_path,
        db_path,
        rebuild=rebuild,
        build_indexes=build_indexes,
    )
    return builder.build_callgraph_db(callgraph_data.items())


# --------------------------------------------------------------------------- #
# 只读连接管理（供查询层使用）
# --------------------------------------------------------------------------- #


class CallgraphDB:
    """
    封装 DuckDB 只读查询。

    - 可传入 ``read_pool`` 与 ``DuckDBAnalysisRepository`` 共享同一线程内的只读连接。
    - 无 ``read_pool`` 时为每个线程维护独立连接（DuckDB 连接非线程安全）。
    """

    def __init__(
        self,
        db_path: str,
        read_pool: SharedDuckDBReadPool | None = None,
    ):
        self._db_path = db_path
        self._read_pool = read_pool
        self._local = threading.local()

    def _get_connection(self) -> duckdb.DuckDBPyConnection:
        """无 ``read_pool`` 时的回退：每线程独立只读连接（与 ``SharedDuckDBReadPool`` 行为对齐）。"""
        conn = getattr(self._local, "conn", None)
        if conn is None:
            conn = duckdb.connect(self._db_path, read_only=True)
            self._local.conn = conn
        return conn

    def query(self, sql: str, params: list | None = None) -> list[dict]:
        if self._read_pool is not None:
            return self._read_pool.query(sql, params)
        conn = self._get_connection()
        result = conn.execute(sql, params or [])
        columns = [desc[0] for desc in result.description]
        return [dict(zip(columns, row)) for row in result.fetchall()]

    def close(self):
        if self._read_pool is not None:
            return
        conn = getattr(self._local, "conn", None)
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass
            self._local.conn = None

"""
DuckDB 实现的 AnalysisRepository

特性：
- 采用 DuckDB 原生 read_csv + auto_detect 批量加载（比逐行 INSERT 快 300x+）
- 第一个 CSV 使用 CREATE TABLE AS SELECT（同 server.py 参考实现），多语言时后续 CSV 用 INSERT INTO 追加
- 使用 threading.local() 为每个线程维护独立的只读连接（DuckDB 连接非线程安全）
- 预留 MySQL 等数据库的切换能力（通过 AnalysisRepository 抽象类）
"""
import logging
import threading
import time
from pathlib import Path
from typing import Callable

import duckdb

from yasa_mcp.repository.base import AnalysisRepository
from yasa_mcp.repository.fqn_match import segment_boundary_regex
from yasa_mcp.repository.shared_analysis_duckdb import SharedDuckDBReadPool
from yasa_mcp.util import log_util

logger = logging.getLogger(__name__)

_LOCATION_REGEX = r"^(.+):(\d+):(\d+):(\d+):(\d+)$"


class DuckDBBuilder:
    """从 UQL 生成的 CSV 报告批量构建 DuckDB 数据库。

    采用 DuckDB 原生 read_csv + auto_detect 批量加载，
    第一个 CSV 使用 CREATE TABLE AS SELECT，多语言时后续 CSV 用 INSERT INTO 追加。
    """

    def __init__(self, db_path: Path):
        self._db_path = db_path

    def build(
        self,
        function_def_csvs: list[tuple[Path, str, str]],
        class_def_csvs: list[tuple[Path, str, str]],
        iface_impl_csvs: list[tuple[Path, str, str]] | None = None,
        rebuild: bool = False,
    ) -> Path:
        """
        从 CSV 报告构建 DuckDB 数据库。

        :param function_def_csvs: [(csv_path, language, appname), ...]
        :param class_def_csvs:    [(csv_path, language, appname), ...]
        :param iface_impl_csvs:   [(csv_path, language, appname), ...]，可选，为空表示不构建 interface_implement 表
        :param rebuild: True 时删除已有数据库重新构建
        :return: db_path
        """
        if iface_impl_csvs is None:
            iface_impl_csvs = []
        total_start = time.perf_counter()
        log_util.info(f"开始构建Code Search DuckDB: db={self._db_path}, rebuild={rebuild}", logger=logger)

        # 与 CallGraph 共库时仅删除 UQL 相关表，避免删掉 cg_* 与同文件内其他数据
        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        if rebuild and self._db_path.exists():
            _conn_drop = duckdb.connect(str(self._db_path))
            try:
                _conn_drop.execute("DROP TABLE IF EXISTS function_defs")
                _conn_drop.execute("DROP TABLE IF EXISTS class_defs")
                _conn_drop.execute("DROP TABLE IF EXISTS interface_implement")
                log_util.info(
                    "已删除 UQL 表 function_defs/class_defs/interface_implement"
                    "（保留同库内 CallGraph 等其它表）", logger=logger
                )
            finally:
                try:
                    _conn_drop.execute("CHECKPOINT")
                except Exception:
                    pass
                _conn_drop.close()

        conn = duckdb.connect(str(self._db_path))

        try:
            self._import_table(
                conn, "function_defs", function_def_csvs, self._func_select_sql,
            )
            self._import_table(
                conn, "class_defs", class_def_csvs, self._class_select_sql,
            )
            self._import_table(
                conn, "interface_implement", iface_impl_csvs, self._iface_impl_select_sql,
            )
            self._ensure_tables(conn)
            self._create_indexes(conn)
        except Exception as e:
            log_util.exception(f"构建DuckDB失败: {e}", logger=logger)
            raise
        finally:
            try:
                conn.execute("CHECKPOINT")
            except Exception:
                pass
            conn.close()

        elapsed_ms = (time.perf_counter() - total_start) * 1000
        db_size_kb = self._db_path.stat().st_size / 1024 if self._db_path.exists() else 0
        log_util.info(
            f"Code Search DuckDB构建完成: db={self._db_path}, "
            f"size={db_size_kb:.0f}KB, duration={elapsed_ms:.0f}ms", logger=logger
        )
        return self._db_path

    # ── 表导入 ─────────────────────────────────────────────────

    @staticmethod
    def _import_table(
        conn: duckdb.DuckDBPyConnection,
        table_name: str,
        csv_list: list[tuple[Path, str, str]],
        select_sql_fn: Callable[[Path, str, str], str],
    ):
        """导入一张表：第一个 CSV 用 CREATE TABLE AS，后续 CSV 用 INSERT INTO。"""
        table_exists = conn.execute(
            "SELECT count(*) FROM information_schema.tables WHERE table_name = ?",
            [table_name],
        ).fetchone()[0] > 0

        for csv_path, language, appname in csv_list:
            if not csv_path.exists():
                log_util.warning(f"{table_name} CSV 不存在: {csv_path}", logger=logger)
                continue

            if csv_path.stat().st_size == 0:
                log_util.warning(f"{table_name} CSV 为空文件: {csv_path}", logger=logger)
                continue

            start = time.perf_counter()
            select_sql = select_sql_fn(csv_path, language, appname)

            try:
                if not table_exists:
                    conn.execute(f"CREATE TABLE {table_name} AS {select_sql}")
                    table_exists = True
                else:
                    conn.execute(f"INSERT INTO {table_name} {select_sql}")
            except Exception as e:
                log_util.warning(f"导入 {table_name} 失败(csv={csv_path}): {e}", logger=logger)
                continue

            count = conn.execute(
                f"SELECT count(*) FROM {table_name} WHERE language = ?",
                [language],
            ).fetchone()[0]
            elapsed_ms = (time.perf_counter() - start) * 1000
            log_util.info(
                f"导入 {table_name}: language={language}, "
                f"count={count}, duration={elapsed_ms:.0f}ms", logger=logger
            )

    # ── SELECT SQL 生成 ────────────────────────────────────────

    @staticmethod
    def _func_select_sql(csv_path: Path, language: str, appname: str) -> str:
        csv_str = str(csv_path).replace("'", "''")
        appname_slash = f"{appname}/" if appname else ""
        appname_len = len(appname_slash)

        return f"""
            SELECT
                fqn AS function_fqn,
                sig AS function_signature,
                '{language}' AS language,
                CASE
                    WHEN '{appname_slash}' != ''
                         AND strpos(raw_fp, '{appname_slash}') > 0
                    THEN substr(raw_fp,
                                strpos(raw_fp, '{appname_slash}') + {appname_len})
                    ELSE raw_fp
                END AS file_path,
                sl AS start_line,
                sc AS start_column,
                el AS end_line,
                ec AS end_column,
                string_split(fqn, '.')[-1] AS short_name
            FROM (
                SELECT
                    column0 AS fqn,
                    column1 AS sig,
                    regexp_extract(column2, '{_LOCATION_REGEX}', 1) AS raw_fp,
                    CAST(regexp_extract(column2, '{_LOCATION_REGEX}', 2) AS INTEGER) AS sl,
                    CAST(regexp_extract(column2, '{_LOCATION_REGEX}', 3) AS INTEGER) AS sc,
                    CAST(regexp_extract(column2, '{_LOCATION_REGEX}', 4) AS INTEGER) AS el,
                    CAST(regexp_extract(column2, '{_LOCATION_REGEX}', 5) AS INTEGER) AS ec
                FROM read_csv('{csv_str}', header=false, auto_detect=true)
                WHERE column2 IS NOT NULL AND length(trim(column2)) > 0
            )
        """

    @staticmethod
    def _class_select_sql(csv_path: Path, language: str, appname: str) -> str:
        csv_str = str(csv_path).replace("'", "''")
        appname_slash = f"{appname}/" if appname else ""
        appname_len = len(appname_slash)

        return f"""
            SELECT
                fqn AS class_fqn,
                '{language}' AS language,
                CASE
                    WHEN '{appname_slash}' != ''
                         AND strpos(raw_fp, '{appname_slash}') > 0
                    THEN substr(raw_fp,
                                strpos(raw_fp, '{appname_slash}') + {appname_len})
                    ELSE raw_fp
                END AS file_path,
                sl AS start_line,
                sc AS start_column,
                el AS end_line,
                ec AS end_column,
                string_split(fqn, '.')[-1] AS short_name
            FROM (
                SELECT
                    column0 AS fqn,
                    regexp_extract(column1, '{_LOCATION_REGEX}', 1) AS raw_fp,
                    CAST(regexp_extract(column1, '{_LOCATION_REGEX}', 2) AS INTEGER) AS sl,
                    CAST(regexp_extract(column1, '{_LOCATION_REGEX}', 3) AS INTEGER) AS sc,
                    CAST(regexp_extract(column1, '{_LOCATION_REGEX}', 4) AS INTEGER) AS el,
                    CAST(regexp_extract(column1, '{_LOCATION_REGEX}', 5) AS INTEGER) AS ec
                FROM read_csv('{csv_str}', header=false, auto_detect=true)
                WHERE column1 IS NOT NULL AND length(trim(column1)) > 0
            )
        """

    # ── interface_implement 表 ─────────────────────────────────

    @staticmethod
    def _iface_impl_select_sql(csv_path: Path, language: str, appname: str) -> str:
        """interface_implement 表的 SELECT SQL。

        CSV 6 列（无 header），来自 yasa_mcp_bin uql 规则
        ``get_function_implement_def`` 的 ``select`` 子句：

          column0 = interface_method_FQN（如 com.alipay.x.IFooService.bar）
          column1 = method_name（丢弃，由 fqcn 末段拆出）
          column2 = interface_method_location（path:sLine:sCol:eLine:eCol，绝对路径，
                    入库为 interface_location，与 function_impl_location 同处理）
          column3 = impl_method_FQN（如 com.alipay.x.impl.IFooServiceImpl.bar）
          column4 = function_signature（实现方法签名，例 ``downloadExportFile(QueryExportTaskListReq req)``）
          column5 = impl_method_location（同 column2 格式，入库为 function_impl_location）

        short_name 拆分口径：FQCN 末两段用 ``.`` 拼接，例：
          - ``com.alipay.x.IFooService.bar`` → ``IFooService.bar``
          - ``com.alipay.x.impl.IFooServiceImpl.bar`` → ``IFooServiceImpl.bar``
        用 ``regexp_extract(fqcn, '([^.]+\\.[^.]+)$', 1)`` 现算。

        location 路径转相对：复用 ``_func_select_sql`` 的 ``appname/`` 切片策略。
        location 字符串是「path:sl:sc:el:ec」，先 ``strpos(loc, 'appname/')`` 定位前缀，
        再 ``substr`` 切到前缀之后，保留 ``:sl:sc:el:ec`` 尾部，与 routes/function_defs 习惯一致。
        接口侧 column2 与实现侧 column5 完全同处理。
        """
        csv_str = str(csv_path).replace("'", "''")
        appname_slash = f"{appname}/" if appname else ""
        appname_len = len(appname_slash)

        # location 字符串相对路径化的 SQL 片段，接口侧 / 实现侧共用同一段表达式
        def _rel_loc(col: str) -> str:
            return f"""CASE
                    WHEN '{appname_slash}' != ''
                         AND strpos({col}, '{appname_slash}') > 0
                    THEN substr({col},
                                strpos({col}, '{appname_slash}') + {appname_len})
                    ELSE {col}
                END"""

        return f"""
            SELECT
                '{language}' AS language,
                iface_fqcn AS interface_fqcn,
                regexp_extract(iface_fqcn, '([^.]+\\.[^.]+)$', 1) AS interface_short_name,
                {_rel_loc('iface_loc')} AS interface_location,
                impl_fqcn AS function_impl_fqcn,
                regexp_extract(impl_fqcn, '([^.]+\\.[^.]+)$', 1) AS function_short_name,
                impl_sig AS function_signature,
                {_rel_loc('impl_loc')} AS function_impl_location
            FROM (
                SELECT
                    column0 AS iface_fqcn,
                    column2 AS iface_loc,
                    column3 AS impl_fqcn,
                    column4 AS impl_sig,
                    column5 AS impl_loc
                FROM read_csv('{csv_str}', header=false, auto_detect=true)
                WHERE column0 IS NOT NULL AND length(trim(column0)) > 0
                  AND column3 IS NOT NULL AND length(trim(column3)) > 0
            )
        """

    # ── 空表兜底 + 索引 ───────────────────────────────────────

    @staticmethod
    def _ensure_tables(conn: duckdb.DuckDBPyConnection):
        """若 CSV 列表为空，确保空表存在以便后续查询不会报错。"""
        conn.execute("""
            CREATE TABLE IF NOT EXISTS function_defs (
                function_fqn VARCHAR, function_signature VARCHAR,
                language VARCHAR, file_path VARCHAR,
                start_line INTEGER, start_column INTEGER,
                end_line INTEGER, end_column INTEGER,
                short_name VARCHAR
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS class_defs (
                class_fqn VARCHAR, language VARCHAR, file_path VARCHAR,
                start_line INTEGER, start_column INTEGER,
                end_line INTEGER, end_column INTEGER,
                short_name VARCHAR
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS interface_implement (
                language VARCHAR,
                interface_fqcn VARCHAR,
                interface_short_name VARCHAR,
                interface_location VARCHAR,
                function_impl_fqcn VARCHAR,
                function_short_name VARCHAR,
                function_signature VARCHAR,
                function_impl_location VARCHAR
            )
        """)

    @staticmethod
    def _create_indexes(conn: duckdb.DuckDBPyConnection):
        """创建 UQL 表二级索引。

        注意：DuckDB 1.5.0 在 macOS arm64 上对大表（10 万+ 行）创建**复合 ART 索引**
        会在 ``conn.close()`` 时触发 SIGABRT / SIGSEGV（已通过复现脚本确认）。
        因此将 ``(file_path, start_line)`` 复合索引拆为两个单列索引；
        DuckDB 优化器会对同一查询的多个单列索引做 index intersection。
        """
        start = time.perf_counter()
        try:
            conn.execute("SET threads = 1")
        except Exception:
            pass
        index_stmts = [
            "CREATE INDEX IF NOT EXISTS idx_class_fqn ON class_defs(class_fqn)",
            "CREATE INDEX IF NOT EXISTS idx_class_short_name ON class_defs(short_name)",
            "CREATE INDEX IF NOT EXISTS idx_class_file_path ON class_defs(file_path)",
            "CREATE INDEX IF NOT EXISTS idx_func_language ON function_defs(language)",
            "CREATE INDEX IF NOT EXISTS idx_func_fqn ON function_defs(function_fqn)",
            "CREATE INDEX IF NOT EXISTS idx_func_short_name ON function_defs(short_name)",
            "CREATE INDEX IF NOT EXISTS idx_func_signature ON function_defs(function_signature)",
            "CREATE INDEX IF NOT EXISTS idx_func_file_path ON function_defs(file_path)",
            "CREATE INDEX IF NOT EXISTS idx_func_start_line ON function_defs(start_line)",
            # interface_implement 表的单列索引（避免复合索引，遵守 DuckDB macOS arm64 SIGSEGV 规约）
            "CREATE INDEX IF NOT EXISTS idx_iface_impl_language ON interface_implement(language)",
            "CREATE INDEX IF NOT EXISTS idx_iface_impl_interface_fqcn ON interface_implement(interface_fqcn)",
            "CREATE INDEX IF NOT EXISTS idx_iface_impl_interface_short ON interface_implement(interface_short_name)",
            "CREATE INDEX IF NOT EXISTS idx_iface_impl_impl_fqcn ON interface_implement(function_impl_fqcn)",
            "CREATE INDEX IF NOT EXISTS idx_iface_impl_impl_short ON interface_implement(function_short_name)",
        ]
        n = len(index_stmts)
        for i, stmt in enumerate(index_stmts, 1):
            conn.execute(stmt)
            log_util.info(f"成功创建一条UQL索引[{i}/{n}]: {stmt}", logger=logger)

        elapsed_ms = (time.perf_counter() - start) * 1000
        log_util.info(f"索引创建完成: count={n}, duration={elapsed_ms:.0f}ms", logger=logger)


class DuckDBAnalysisRepository(AnalysisRepository):

    def __init__(
        self,
        db_path: str,
        read_pool: SharedDuckDBReadPool | None = None,
    ):
        self._db_path = db_path
        self._read_pool = read_pool
        self._local = threading.local()
        self._all_functions_cache: list[dict] | None = None

    # ── 连接管理（线程安全）──────────────────────────────────────

    def _get_connection(self) -> duckdb.DuckDBPyConnection:
        """无 ``read_pool`` 时的回退：每线程独立只读连接（与 ``SharedDuckDBReadPool`` 行为对齐）。"""
        conn = getattr(self._local, "conn", None)
        if conn is None:
            conn = duckdb.connect(self._db_path, read_only=True)
            self._local.conn = conn
        return conn

    def _query(self, sql: str, params: list | None = None) -> list[dict]:
        if self._read_pool is not None:
            try:
                return self._read_pool.query(sql, params)
            except Exception as e:
                log_util.error(
                    f"Code Search DuckDB query error (shared pool): sql={sql}, params={params}, error={e}", logger=logger
                )
                raise
        conn = self._get_connection()
        try:
            result = conn.execute(sql, params or [])
            columns = [desc[0] for desc in result.description]
            return [dict(zip(columns, row)) for row in result.fetchall()]
        except Exception as e:
            log_util.error(f"Code Search DuckDB query error: sql={sql}, params={params}, error={e}", logger=logger)
            raise

    @staticmethod
    def _like_param(value: str) -> str:
        """构建 LIKE 参数：若已含通配符 % 则原样使用，否则两侧加 %。

        LIKE 支持 % 和 _ 两种通配符，但 _ 在 Java 标识符和文件路径中
        大量出现，不适合作为"用户已自定义模式"的判据，因此仅检测 %。
        """
        if "%" in value:
            return value
        return f"%{value}%"

    # ── class_defs 查询 ─────────────────────────────────────────

    def search_class_defs(
        self, name: str = "", class_fqn: str = "", use_regex: bool = False,
        limit: int = 0, offset: int = 0,
    ) -> list[dict]:
        start = time.perf_counter()
        if class_fqn:
            # 段边界匹配：支持「短类名」/「包前缀」按 . 段边界命中完整 FQCN，
            # 排除段被截断的误命中（如 main.Main 不命中 main.MainApp）。
            sql = "SELECT * FROM class_defs WHERE regexp_matches(class_fqn, ?)"
            params: list = [segment_boundary_regex(class_fqn)]
        elif use_regex:
            sql = "SELECT * FROM class_defs WHERE regexp_matches(class_fqn, ?) OR regexp_matches(short_name, ?)"
            params = [name, name]
        else:
            sql = "SELECT * FROM class_defs WHERE regexp_matches(class_fqn, ?) OR short_name = ?"
            params = [segment_boundary_regex(name), name]

        if limit > 0:
            sql += " LIMIT ?"
            params.append(limit)
        if offset > 0:
            sql += " OFFSET ?"
            params.append(offset)

        rows = self._query(sql, params)
        elapsed_ms = (time.perf_counter() - start) * 1000
        log_util.info(
            f"search_class_defs: name={name}, class_fqn={class_fqn}, use_regex={use_regex}, "
            f"limit={limit}, offset={offset}, results={len(rows)}, duration={elapsed_ms:.1f}ms", logger=logger
        )
        return rows

    def get_methods_by_class_fqn(self, class_fqn: str) -> list[dict]:
        start = time.perf_counter()
        sql = """
            SELECT short_name, function_signature, start_line
            FROM function_defs
            WHERE function_fqn LIKE ?
              AND function_fqn NOT LIKE ?
            ORDER BY start_line
        """
        params = [f"{class_fqn}.%", f"{class_fqn}.%.%"]
        rows = self._query(sql, params)
        elapsed_ms = (time.perf_counter() - start) * 1000
        log_util.info(
            f"get_methods_by_class_fqn: class_fqn={class_fqn}, "
            f"results={len(rows)}, duration={elapsed_ms:.1f}ms", logger=logger
        )
        return rows

    def get_classes_by_file(self, file_path: str) -> list[dict]:
        start = time.perf_counter()
        sql = "SELECT * FROM class_defs WHERE file_path = ? ORDER BY start_line"
        rows = self._query(sql, [file_path])
        elapsed_ms = (time.perf_counter() - start) * 1000
        log_util.info(
            f"get_classes_by_file: path={file_path}, "
            f"results={len(rows)}, duration={elapsed_ms:.1f}ms", logger=logger
        )
        return rows

    # ── function_defs 查询 ──────────────────────────────────────

    def search_function_defs(
        self,
        name: str = "",
        function_fqn: str = "",
        function_signature: str = "",
        use_regex: bool = False,
        limit: int = 0,
        offset: int = 0,
    ) -> list[dict]:
        start = time.perf_counter()
        conditions: list[str] = []
        params: list = []

        if function_fqn:
            # 段边界匹配：支持「短类名+函数」(ClassName.method) 按 . 段边界命中完整 FQCN
            # (com.alipay.xxx.ClassName.method)，排除段被截断的误命中
            # (如 A.foo 不命中 A.fooBar / XA.foo)。
            conditions.append("regexp_matches(function_fqn, ?)")
            params.append(segment_boundary_regex(function_fqn))
        elif name:
            if use_regex:
                conditions.append("regexp_matches(short_name, ?)")
                params.append(name)
            else:
                conditions.append("short_name = ?")
                params.append(name)

        where = " AND ".join(conditions) if conditions else "1=1"
        sql = f"SELECT * FROM function_defs WHERE {where}"
        if limit > 0:
            sql += " LIMIT ?"
            params.append(limit)
        if offset > 0:
            sql += " OFFSET ?"
            params.append(offset)

        rows = self._query(sql, params)
        elapsed_ms = (time.perf_counter() - start) * 1000
        log_util.info(
            f"search_function_defs: name={name}, fqn={function_fqn}, sig={function_signature}, "
            f"use_regex={use_regex}, limit={limit}, offset={offset}, results={len(rows)}, duration={elapsed_ms:.1f}ms", logger=logger
        )
        return rows

    def search_function_defs_by_name(
        self, short_name: str, fuzzy_match: bool = False,
    ) -> list[dict]:
        start = time.perf_counter()
        if fuzzy_match:
            sql = "SELECT * FROM function_defs WHERE short_name LIKE ?"
            params: list = [self._like_param(short_name)]
        else:
            sql = "SELECT * FROM function_defs WHERE short_name = ?"
            params = [short_name]

        rows = self._query(sql, params)
        elapsed_ms = (time.perf_counter() - start) * 1000
        log_util.info(
            f"search_function_defs_by_name: name={short_name}, fuzzy={fuzzy_match}, "
            f"results={len(rows)}, duration={elapsed_ms:.1f}ms", logger=logger
        )
        return rows

    def search_function_defs_by_api_form(
        self, api_name: str, form: str, limit: int = 0,
    ) -> list[dict]:
        """按 api_name 形态在 function_defs 表反查，作为 get_api_by_name 的兜底。

        ``form`` 与 ``authscan_service._classify_iface_input`` 返回值对齐：

        - ``"fqcn_method"``  → ``function_fqn = api_name``  (com.x.Util.foo)
        - ``"fqcn_class"``   → ``function_fqn LIKE 'api_name.%'``  (com.x.Util)
        - ``"short_method"`` → ``function_fqn LIKE '%.api_name'``  (Util.foo)
        - ``"short_class"``  → ``function_fqn LIKE '%.api_name.%'`` (Util)
        - ``"regex"``        → ``regexp_matches(function_fqn, api_name)``

        ``form`` 不匹配或 ``api_name`` 为空时返回 ``[]``。
        """
        if not api_name or not form:
            return []
        start = time.perf_counter()
        if form == "fqcn_method":
            sql = "SELECT * FROM function_defs WHERE function_fqn = ?"
            params: list = [api_name]
        elif form == "fqcn_class":
            sql = "SELECT * FROM function_defs WHERE function_fqn LIKE ?"
            params = [f"{api_name}.%"]
        elif form == "short_method":
            sql = "SELECT * FROM function_defs WHERE function_fqn LIKE ?"
            params = [f"%.{api_name}"]
        elif form == "short_class":
            sql = "SELECT * FROM function_defs WHERE function_fqn LIKE ?"
            params = [f"%.{api_name}.%"]
        elif form == "regex":
            sql = "SELECT * FROM function_defs WHERE regexp_matches(function_fqn, ?)"
            params = [api_name]
        else:
            return []
        if limit > 0:
            sql += " LIMIT ?"
            params.append(limit)
        rows = self._query(sql, params)
        elapsed_ms = (time.perf_counter() - start) * 1000
        log_util.info(
            f"search_function_defs_by_api_form: api_name={api_name!r}, form={form}, "
            f"results={len(rows)}, duration={elapsed_ms:.1f}ms", logger=logger
        )
        return rows

    def get_functions_by_file(
        self, file_path: str, fuzzy_match: bool = False,
        limit: int = 0, offset: int = 0,
    ) -> list[dict]:
        start = time.perf_counter()
        if fuzzy_match:
            sql = "SELECT * FROM function_defs WHERE file_path LIKE ? ORDER BY start_line"
            params: list = [self._like_param(file_path)]
        else:
            sql = "SELECT * FROM function_defs WHERE file_path = ? ORDER BY start_line"
            params = [file_path]

        if limit > 0:
            sql += " LIMIT ?"
            params.append(limit)
        if offset > 0:
            sql += " OFFSET ?"
            params.append(offset)

        rows = self._query(sql, params)
        elapsed_ms = (time.perf_counter() - start) * 1000
        log_util.info(
            f"get_functions_by_file: path={file_path}, fuzzy={fuzzy_match}, "
            f"limit={limit}, offset={offset}, results={len(rows)}, duration={elapsed_ms:.1f}ms", logger=logger
        )
        return rows

    def get_functions_for_files(self, file_paths: list[str]) -> dict[str, list[dict]]:
        start = time.perf_counter()
        if not file_paths:
            return {}

        placeholders = ", ".join(["?" for _ in file_paths])
        sql = (
            f"SELECT * FROM function_defs "
            f"WHERE file_path IN ({placeholders}) "
            f"ORDER BY file_path, start_line"
        )
        rows = self._query(sql, file_paths)

        grouped: dict[str, list[dict]] = {}
        for row in rows:
            grouped.setdefault(row["file_path"], []).append(row)

        elapsed_ms = (time.perf_counter() - start) * 1000
        log_util.info(
            f"get_functions_for_files: files={len(file_paths)}, "
            f"total_funcs={len(rows)}, duration={elapsed_ms:.1f}ms", logger=logger
        )
        return grouped

    def get_all_functions(self) -> list[dict]:
        if self._all_functions_cache is not None:
            return self._all_functions_cache

        start = time.perf_counter()
        rows = self._query(
            "SELECT * FROM function_defs ORDER BY file_path, start_line"
        )
        elapsed_ms = (time.perf_counter() - start) * 1000
        log_util.info(
            f"get_all_functions: results={len(rows)}, duration={elapsed_ms:.1f}ms", logger=logger
        )
        self._all_functions_cache = rows
        return rows

    # ── lifecycle ────────────────────────────────────────────────

    def close(self):
        self._all_functions_cache = None
        # 使用共享池时不关闭线程局部连接，避免同线程上 Callgraph 查询仍需要该连接
        if self._read_pool is not None:
            return
        conn = getattr(self._local, "conn", None)
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass
            self._local.conn = None

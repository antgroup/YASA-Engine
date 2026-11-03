"""
UQL（function_defs / class_defs）与 CallGraph（cg_*）共用同一 DuckDB 文件时的只读访问。

DuckDB 连接**非线程安全**：使用 ``threading.local()`` 为每个线程维护独立只读连接，
使 ``DuckDBAnalysisRepository`` 与 ``CallgraphDB`` 在同一线程内复用同一底层连接。

说明：当 ``read_pool`` 为 ``None`` 时，仓储类仍保留各自的 ``threading.local()`` 只读连接，
便于单测或未挂载 MCP 上下文时独立使用；逻辑与池内「每线程一连接」一致，未复用是为避免强耦合。
"""

from __future__ import annotations

import logging
import threading

import duckdb

from yasa_mcp.util import log_util

logger = logging.getLogger(__name__)

# 挂在 YasaMcpContext.__dict__ 上的共享池键（与 callgraph_service / project_service 一致）
SHARED_ANALYSIS_READ_POOL_KEY = "_shared_analysis_read_pool_v1"

class SharedDuckDBReadPool:
    """对单个 DuckDB 文件的线程局部只读连接池（每线程至多一个连接）。"""

    __slots__ = ("_db_path", "_local")

    def __init__(self, db_path: str) -> None:
        self._db_path = db_path
        self._local = threading.local()

    @property
    def db_path(self) -> str:
        return self._db_path

    def _get_connection(self) -> duckdb.DuckDBPyConnection:
        conn = getattr(self._local, "conn", None)
        if conn is None:
            conn = duckdb.connect(self._db_path, read_only=True)
            self._local.conn = conn
        return conn

    def query(self, sql: str, params: list | None = None) -> list[dict]:
        conn = self._get_connection()
        try:
            result = conn.execute(sql, params or [])
            columns = [desc[0] for desc in result.description]
            return [dict(zip(columns, row)) for row in result.fetchall()]
        except Exception as e:
            log_util.error(
                f"SharedDuckDBReadPool query error: sql={sql}, params={params}, error={e}",
                logger=logger,
            )
            raise

    def close_thread_local(self) -> None:
        """关闭当前线程持有的连接（不关闭其他线程）。"""
        conn = getattr(self._local, "conn", None)
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass
            self._local.conn = None

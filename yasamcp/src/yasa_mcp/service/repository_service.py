"""项目分析数据库只读 Repository 的统一获取入口。

业务 Service 不应了解各 ToolContext 的数据库路径、连接池或惰性初始化细节。
本模块统一负责从项目 Context 获取 CodeGraph、CallGraph 与 yasa-scan 查询门面，
使三个分析数据源具备一致的依赖入口和生命周期边界。
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import TYPE_CHECKING, cast

from yasa_mcp.core.context import YasaMcpContext
from yasa_mcp.core.enums import Tool
from yasa_mcp.core.exceptions import InvalidToolError
from yasa_mcp.repository.callgraph_db import CallgraphDB
from yasa_mcp.repository.callgraph_query import CallgraphSqlAccessor
from yasa_mcp.repository.codegraph_repo import CodeGraphAnalysisRepository
from yasa_mcp.repository.shared_analysis_duckdb import (
    SHARED_ANALYSIS_READ_POOL_KEY,
    SharedDuckDBReadPool,
)
from yasa_mcp.util import log_util

logger = logging.getLogger(__name__)

_CODEGRAPH_REPOSITORY_CACHE_KEY = "_codegraph_code_search_repository_v1"
_CALLGRAPH_REPOSITORY_CACHE_KEY = "_callgraph_sql_accessor_v1"


def get_codegraph_repository(
    context: YasaMcpContext,
) -> CodeGraphAnalysisRepository | None:
    """只从已发布的 CodeGraph consumer DB 惰性加载只读 Repository。"""

    def _create() -> CodeGraphAnalysisRepository | None:
        try:
            codegraph_context = context.get_tool_context(Tool.CODEGRAPH)
        except InvalidToolError as exc:
            log_util.error(f"代码索引 repository 不可用: {exc}", logger=logger)
            return None

        # CodeGraph 查询只允许消费已发布的 consumer DB，不能绕过发布流程读取
        # analyzer 的 source DB，否则不同查询入口可能看到不一致的数据版本。
        db_path = getattr(codegraph_context, "consumer_db_path", None)
        if db_path is None:
            log_util.error("代码索引 repository 不可用，consumer_db_path 缺失", logger=logger)
            return None
        consumer_db = Path(db_path)
        if not consumer_db.exists():
            log_util.error(
                f"代码索引 repository 不可用，数据库文件不存在: {consumer_db}",
                logger=logger,
            )
            return None
        return CodeGraphAnalysisRepository(consumer_db)

    # Repository 挂在根 Context 的线程安全缓存中，同一项目只创建一次连接门面。
    return context.get_or_create_cached(_CODEGRAPH_REPOSITORY_CACHE_KEY, _create)


def get_callgraph_repository(
    context: YasaMcpContext,
) -> CallgraphSqlAccessor | None:
    """从 YasaContext 的 CallGraph DB 惰性加载只读 Repository。"""

    def _create() -> CallgraphSqlAccessor | None:
        project_path = context.project_path
        if not project_path:
            return None

        try:
            yasa_context = context.get_tool_context(Tool.YASA)
        except InvalidToolError as exc:
            log_util.warning(f"调用图 repository 不可用: {exc}", logger=logger)
            return None

        db_path = yasa_context.callgraph_duckdb_path
        if db_path is None or not db_path.exists():
            log_util.warning(
                "调用图 repository 不可用，请确认 YasaContext 已完成 build/load 并同步 DuckDB",
                logger=logger,
            )
            return None

        # CallGraph 与共享分析库路径一致时复用 Facade 创建的 read pool；路径不同则
        # 让 CallgraphDB 自己管理连接，禁止把连接池错误挂到另一份数据库上。
        read_pool = _resolve_shared_read_pool(context, db_path)
        callgraph_db = CallgraphDB(str(db_path), read_pool=read_pool)
        return CallgraphSqlAccessor(callgraph_db, project_path)

    return context.get_or_create_cached(_CALLGRAPH_REPOSITORY_CACHE_KEY, _create)


def _resolve_shared_read_pool(
    context: YasaMcpContext,
    db_path: Path,
) -> SharedDuckDBReadPool | None:
    """仅在连接池与目标数据库路径一致时返回共享只读池。"""

    raw_pool = context.__dict__.get(SHARED_ANALYSIS_READ_POOL_KEY)
    if not isinstance(raw_pool, SharedDuckDBReadPool):
        return None
    try:
        if Path(raw_pool.db_path).resolve() == db_path.resolve():
            return raw_pool
    except OSError:
        # 路径解析失败时不能证明两者是同一数据库，安全回退到独立只读连接。
        return None
    return None

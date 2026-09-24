"""请求级 CodeGraph 查询处理器的公共行为。"""

from __future__ import annotations

import logging
import time
from collections.abc import Callable
from typing import TypeVar

from yasa_mcp.repository.query.codegraph.query_models import (
    ClassRecord,
    CodeGraphQueryRepository,
    FunctionRecord,
    PreparedNodeQuery,
)
from yasa_mcp.util import log_util

logger = logging.getLogger(__name__)
RecordT = TypeVar("RecordT", ClassRecord, FunctionRecord)


class CodeGraphAnalysisProcessor:
    """处理器仅存活于单个请求，并在首个命中策略后停止扩大结果。"""

    def __init__(self, repository: CodeGraphQueryRepository):
        self.repository = repository

    def _run_prepared_queries(
        self,
        queries: tuple[PreparedNodeQuery, ...],
        execute: Callable[[PreparedNodeQuery, int, int], list[RecordT]],
        limit: int,
        offset: int,
    ) -> list[RecordT]:
        # 分页仅应用于当前 attempt；命中后停止，避免把不同精度结果拼成不可解释的页。
        for query in queries:
            start = time.perf_counter()
            rows = execute(query, limit, offset)
            log_util.info(
                f"CodeGraph query strategy={query.strategy}, results={len(rows)}, duration={(time.perf_counter() - start) * 1000:.1f}ms",
                logger=logger,
            )
            if rows:
                return rows
        return []

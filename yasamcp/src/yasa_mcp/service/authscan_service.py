"""authscan 接口服务层，get_api_by_name 转发到 APISearchService。"""

from __future__ import annotations

import logging

from yasa_mcp.core.context import YasaMcpContext
from yasa_mcp.service.models import (
    RouterDef,
    YasaMcpResults,
)
from yasa_mcp.util.truncation_util import with_truncation
from yasa_mcp.util.async_util import async_wrap
from yasa_mcp.util.timer_util import timed

logger = logging.getLogger(__name__)


@async_wrap
@timed(logger, "authscan_service", "get_api_by_name")
@with_truncation
def get_api_by_name(
    context: YasaMcpContext,
    api_name: str | list[str],
    use_regex: bool = False,
    max_results: int = 10,
    max_output_tokens: int = 0,
) -> YasaMcpResults[RouterDef]:
    """根据接口名反查其实现函数。委托到 APISearchService。"""
    from yasa_mcp.service.api_search_service import APISearchService
    return APISearchService.get_api_by_name(
        context=context,
        api_name=api_name,
        use_regex=use_regex,
        max_results=max_results,
        max_output_tokens=max_output_tokens,
    )

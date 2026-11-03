"""CLI → service 中转层(替代 server 的 FastMCP 封装)。

server.py 把每个 MCP tool 包装成 FastMCP 注册函数;但 CLI 一次性查询
并不需要 MCP 协议,只是要拿到相同的结果。``YasaToolService`` 以与
server.py 完全一致的参数语义直接调用 service 层,使 search/class/func/
keywords/api/callers/callees/callgraph 子命令**完全不 import fastmcp/mcp
SDK**,只有 `server` 子命令才需要延迟导入 ``yasa_mcp.server``。

项目上下文统一通过 :func:`yasa_mcp.core.context_manager.get_project_context`
解析:命中已加载缓存直接返回;未命中则从项目 ``.yasa`` 缓存 DB 快速加载并
注册进 context_manager;缓存 DB 不存在时抛
:class:`yasa_mcp.core.exceptions.ToolError` 提示用户先执行 init。

返回类型与 server wrapper 一致:原始 ``YasaMcpResults`` 模型。
"""

from __future__ import annotations

from typing import Any

from yasa_mcp.core.context_manager import get_project_context
from yasa_mcp.service import authscan_service, callgraph_service, code_search_service
from yasa_mcp.service.models import (
    GetCallGraphOutput,
    GetClassDefOutput,
    GetFileContentByKeywordOutput,
    GetFunctionDefByFunctionCallOutput,
    GetFunctionDefOutput,
    GetFunctionReferenceOutput,
    QuerySymbolResult,
    RouterDef,
    YasaMcpResults,
)
from yasa_mcp.core.exceptions import ToolError

from yasa_mcp.bin.param_utils import normalize_multivalue

# 多值(list)参数字段:部分 MCP 客户端(Codex)会把这些序列化成 JSON 字符串,
# dispatch 分发前统一用 normalize_multivalue 还原成 list,避免把整串当单值查询返回空。
MULTI_VALUE_FIELDS = frozenset({
    "name", "class_fqn", "keyword", "function_fqn", "file_path", "search", "api_name",
})


class YasaToolService:
    """直接调用 service 层的工具服务,参数语义与 server.py wrapper 对齐。

    每个方法对应一个 CLI 子命令,返回与 fastmcp ``call_tool`` 同源的
    ``YasaMcpResults`` 模型。``project_path`` 由 CLI 透传,经
    :func:`get_project_context` 解析出已加载的上下文后再调用 service。
    """

    async def dispatch(self, tool_name: str, arguments: dict[str, Any]) -> Any:
        """按工具名分发到对应方法;不支持的工具体现抛错。

        ``arguments`` 中的 ``project_path`` 用于解析项目上下文,解析后从
        其余参数中移除,不再透传给 service 层。
        """
        method_name = _TOOL_METHODS.get(tool_name)
        if method_name is None:
            raise ToolError(f"tools_service 不支持工具: {tool_name}")
        kwargs = dict(arguments)
        project_path = kwargs.pop("project_path", None)
        # 多值参数归一化:把 JSON 字符串数组还原成 list,兼容 Codex 等客户端
        for field in MULTI_VALUE_FIELDS:
            if field in kwargs and kwargs[field] is not None:
                kwargs[field] = normalize_multivalue(kwargs[field])
        context = get_project_context(project_path)
        return await getattr(self, method_name)(context, kwargs)

    # ── search_symbol ────────────────────────────────────────────────────
    async def search_symbol(
        self, context: Any, args: dict[str, Any]
    ) -> YasaMcpResults[QuerySymbolResult]:
        context.set_default_task()
        return await code_search_service.search_symbol(
            context,
            search=args.get("search", ""),
            kind=args.get("kind", ""),
            detail_level=args.get("detail_level", "summary"),
            offset=args.get("offset", 0),
            max_results=args.get("max_results", 0),
            max_output_tokens=args.get("max_output_tokens", 0),
        )

    # ── get_class_by_name ────────────────────────────────────────────────
    async def get_class_by_name(
        self, context: Any, args: dict[str, Any]
    ) -> YasaMcpResults[GetClassDefOutput]:
        return await code_search_service.get_class_by_name(
            context,
            name=args.get("name", ""),
            class_fqn=args.get("class_fqn", ""),
            use_regex=args.get("use_regex", False),
            include_methods=args.get("include_methods", False),
            offset=args.get("offset", 0),
            max_results=args.get("max_results", 10),
            max_output_tokens=args.get("max_output_tokens", 0),
        )

    # ── get_function (三路互斥路由) ──────────────────────────────────────
    async def get_function(
        self, context: Any, args: dict[str, Any]
    ) -> YasaMcpResults[GetFunctionDefOutput]:
        name = args.get("name", "")
        function_fqn = args.get("function_fqn", "")
        file_path = args.get("file_path", "")
        code = args.get("code", "")
        if name or function_fqn:
            return await code_search_service.get_function_by_name(
                context,
                name=name,
                function_fqn=function_fqn,
                use_regex=args.get("use_regex", False),
                offset=args.get("offset", 0),
                max_results=args.get("max_results", 10),
                max_output_tokens=args.get("max_output_tokens", 0),
            )
        if file_path:
            return await code_search_service.get_function_by_file(
                context,
                file_path=file_path,
                use_regex=args.get("use_regex", False),
                detail_level=args.get("detail_level", "summary"),
                offset=args.get("offset", 0),
                max_results=args.get("max_results", 0),
                max_output_tokens=args.get("max_output_tokens", 0),
            )
        if code:
            return await code_search_service.get_function_by_code(
                context,
                code_snippet=code,
                use_regex=args.get("use_regex", False),
                offset=args.get("offset", 0),
                max_results=args.get("max_results", 10),
                max_output_tokens=args.get("max_output_tokens", 0),
            )
        raise ToolError(
            "get_function 需要至少提供 name、function_fqn、file_path 或 code 中的一个参数"
        )

    # ── get_file_by_keyword ─────────────────────────────────────────────
    async def get_file_by_keyword(
        self, context: Any, args: dict[str, Any]
    ) -> YasaMcpResults[GetFileContentByKeywordOutput]:
        return await code_search_service.get_file_by_keyword(
            context,
            keyword=args.get("keyword", ""),
            use_regex=args.get("use_regex", False),
            detail_level=args.get("detail_level", "summary"),
            offset=args.get("offset", 0),
            max_results=args.get("max_results", 10),
            max_output_tokens=args.get("max_output_tokens", 0),
        )

    # ── get_api_by_name ─────────────────────────────────────────────────
    async def get_api_by_name(
        self, context: Any, args: dict[str, Any]
    ) -> YasaMcpResults[RouterDef]:
        return await authscan_service.get_api_by_name(
            context=context,
            api_name=args.get("api_name", ""),
            use_regex=args.get("use_regex", False),
            max_results=args.get("max_results", 0),
            max_output_tokens=args.get("max_output_tokens", 0),
        )

    # ── get_reference_by_function (callers) ─────────────────────────────
    async def get_reference_by_function(
        self, context: Any, args: dict[str, Any]
    ) -> YasaMcpResults[GetFunctionReferenceOutput]:
        return await callgraph_service.get_reference_by_function(
            context=context,
            name=args.get("name", ""),
            function_fqn=args.get("function_fqn", ""),
            function_signature=args.get("function_signature", ""),
            file_path=args.get("file_path", ""),
            line=args.get("line", 0),
            use_regex=args.get("use_regex", False),
            max_results=args.get("max_results", 10),
            offset=args.get("offset", 0),
            max_output_tokens=args.get("max_output_tokens", 0),
        )

    # ── get_function_by_call (callees) ──────────────────────────────────
    async def get_function_by_call(
        self, context: Any, args: dict[str, Any]
    ) -> YasaMcpResults[GetFunctionDefByFunctionCallOutput]:
        # server wrapper 默认 fuzzy_match=True,service 签名默认 False,此处对齐 wrapper
        return await callgraph_service.get_function_by_call(
            context=context,
            function_call=args.get("function_call", ""),
            file_path=args.get("file_path", ""),
            line=args.get("line", 0),
            fuzzy_match=args.get("fuzzy_match", True),
            max_results=args.get("max_results", 10),
            max_output_tokens=args.get("max_output_tokens", 0),
            extra=args.get("extra", {}),
        )

    # ── get_call_graph (callgraph) ──────────────────────────────────────
    async def get_call_graph(
        self, context: Any, args: dict[str, Any]
    ) -> YasaMcpResults[GetCallGraphOutput]:
        return await callgraph_service.get_call_graph(
            context=context,
            name=args.get("name", ""),
            function_fqn=args.get("function_fqn", ""),
            function_signature=args.get("function_signature", ""),
            file_path=args.get("file_path", ""),
            line=args.get("line", 0),
            depth=args.get("depth", 3),
            use_regex=args.get("use_regex", False),
            detail_level=args.get("detail_level", "summary"),
            max_callees_per_node=args.get("max_callees_per_node", 3),
            exclude_undefined_function_call=args.get("exclude_undefined_function_call", True),
            max_output_tokens=args.get("max_output_tokens", 0),
        )


_TOOL_METHODS: dict[str, str] = {
    "search_symbol": "search_symbol",
    "get_class_by_name": "get_class_by_name",
    "get_function": "get_function",
    "get_file_by_keyword": "get_file_by_keyword",
    "get_api_by_name": "get_api_by_name",
    "get_reference_by_function": "get_reference_by_function",
    "get_function_by_call": "get_function_by_call",
    "get_call_graph": "get_call_graph",
}


_tool_service = YasaToolService()


async def dispatch(tool_name: str, arguments: dict[str, Any]) -> Any:
    """模块级便捷入口,等价于 ``YasaToolService().dispatch``。"""
    return await _tool_service.dispatch(tool_name, arguments)

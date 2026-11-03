import logging
from logging import Logger
from pathlib import Path
from typing import Annotated

from fastmcp import FastMCP, Context
import click
from fastmcp.exceptions import ToolError
from pydantic import Field

from yasa_mcp.core import exceptions
from yasa_mcp.core.cache_manager import set_project_cache_dir
from yasa_mcp.core.context_manager import get_project_context
from yasa_mcp.config import log_config
from yasa_mcp.config import global_config
from yasa_mcp.service import code_search_service, callgraph_service, authscan_service
from yasa_mcp.service.models import (
    YasaMcpResults,
    GetClassDefOutput,
    GetFunctionDefOutput,
    GetFileContentByKeywordOutput,
    GetCallGraphOutput,
    GetFunctionDefByFunctionCallOutput,
    GetFunctionReferenceOutput,
    ImportResult,
    RouterDef,
    QuerySymbolResult,
)
from yasa_mcp.util.path_util import ensure_path
from yasa_mcp.util import log_util

mcp = FastMCP("Yasa MCP")
logger: Logger | None = None

# 导入包级别的 version
from yasa_mcp import __version__
from yasa_mcp.bin.param_utils import normalize_multivalue




@mcp.tool()
async def get_class_by_name(
    ctx: Context,
    project_path: Annotated[str, Field(description="要分析的项目路径（必填）；若该目录下尚未生成分析结果，会提示先通过 yasamcp init 生成分析结果")],
    name: Annotated[str | list[str], Field(description="类名、类名关键字或正则。支持单值或多候选，传多个时一次性查询多个类的结果。例：“Customer” 或 [“Customer”,“Order”]")] = "",
    class_fqn: Annotated[str | list[str], Field(description="类全限定名，可为空。支持单值或多候选，传多个时一次性查询多个类的结果。例：“com.example.Customer” 或 [“com.example.A”,“com.example.B”]")] = "",
    use_regex: Annotated[bool, Field(description="是否将 name/class_fqn 按正则匹配，默认 false")] = False,
    include_methods: Annotated[bool, Field(description="是否返回类下方法列表，默认 false")] = False,
    offset: Annotated[int, Field(description="分页偏移量，默认 0")] = 0,
    max_results: Annotated[int, Field(description="最多返回结果数，0 不限制")] = 10,
    max_output_tokens: Annotated[int, Field(description="输出 token 截断上限，0 不截断")] = 0,
) -> YasaMcpResults[GetClassDefOutput]:
    """
    按类名或类全限定名查询类定义，可选返回类方法列表。

    输入参数:
        - name: 要查找的类名；可填一个名称，也可一次提供多个候选，一次性查询多个类的结果。例：“Customer” 或 [“Customer”,“Order”]
        - class_fqn: 类的完整限定名；可填一个或多个候选，一次性查询多个类的结果。
        - use_regex: 是否将 name / class_fqn 按正则表达式匹配。可能输入: false, true
        - include_methods: 是否返回类下方法列表。可能输入: false, true
        - offset: 分页偏移量。可能输入: 0, 20
        - max_results: 最多返回的结果数量，0 表示不限制。可能输入: 10, 0
        - max_output_tokens: 输出 token 截断上限，0 表示不截断
    """
    name = normalize_multivalue(name)
    class_fqn = normalize_multivalue(class_fqn)
    context = get_project_context(project_path)
    context.set_default_task()
    return await code_search_service.get_class_by_name(
        context,
        name=name,
        class_fqn=class_fqn,
        use_regex=use_regex,
        include_methods=include_methods,
        offset=offset,
        max_results=max_results,
        max_output_tokens=max_output_tokens,
    )

@mcp.tool()
async def get_file_by_keyword(
    ctx: Context,
    project_path: Annotated[str, Field(description="要分析的项目路径（必填）；若该目录下尚未生成分析结果，会提示先通过 yasamcp init 生成分析结果")],
    keyword: Annotated[str | list[str], Field(description="文件内容关键字。支持单值或多候选，传多个时一次性查询多个关键字命中的文件。例：“Logger” 或 [“Logger”,“Timer”]")] = "",
    use_regex: Annotated[bool, Field(description="是否使用正则匹配，默认 false")] = False,
    detail_level: Annotated[str, Field(description="输出详细程度：summary 返回匹配片段上下文，full 返回完整文件内容，默认 summary")] = "summary",
    offset: Annotated[int, Field(description="分页偏移量，默认 0")] = 0,
    max_results: Annotated[int, Field(description="最多返回的文件数量，0 不限制")] = 10,
    max_output_tokens: Annotated[int, Field(description="输出 token 截断上限，0 不截断")] = 0,
) -> YasaMcpResults[GetFileContentByKeywordOutput]:
    """
    根据关键字搜索文件内容
    输入:
        - keyword: 要搜索的关键字；可填一个或多个候选，一次性查询多个关键字命中的文件。例：“Logger” 或 [“Logger”,“Timer”]
        - use_regex: 是否使用正则匹配，默认 false
        - detail_level: 详细程度，"summary" 返回匹配片段上下文，"full" 返回完整文件内容，默认 "summary"
        - offset: 分页偏移量，默认 0
        - max_results: 最多返回的文件数量，默认10，设为0表示不限制
        - max_output_tokens: 输出 token 截断上限，0 表示不截断
    """
    keyword = normalize_multivalue(keyword)
    context = get_project_context(project_path)
    context.set_default_task()
    return await code_search_service.get_file_by_keyword(
        context,
        keyword=keyword,
        use_regex=use_regex,
        detail_level=detail_level,
        offset=offset,
        max_results=max_results,
        max_output_tokens=max_output_tokens,
    )

@mcp.tool()
async def get_function(
    ctx: Context,
    project_path: Annotated[str, Field(description="要分析的项目路径（必填）；若该目录下尚未生成分析结果，会提示先通过 yasamcp init 生成分析结果")],
    name: Annotated[str | list[str], Field(description="函数短名、函数名关键字或正则。支持单值或多候选，传多个时一次性查询多个函数的结果。例：“handleRequest” 或 [“handleRequest”,“doPost”]")] = "",
    function_fqn: Annotated[str | list[str], Field(description="函数全限定名，可为空。支持单值或多候选，传多个时一次性查询多个函数的结果。例：“com.foo.Service.handle” 或 [“com.foo.A.handle”,“com.foo.B.run”]")] = "",
    file_path: Annotated[str | list[str], Field(description="项目相对文件路径，可为空。支持单值或多候选，传多个时一次性查询多个文件中的函数。例：“src/Foo.java” 或 [“src/Foo.java”,“src/Bar.java”]")] = "",
    code: Annotated[str, Field(description="代码片段；传入走按代码片段定位函数路由")] = "",
    function_signature: Annotated[str, Field(description="函数签名提示，不消费，仅向后兼容")] = "",
    use_regex: Annotated[bool, Field(description="是否将 name/file_path/code 按正则匹配，默认 false")] = False,
    detail_level: Annotated[str, Field(description="返回摘要或完整函数体：summary/full，默认 summary")] = "summary",
    offset: Annotated[int, Field(description="分页偏移量，默认 0")] = 0,
    max_results: Annotated[int, Field(description="最多返回结果数，0 不限制")] = 10,
    max_output_tokens: Annotated[int, Field(description="输出 token 截断上限，0 不截断")] = 0,
) -> YasaMcpResults[GetFunctionDefOutput]:
    """查询函数定义。按入参类型互斥路由：传 name 或 function_fqn 按函数名查；传 file_path 按文件查；传 code 按代码片段定位函数。name、function_fqn、file_path 均支持单值或多候选，传多个时一次性查询多个结果，返回所有在当前仓库可找到的函数定义。"""
    context = get_project_context(project_path)
    context.set_default_task()
    name = normalize_multivalue(name)
    function_fqn = normalize_multivalue(function_fqn)
    file_path = normalize_multivalue(file_path)

    # 优先级：name/function_fqn > file_path > code
    if name or function_fqn:
        return await code_search_service.get_function_by_name(
            context,
            name=name,
            function_fqn=function_fqn,
            use_regex=use_regex,
            offset=offset,
            max_results=max_results,
            max_output_tokens=max_output_tokens,
        )
    if file_path:
        return await code_search_service.get_function_by_file(
            context,
            file_path=file_path,
            use_regex=use_regex,
            detail_level=detail_level,
            offset=offset,
            max_results=max_results,
            max_output_tokens=max_output_tokens,
        )
    if code:
        return await code_search_service.get_function_by_code(
            context,
            code_snippet=code,
            use_regex=use_regex,
            offset=offset,
            max_results=max_results,
            max_output_tokens=max_output_tokens,
        )
    raise ToolError("get_function 需要至少提供 name、function_fqn、file_path 或 code 中的一个参数")


@mcp.tool()
async def search_symbol(
    ctx: Context,
    project_path: Annotated[str, Field(description="要分析的项目路径（必填）；若该目录下尚未生成分析结果，会提示先通过 yasamcp init 生成分析结果")],
    search: Annotated[str | list[str], Field(description="搜索词。支持单值或多候选，传多个时一次性查询多个词的符号。例：“AgentFactory” 或 [“AgentFactory”,“OrderService”]")] = "",
    kind: Annotated[str, Field(description="结果类型过滤：function/class/interface/file；空字符串返回所有命中")] = "",
    detail_level: Annotated[str, Field(description="输出详细程度：summary 仅元信息，full 含源码片段，默认 summary")] = "summary",
    offset: Annotated[int, Field(description="分页偏移量，默认 0")] = 0,
    max_results: Annotated[int, Field(description="最多返回结果数，0 不限制")] = 0,
    max_output_tokens: Annotated[int, Field(description="输出 token 截断上限，0 不截断")] = 0,
) -> YasaMcpResults[QuerySymbolResult]:
    """统一符号搜索：根据搜索词返回仓库中相关的符号。

    按 kind 决定结果类型：function 返回函数实现、class 返回类实现、interface
    同时返回接口声明及其实现、file 返回文件内容；kind 为空时返回所有命中符号。
    search 支持单个词或多个候选词；传多个时尽量为每一个搜索词返回
    对应的符号搜索结果，需仓库已完成静态分析缓存。detail_level 为 summary 仅返回
    元信息，full 同时返回源码片段。

    限定符分隔符语义：``.`` 与 ``::`` 含义不同。``a.b.c.A.func`` 会被视为一个整体
    token 做前缀搜索（通常无法命中，因为类型与成员边界以 ``::`` 存储）；
    ``a.b.c.A::func`` 会被拆分为 ``a.b.c.A*`` 和 ``func*`` 两段前缀搜索，能分别匹配
    包路径与成员名。跨包和方法/成员搜索时建议用 ``::`` 分隔 owner 与 member。
    """
    import time as _t
    import logging as _lg
    search = normalize_multivalue(search)
    _g0 = _t.perf_counter()
    context = get_project_context(project_path)
    _g1 = _t.perf_counter()
    context.set_default_task()
    _g2 = _t.perf_counter()
    _r = await code_search_service.search_symbol(
        context,
        search=search,
        kind=kind,
        detail_level=detail_level,
        offset=offset,
        max_results=max_results,
        max_output_tokens=max_output_tokens,
    )
    _g3 = _t.perf_counter()
    _lg.getLogger("yasa_mcp.server").info(
        "[SERVER-TIMING] search_symbol get_ctx=%.2fms set_task=%.2fms service=%.2fms total=%.2fms",
        (_g1-_g0)*1000, (_g2-_g1)*1000, (_g3-_g2)*1000, (_g3-_g0)*1000,
    )
    return _r


@mcp.tool()
async def get_call_graph(
    ctx: Context,
    project_path: Annotated[str, Field(description="要分析的项目路径（必填）；若该目录下尚未生成分析结果，会提示先通过 yasamcp init 生成分析结果")],
    name: Annotated[str, Field(description="函数名，支持短名或全限定名")] = "",
    function_fqn: Annotated[str, Field(description="函数全限定名，非空时优先精确匹配")] = "",
    function_signature: Annotated[str, Field(description="函数签名，例如 main(String[])，非必填")] = "",
    file_path: Annotated[str, Field(description="文件路径，使用相对路径")] = "",
    line: Annotated[int, Field(description="行号")] = 0,
    depth: Annotated[int, Field(description="调用链展开深度，默认 3")] = 3,
    use_regex: Annotated[bool, Field(description="是否使用正则匹配，默认 false")] = False,
    detail_level: Annotated[str, Field(description="详细程度：summary/full，默认 summary")] = "summary",
    max_callees_per_node: Annotated[int, Field(description="每个节点最多返回的被调用函数数量，0 或负数不限制，默认 3")] = 3,
    exclude_undefined_function_call: Annotated[bool, Field(description="是否排除外部未定义函数调用，默认 true")] = True,
    max_output_tokens: Annotated[int, Field(description="输出 token 截断上限，0 不截断")] = 0,
) -> YasaMcpResults[GetCallGraphOutput]:
    """
    获取函数的调用图
    输入:
        - name: 函数名（必填），支持短名或全限定名
        - function_fqn: 函数的全限定名（选填），非空时优先精确匹配
        - function_signature: 函数签名，例如：main(String[])，非必填
        - file_path: 文件路径，使用相对路径，非必填
        - line: 行号，非必填
        - use_regex: 是否使用正则匹配，默认 false
        - detail_level: 详细程度，summary / full，默认 summary
        - max_callees_per_node: 每个节点最多返回的被调用函数数量，0或负数表示不限制，默认3
        - exclude_undefined_function_call: 是否排除外部未定义函数调用，默认 true
        - max_output_tokens: 输出 token 截断上限，0 表示不截断
    """
    context = get_project_context(project_path)
    context.set_default_task()

    return await callgraph_service.get_call_graph(
        context=context,
        name=name,
        function_fqn=function_fqn,
        function_signature=function_signature,
        file_path=file_path,
        line=line,
        depth=depth,
        use_regex=use_regex,
        detail_level=detail_level,
        max_callees_per_node=max_callees_per_node,
        exclude_undefined_function_call=exclude_undefined_function_call,
        max_output_tokens=max_output_tokens,
    )


@mcp.tool()
async def get_function_by_call(
    ctx: Context,
    project_path: Annotated[str, Field(description="要分析的项目路径（必填）；若该目录下尚未生成分析结果，会提示先通过 yasamcp init 生成分析结果")],
    function_call: Annotated[str, Field(description="调用点的代码信息")] = "",
    file_path: Annotated[str, Field(description="调用点所在文件路径，使用相对路径")] = "",
    line: Annotated[int, Field(description="调用点行号")] = 0,
    fuzzy_match: Annotated[bool, Field(description="是否模糊匹配，默认 true")] = True,
    max_results: Annotated[int, Field(description="最大返回结果数，0 不限制")] = 10,
    max_output_tokens: Annotated[int, Field(description="输出 token 截断上限，0 不截断")] = 0,
    extra: Annotated[dict, Field(description="业务方扩展参数，默认空")] = {},
) -> YasaMcpResults[GetFunctionDefByFunctionCallOutput]:
    """
    根据调用点信息获取被调用函数的定义。
    输入:
        - function_call: 调用点的代码信息（必填）
        - file_path: 调用点所在文件路径,使用相对路径（可选）
        - line: 调用点行号（可选）
        - fuzzy_match: 是否模糊匹配，默认为 True
        - max_results: 最大返回结果数，默认为 10，0 表示不限制
        - max_output_tokens: 输出 token 截断上限，0 表示不截断
        - extra: 业务方扩展参数
    """
    context = get_project_context(project_path)
    context.set_default_task()

    return await callgraph_service.get_function_by_call(
        context=context,
        function_call=function_call,
        file_path=file_path,
        line=line,
        fuzzy_match=fuzzy_match,
        max_results=max_results,
        max_output_tokens=max_output_tokens,
        extra=extra,
    )


@mcp.tool()
async def get_reference_by_function(
    ctx: Context,
    project_path: Annotated[str, Field(description="要分析的项目路径（必填）；若该目录下尚未生成分析结果，会提示先通过 yasamcp init 生成分析结果")],
    name: Annotated[str, Field(description="函数名，支持短名或全限定名")] = "",
    function_fqn: Annotated[str, Field(description="函数全限定名，非空时优先精确匹配")] = "",
    function_signature: Annotated[str, Field(description="函数签名，例如 main(String[])，非必填")] = "",
    file_path: Annotated[str, Field(description="调用点所在文件路径，使用相对路径")] = "",
    line: Annotated[int, Field(description="调用点行号")] = 0,
    use_regex: Annotated[bool, Field(description="是否使用正则匹配，默认 false")] = False,
    offset: Annotated[int, Field(description="分页偏移量，默认 0")] = 0,
    max_results: Annotated[int, Field(description="最大返回结果数，0 不限制")] = 10,
    max_output_tokens: Annotated[int, Field(description="输出 token 截断上限，0 不截断")] = 0,
) -> YasaMcpResults[GetFunctionReferenceOutput]:
    """
    获取函数被调用的位置（谁在什么位置调用了它）。
    输入:
        - name: 函数名（必填），支持短名或全限定名
        - function_fqn: 函数的全限定名（选填），非空时优先精确匹配
        - function_signature: 函数签名，例如：main(String[])，非必填
        - file_path: 调用点所在文件路径，非必填
        - line: 调用点行号，非必填
        - use_regex: 是否使用正则匹配，默认 false
        - offset: 分页偏移量，默认 0
        - max_results: 最大返回结果数，默认为 10，0 表示不限制
        - max_output_tokens: 输出 token 截断上限，0 表示不截断
    """
    context = get_project_context(project_path)
    context.set_default_task()

    return await callgraph_service.get_reference_by_function(
        context=context,
        name=name,
        function_fqn=function_fqn,
        function_signature=function_signature,
        file_path=file_path,
        line=line,
        use_regex=use_regex,
        max_results=max_results,
        offset=offset,
        max_output_tokens=max_output_tokens,
    )


@mcp.tool()
async def get_import_by_file(
    ctx: Context,
    project_path: Annotated[str, Field(description="要分析的项目路径（必填）；若该目录下尚未生成分析结果，会提示先通过 yasamcp init 生成分析结果")],
    file_path: Annotated[str, Field(description="文件路径，使用相对路径")] = "",
    fuzzy_match: Annotated[bool, Field(description="是否模糊匹配路径，默认 true")] = True,
    exclude_external_import: Annotated[bool, Field(description="是否排除外部依赖导入，默认 false")] = False,
    max_results: Annotated[int, Field(description="最多返回结果数，0 不限制")] = 0,
    max_output_tokens: Annotated[int, Field(description="输出 token 截断上限，0 不截断")] = 0,
) -> YasaMcpResults[ImportResult]:
    """查询 CodeGraph 为指定文件记录的 import/include/use/require 语句。
    当前返回导入模块及源码行号，不额外解析目标文件。

    :param file_path: 相对于项目根目录的文件路径，如 "myapp/views.py"
    :param fuzzy_match: 是否模糊匹配路径，默认为True
    :param exclude_external_import: 仅保留可证明为项目内的依赖；nodes 单表当前无法证明时返回空
    :param max_results: 最多返回的依赖条目数量，默认0表示不限制
    :param max_output_tokens: 输出 token 截断上限，0 表示不截断
    """
    context = get_project_context(project_path)
    context.set_default_task()
    return await code_search_service.get_import_by_file(
        context=context,
        file_path=file_path,
        fuzzy_match=fuzzy_match,
        exclude_external_import=exclude_external_import,
        max_results=max_results,
        max_output_tokens=max_output_tokens,
    )


@mcp.tool()
async def get_api_by_name(
    ctx: Context,
    project_path: Annotated[str, Field(description="要分析的项目路径（必填）；若该目录下尚未生成分析结果，会提示先通过 yasamcp init 生成分析结果")],
    api_name: Annotated[str | list[str], Field(description="接口名、HTTP 路径或函数名。支持单值或多候选，传多个时一次性查询多个接口的实现。例：“/api/order/query” 或 [“/api/order”,“/api/refund”]")] = "",
    use_regex: Annotated[bool, Field(description="True 时按正则匹配函数名，默认 false")] = False,
    max_results: Annotated[int, Field(description="最多返回条目数，0 不限制")] = 0,
    max_output_tokens: Annotated[int, Field(description="输出 token 截断上限，0 不截断")] = 0,
) -> YasaMcpResults[RouterDef]:
    """根据接口名反查其实现函数（支持 Java / Python）。

    支持以下 ``api_name`` 形态：

    1. 全限定类名+方法：``com.foo.UserServiceImpl.query``
    2. 短类名+方法：``UserService.query``、``FileController.upload``
    3. 短类名：``UserService``

    查询策略：优先将输入解释为接口实现，返回实现类的函数定义；
    未命中时降级为普通函数查找。显式传 ``use_regex=True`` 时按正则匹配函数名。

    :param api_name:          接口名或函数名；可填一个或多个候选，一次性查询多个接口的实现。例：“/api/order/query” 或 [“/api/order”,“/api/refund”]
    :param use_regex:         True 时按正则匹配函数名，默认 False
    :param max_results:       最多返回条目数；默认 0 不限制
    :param max_output_tokens: 输出 token 截断上限；默认 0 不截断
    """
    api_name = normalize_multivalue(api_name)
    context = get_project_context(project_path)
    context.set_default_task()

    return await authscan_service.get_api_by_name(
        context=context,
        api_name=api_name,
        use_regex=use_regex,
        max_results=max_results,
        max_output_tokens=max_output_tokens,
    )



# ---------------------------------------------------------------------------------
# MCP Server Entry Point
# ---------------------------------------------------------------------------------


@click.command(context_settings={"help_option_names": ["-h", "--help"]})
@click.version_option(
    __version__,
    "-v",
    "--version",
    help="Show version and exit.",
)
@click.option(
    "-t",
    "--transport",
    type=click.Choice(["stdio", "sse", "streamable-http"]),
    default="stdio",
    envvar="YASA_MCP_TRANSPORT",
    help="Transport protocol: stdio (default for CC/Codex spawn), sse, or streamable-http",
)
@click.option(
    "-c",
    "--cache",
    type=click.Path(dir_okay=True, resolve_path=True),
    default="./cache",
    envvar="YASA_MCP_CACHE_DIR",
    help="Path to the global cache directory (used when --project is not set)",
)
@click.option(
    "-b",
    "--bin",
    type=click.Path(dir_okay=True, resolve_path=True),
    default="./bin",
    envvar="YASA_MCP_BIN_DIR",
    help="Path to the native binary directory (<bin>/<platform>/bin/...)",
)
@click.option(
    "-l",
    "--log",
    type=click.Path(dir_okay=True, resolve_path=True),
    default="./logs",
    envvar="YASA_MCP_LOG_DIR",
    help="Path to the log directory",
)
@click.option(
    "-p",
    "--project",
    type=click.Path(dir_okay=True, resolve_path=True),
    default=None,
    envvar="YASA_MCP_PROJECT",
    help="Project path; when set, cache goes to <project>/.yasa/",
)
@click.option(
    "--host",
    default="0.0.0.0",
    envvar="YASA_MCP_HOST",
    help="Host for sse/streamable-http transport",
)
@click.option(
    "--port",
    type=int,
    default=8000,
    envvar="YASA_MCP_PORT",
    help="Port for sse/streamable-http transport",
)
def main(transport: str, cache: str, bin: str, log: str, project: str | None, host: str, port: int) -> None:
    """Entry point for the MCP server and CLI.

    Supports stdio (default), sse, and streamable-http transports.
    Use -p/--project to bind to a specific project (cache goes to <project>/.yasa/).
    """
    # 配置缓存文件夹
    global_config.cache_path = ensure_path(Path(cache))

    # 配置日志文件夹
    global_config.log_path = ensure_path(Path(log))

    # 初始化日志
    log_config.setup_logger()
    global logger
    logger = logging.getLogger(__name__)

    # 配置二进制：-b 覆盖时走 resolver(init/server 才有的重路径)，否则读持久化建 runtime
    from yasa_mcp.core.binary_manager import BinaryManager
    if bin and bin != str(Path.home() / ".yasamcp"):
        BinaryManager.configure(bin)
    else:
        BinaryManager.load_from_persisted()

    # --project 模式：缓存落 <project>/.yasa/
    if project:
        project_cache_dir = Path(project) / ".yasa"
        set_project_cache_dir(project_cache_dir)
        log_util.info(f"Project mode: cache dir = {project_cache_dir}", logger=logger)
    else:
        set_project_cache_dir(None)

    if transport == "stdio":
        mcp.run(transport="stdio")
    elif transport == "streamable-http":
        mcp.run(transport="streamable-http", host=host, port=port)
    elif transport == "sse":
        mcp.run(transport="sse", host=host, port=port)
    else:
        raise exceptions.InvalidParameterError(f"Invalid transport: {transport}")


if __name__ == "__main__":
    main()

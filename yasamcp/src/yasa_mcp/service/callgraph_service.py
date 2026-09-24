"""
函数调用图 Service

基于 CallGraph DuckDB（cg_nodes / cg_call_sites / cg_edges）+ UQL DuckDB（function_defs）查询，
将原先全量内存遍历改为索引 SQL + 必要的文件 IO（读取调用点/函数体源码）。

对外接口：
- get_call_graph: 按函数定位根节点后展开被调函数树。
  - ``callee_expansion=bfs``（默认）：逐层批量查询出边，明确 depth / max_callees_per_node 语义。
  - ``callee_expansion=python_dfs``：兼容旧应用层 DFS，逐层 ``get_outgoing_edges``，环上仍生成 ``has_cycle=True`` 的 Callee。
  - ``callee_expansion=sql_recursive``：兼容旧 ``WITH RECURSIVE`` 拉平边集再在 Python 组装树；环边在 SQL 侧剪枝，不产生 ``has_cycle`` 占位。
- get_reference_by_function: 按 target_node_id 查入边（SQL JOIN call_sites）。
- get_function_by_call: 预筛时可用 ripgrep + SQL IN(文件集合) 缩小边集。

说明：三种展开逻辑都封装在 ``yasa_mcp.callgraph.traversor.CallGraphTraversor`` 中，service 只负责根节点定位和结果拼接。
"""

from __future__ import annotations

import logging
import time
from pathlib import Path
from typing import Literal

from yasa_mcp.core.cache_status import CacheStatusMask
from yasa_mcp.core.context import YasaMcpContext
from yasa_mcp.core.enums import Tool, Language
from yasa_mcp.callgraph.traversor import CallGraphTraversor
from yasa_mcp.repository.callgraph_query import CallgraphSqlAccessor
from yasa_mcp.service import models
from yasa_mcp.service.models import YasaMcpResults
from yasa_mcp.service.repository_service import get_callgraph_repository
from yasa_mcp.util.truncation_util import with_truncation
from yasa_mcp.util import file_util, log_util
from yasa_mcp.util.async_util import async_wrap
from yasa_mcp.util.function_call_match_util import (
    build_multiline_call_pattern,
    build_multiline_prefix_pattern,
    callsite_content_matches,
    display_function_def_for_call,
)
from yasa_mcp.util.params_validator_util import ParamsValidator
from yasa_mcp.util.timer_util import timed

from yasa_mcp.service.realtime.realtime_service import (
    realtime_get_call_graph,
    realtime_get_reference_by_function,
    realtime_get_function_by_call,
)

logger = logging.getLogger(__name__)

MAX_CALLSITE_CANDIDATES = 10
CallsiteCandidate = tuple[str, int, str]


def _normalize_callsite_path(project_path: Path, file_path: str | Path) -> str:
    """将调用点路径统一为阶段 2 使用的 POSIX 路径。"""
    candidate_path = Path(file_path)
    if candidate_path.is_absolute():
        try:
            candidate_path = candidate_path.relative_to(project_path)
        except ValueError:
            # 仓库外绝对路径沿用历史语义，不强行改写成错误的相对路径。
            pass
    return candidate_path.as_posix()


def _locate_callsite_candidates(
    context: YasaMcpContext,
    project_path: Path,
    function_call: str,
    file_path: str = "",
    line: int = 0,
) -> list[CallsiteCandidate]:
    """执行 ``get_function_by_call`` 阶段 1，定位候选调用点。

    输入是调用文本及可选的文件、行号，输出固定为阶段 2 已有消费结构
    ``(POSIX 路径, 行号, 命中文本)`` 的有序列表。文件和正行号同时存在时走
    ``exact_location`` 直达：不获取 RIPGREP 工具，content 留空，由阶段 2
    按调用图位置读取真实源码。定位参数不完整时走兼容路径，先搜索完整调用
    表达式，未命中再搜索调用前缀；提供文件时将搜索范围限定到该文件，只有
    行号时仍在全仓搜索后做软收敛。该函数只负责搜索、路径规范化、去重与
    截断，不访问调用图，也不改变阶段 2 及后续的查边、消歧和结果组装边界。
    """
    started_at = time.perf_counter()

    # 完整的用户位置是阶段 1 最强的定位依据，因此直接返回且不获取 RIPGREP；
    # 阶段 2 会根据调用图位置读取真实源码。
    if file_path and line > 0:
        candidates = [(_normalize_callsite_path(project_path, file_path), line, "")]
        log_util.info(
            "get_function_by_call candidate_source=user_input "
            f"candidate_count={len(candidates)} "
            f"duration_ms={(time.perf_counter() - started_at) * 1000:.1f}",
            logger=logger,
        )
        return candidates

    # file_path 的公开契约是项目相对路径。以目标文件的父目录作为搜索根，
    # 再用 basename 精确限制文件，既避免 rg 单文件模式省略文件名，也不扫描
    # 其他文件；未提供时保持全仓搜索。
    if file_path:
        relative_file = Path(file_path)
        search_path = project_path / relative_file.parent
        search_kwargs = {"include_globs": [relative_file.name]}
    else:
        search_path = project_path
        search_kwargs = {}

    # 兼容路径优先保留原有的完整调用搜索，仅在没有候选时搜索调用前缀。
    file_line_results = []
    try:
        ripgrep_tool = context.get_tool(Tool.RIPGREP)
        multiline_pattern = build_multiline_call_pattern(function_call)
        if multiline_pattern:
            file_line_results = ripgrep_tool.search_keyword_with_line(
                search_path, multiline_pattern, use_regex=True, **search_kwargs
            )
        if not file_line_results:
            prefix_pattern = build_multiline_prefix_pattern(function_call)
            if prefix_pattern:
                file_line_results = ripgrep_tool.search_keyword_with_line(
                    search_path, prefix_pattern, use_regex=True, **search_kwargs
                )
    except Exception as e:
        log_util.warning(
            "get_function_by_call 调用点定位异常: candidate_source=grep "
            "candidate_count=0 "
            f"duration_ms={(time.perf_counter() - started_at) * 1000:.1f} error={e}",
            logger=logger,
        )

    normalized_file_path = _normalize_callsite_path(project_path, file_path) if file_path else ""
    candidates: set[CallsiteCandidate] = {
        (
            # rg 以单文件为搜索根时可能只返回 basename；搜索范围已经限定为
            # file_path，因此统一使用用户提供的项目相对路径恢复稳定候选路径。
            normalized_file_path or _normalize_callsite_path(project_path, result.file_path),
            result.line,
            result.content,
        )
        for result in file_line_results
    }

    # 文件已经用于约束 Ripgrep 搜索范围，这里的路径比较仅统一绝对/相对输出；
    # 行号仍是软收敛条件，精确行未命中时保留文件内搜索结果。
    if candidates and file_path:
        file_candidates = {
            candidate
            for candidate in candidates
            if candidate[0] == normalized_file_path
        }
        if file_candidates:
            candidates = file_candidates

    if candidates and line:
        line_candidates = {
            candidate for candidate in candidates if candidate[1] == line
        }
        if line_candidates:
            candidates = line_candidates

    # 稳定排序后截断；集合已负责去重，同一文件的不同调用行仍是不同候选。
    sorted_candidates = sorted(candidates)[:MAX_CALLSITE_CANDIDATES]
    log_util.info(
        "get_function_by_call candidate_source=grep "
        f"candidate_count={len(sorted_candidates)} "
        f"duration_ms={(time.perf_counter() - started_at) * 1000:.1f}",
        logger=logger,
    )
    return sorted_candidates


def build_function_call_result(
    project_path: Path,
    caller_function: models.FunctionDef,
    callee_function: models.FunctionDef,
    callsite_loc: models.Location,
    callsite_content: str,
    function_call: str,
) -> models.GetFunctionDefByFunctionCallOutput:
    """根据已解析的调用方/被调方函数定义组装一个 get_function_by_call 结果。"""
    display_fqn, display_signature = display_function_def_for_call(
        callee_function, function_call
    )
    callsite = models.CallSite(
        file_path=callsite_loc.file_path.as_posix(),
        line=callsite_loc.start_line,
        content=callsite_content,
    )
    caller = models.Caller(
        function_fqn=caller_function.function_fqn,
        function_signature=caller_function.function_signature,
        file_path=caller_function.location.file_path.as_posix(),
        line=caller_function.location.start_line,
    )
    callee_function_content = file_util.get_file_content_by_location(
        project_path, callee_function.location
    )
    return models.GetFunctionDefByFunctionCallOutput(
        caller=caller,
        call_site=callsite,
        function_fqn=display_fqn,
        function_signature=display_signature,
        location=callee_function.location,
        content=callee_function_content,
    )


CalleeExpansionMode = Literal["python_dfs", "sql_recursive", "bfs"]


def _find_callgraph_root_node(
    accessor: CallgraphSqlAccessor,
    language: Language,
    name: str,
    function_fqn: str,
    file_path: str,
    line: int,
    use_regex: bool,
) -> tuple[dict | None, int]:
    """只从 cg_nodes 定位 get_call_graph 根函数。

    调用链说明：
    1. get_call_graph 的 file_path/line 表示目标函数定义位置，因此根节点定位
       必须从 cg_nodes.func_def_* 开始，不能从 cg_call_sites 调用点反推。
    2. query_function_node_ids 在内部按固定顺序降级：
       file+line -> file+name+fqn -> file+fqn -> name+fqn -> fqn -> name。
    3. 每一层查询只拼接本层声明的字段；一旦命中结果，就跳过后续更弱的
       降级层级，保证候选集合和 root 选择稳定。
    4. need_definition=True 会提前过滤 external 和 placeholder 节点，确保
       CallGraphTraversor 从真实函数定义开始遍历。
    5. get_call_graph 只需要一个根函数；如果命中多个候选，保持 SQL 排序取
       第一条，同时把候选总数返回给阶段 1 日志用于排查歧义。
    """
    root_nodes = accessor.query_function_node_ids(
        language,
        name=name,
        function_fqn=function_fqn,
        file_path=file_path,
        line=line,
        use_regex=use_regex,
        need_definition=True,
    )
    return (root_nodes[0] if root_nodes else None, len(root_nodes))


@async_wrap(pool="slow")
@timed(logger, "callgraph_service", "get_call_graph")
@with_truncation
def get_call_graph(
    context: YasaMcpContext,
    name: str,
    function_fqn: str = "",
    function_signature: str = "",
    file_path: str = "",
    line: int = 0,
    depth: int = 3,
    use_regex: bool = False,
    detail_level: str = "summary",
    *,
    callee_expansion: CalleeExpansionMode = "bfs",
    max_callees_per_node: int = 3,
    exclude_undefined_function_call: bool = True,
    max_output_tokens: int = 0,
) -> YasaMcpResults[models.GetCallGraphOutput]:
    """
    :param name: 函数名（必填），短名或 FQN
    :param function_fqn: 函数 FQN（选填），非空时优先精确匹配
    :param use_regex: True 时对 name 使用正则匹配
    :param exclude_undefined_function_call: True 时排除外部未定义函数调用
    :param max_callees_per_node: 每个节点最多返回的被调用函数数量，0 或负数表示不限制，默认 3。
    :param max_output_tokens: 输出 token 截断上限，0 表示不截断
    """
    if not name and not function_fqn and not function_signature:
        return []

    # ── 路由：REPO 态走 realtime，NONE 态返回空 ──
    if context is None or not context.is_cache_ready(CacheStatusMask.REPO):
        logger.error("get_call_graph: repo 未就绪，cache_status=%s", context.cache_status if context else "None")
        return []

    if not context.is_cache_ready(CacheStatusMask.ALL):
        lang_str = context.get_project_main_language()
        return realtime_get_call_graph(
            project_path=context.project_path,
            language=lang_str,
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
        )

    accessor = get_callgraph_repository(context)
    if accessor is None:
        return []

    total_start = time.perf_counter()
    results: list[models.GetCallGraphOutput] = []
    project_path = context.project_path

    # 主语言路由：固定查仓库主语言，不再逐语言循环，避免副语言（如 java 仓里的 javascript）空跑翻倍点查。
    language = context.get_main_languages()
    stage2_ms = 0.0

    # 阶段 1: 基于 cg_nodes 定位根函数。
    stage1_start = time.perf_counter()
    root_node, root_count = _find_callgraph_root_node(
        accessor=accessor,
        language=language,
        name=name,
        function_fqn=function_fqn,
        file_path=file_path,
        line=line,
        use_regex=use_regex,
    )
    stage1_ms = (time.perf_counter() - stage1_start) * 1000
    log_util.info(
        f"get_call_graph 阶段1(定位根函数): language={language.value}, "
        f"name={name}, fqn={function_fqn}, root_count={root_count}",
        logger=logger,
    )

    if root_node is not None:
        root_node_id = root_node["node_id"]
        root_def = accessor.build_function_defs_from_cg_node_ids(language, [root_node_id]).get(root_node_id)
        if root_def is not None and root_def.location != models.Location.default():
            # 阶段 2: 展开调用树
            stage2_start = time.perf_counter()
            caller = models.Caller(
                function_fqn=root_def.function_fqn,
                function_signature=root_def.function_signature,
                file_path=root_def.location.file_path.as_posix(),
                line=root_def.location.start_line,
            )
            traversor = CallGraphTraversor(
                accessor=accessor,
                language=language,
                project_path=project_path,
                detail_level=detail_level,
                max_depth=depth,
                max_callees_per_node=max_callees_per_node,
                exclude_undefined_function_call=exclude_undefined_function_call,
            )
            callees = traversor.build(root_node_id, mode=callee_expansion)
            results.append(
                models.GetCallGraphOutput(caller=caller, callees=callees)
            )
            stage2_ms = (time.perf_counter() - stage2_start) * 1000
            log_util.info(
                f"get_call_graph 阶段2(展开调用树): language={language.value}, mode={callee_expansion}, "
                f"max_depth={depth}, results={len(results)}",
                logger=logger,
            )

    total_ms = (time.perf_counter() - total_start) * 1000
    log_util.info(
        f"执行完成get_call_graph: total_results={len(results)}, "
        f"stage1_duration={stage1_ms:.1f}ms, stage2_duration={stage2_ms:.1f}ms, "
        f"total_duration={total_ms:.1f}ms",
        logger=logger,
    )

    return results


@async_wrap(pool="slow")
@timed(logger, "callgraph_service", "get_reference_by_function")
@with_truncation
def get_reference_by_function(
    context: YasaMcpContext,
    name: str,
    function_fqn: str = "",
    function_signature: str = "",
    file_path: str = "",
    line: int = 0,
    use_regex: bool = False,
    max_results: int = 10,
    offset: int = 0,
    max_output_tokens: int = 0,
) -> YasaMcpResults[models.GetFunctionReferenceOutput]:
    if not name and not function_fqn:
        return []

    total_start = time.perf_counter()
    if function_signature:
        log_util.info(
            "get_reference_by_function: function_signature ignored for compatibility",
            logger=logger,
        )

    # ── 路由：REPO 态走 realtime，NONE 态返回空 ──
    if context is None or not context.is_cache_ready(CacheStatusMask.REPO):
        logger.error("get_reference_by_function: repo 未就绪，cache_status=%s", context.cache_status if context else "None")
        return []

    if not context.is_cache_ready(CacheStatusMask.ALL):
        lang_str = context.get_project_main_language()
        return realtime_get_reference_by_function(
            project_path=context.project_path,
            language=lang_str,
            name=name,
            function_fqn=function_fqn,
            function_signature=function_signature,
            file_path=file_path,
            line=line,
            use_regex=use_regex,
            offset=offset,
            max_results=max_results,
        )

    accessor = get_callgraph_repository(context)
    if accessor is None:
        return []

    limit = max_results if max_results > 0 else 0
    results: list[models.GetFunctionReferenceOutput] = []
    seen: set[tuple] = set()
    project_path = context.project_path

    log_util.info(
        f"get_reference_by_function 开始: name={name}, fqn={function_fqn}, "
        f"signature_ignored={bool(function_signature)}, limit={limit}, offset={offset}",
        logger=logger,
    )

    # 主语言路由：固定查仓库主语言，不再逐语言循环，避免副语言（如 java 仓里的 javascript）空跑翻倍点查。
    language = context.get_main_languages()

    stage2_ms = 0.0
    stage3_ms = 0.0
    stage4_ms = 0.0

    # 阶段 1: 只基于 cg_nodes 定位目标节点
    stage1_start = time.perf_counter()
    target_nodes = accessor.query_function_node_ids(
        language,
        name=name,
        function_fqn=function_fqn,
        use_regex=use_regex,
        need_definition=False,
    )
    target_node_ids = [row["node_id"] for row in target_nodes]
    stage1_ms = (time.perf_counter() - stage1_start) * 1000
    log_util.info(
        f"get_reference_by_function 阶段1(定位target nodes): language={language.value}, "
        f"target_nodes={len(target_nodes)}",
        logger=logger,
    )

    if target_node_ids:
        # 阶段 2: 批量查询入边
        stage2_start = time.perf_counter()
        incoming_edges = accessor.get_incoming_edges_for_targets(
            language,
            target_node_ids,
            limit=limit,
            offset=offset,
        )
        stage2_ms = (time.perf_counter() - stage2_start) * 1000
        log_util.info(
            f"get_reference_by_function 阶段2(查询incoming edges): language={language.value}, "
            f"target_nodes={len(target_node_ids)}, incoming_edges={len(incoming_edges)}",
            logger=logger,
        )

        # 阶段 3: 根据入边 source_node_id 查询调用方节点。
        # 先对 source_node_id 去重，避免同一个调用方多次调用目标函数时重复查库。
        stage3_start = time.perf_counter()
        unique_source_nodes = {row["source_node_id"] for row in incoming_edges}
        caller_cache = accessor.build_function_defs_from_cg_node_ids(
            language,
            list(unique_source_nodes),
        )
        callers_with_def = sum(
            1
            for caller in caller_cache.values()
            if caller is not None and caller.location != models.Location.default()
        )
        stage3_ms = (time.perf_counter() - stage3_start) * 1000
        log_util.info(
            f"get_reference_by_function 阶段3(查询caller): language={language.value}, "
            f"incoming_edges={len(incoming_edges)}, callers={len(unique_source_nodes)}, "
            f"有定义的caller数量callers_with_def={callers_with_def}",
            logger=logger,
        )

        # 阶段 4: 拼接结果并去重。
        # 每条入边对应一个调用点，输出调用方函数和调用点信息；
        # 去重只使用 GetFunctionReferenceOutput 中对外可见且能稳定标识一条引用的字段，
        # 不使用内部 target_node_id，避免把同一可见引用因为不同内部别名拆成多条。
        stage4_start = time.perf_counter()
        raw_results = 0
        for erow in incoming_edges:
            if limit and len(results) >= limit:
                break

            # source_node_id 找不到调用方时无法构造对外结果，直接跳过该边。
            caller_function = caller_cache.get(erow["source_node_id"])
            if caller_function is None:
                continue

            # 调用点来自 cg_call_sites，表示“在哪一行调用了目标函数”。
            loc = accessor.callsite_row_to_location(erow)
            callsite_content = file_util.get_file_content_by_location(project_path, loc)
            callsite = models.CallSite(
                file_path=loc.file_path.as_posix(),
                line=loc.start_line,
                content=callsite_content,
            )

            # 降级得到的调用方没有真实定义位置，不能按默认位置读取文件内容。
            if caller_function.location == models.Location.default():
                caller_content = ""
            else:
                caller_content = file_util.get_file_content_by_location(
                    project_path, caller_function.location
                )

            result = models.GetFunctionReferenceOutput(
                call_site=callsite,
                function_fqn=caller_function.function_fqn,
                location=caller_function.location,
                content=caller_content,
            )
            raw_results += 1

            # 只用输出字段里的稳定标识去重；同一调用方同一行的同一引用只保留一条。
            key = (
                result.call_site.file_path,
                result.call_site.line,
                result.function_fqn,
                result.location.file_path.as_posix(),
                result.location.start_line,
                result.location.end_line,
            )
            if key in seen:
                continue
            seen.add(key)
            results.append(result)
        stage4_ms = (time.perf_counter() - stage4_start) * 1000
        log_util.info(
            f"get_reference_by_function 阶段4(拼接去重): language={language.value}, "
            f"raw_results={raw_results}, deduped_total={len(results)}",
            logger=logger,
        )

    total_ms = (time.perf_counter() - total_start) * 1000
    log_util.info(
        f"get_reference_by_function 完成: total_results={len(results)}, limit={limit}, "
        f"stage1_duration={stage1_ms:.1f}ms, stage2_duration={stage2_ms:.1f}ms, "
        f"stage3_duration={stage3_ms:.1f}ms, stage4_duration={stage4_ms:.1f}ms, "
        f"total_duration={total_ms:.1f}ms",
        logger=logger,
    )

    return results


@async_wrap(pool="slow")
@timed(logger, "callgraph_service", "get_function_by_call")
@with_truncation
def get_function_by_call(
    context: YasaMcpContext,
    function_call: str = "",
    file_path: str = "",
    line: int = 0,
    fuzzy_match: bool = False,
    max_results: int = 10,
    max_output_tokens: int = 0,
    extra: dict = {}
) -> YasaMcpResults[models.GetFunctionDefByFunctionCallOutput]:
    # ── 路由：REPO 态走 realtime，NONE 态返回空 ──
    if context is None or not context.is_cache_ready(CacheStatusMask.REPO):
        logger.error("get_function_by_call: repo 未就绪，cache_status=%s", context.cache_status if context else "None")
        return []

    # 调用文本或完整调用点位置至少提供一组；精确位置可直接查询调用图。
    if not function_call and not (file_path and line > 0):
        return []

    if not context.is_cache_ready(CacheStatusMask.ALL):
        lang_str = context.get_project_main_language()
        return realtime_get_function_by_call(
            project_path=context.project_path,
            language=lang_str,
            function_call=function_call,
            file_path=file_path,
            line=line,
            fuzzy_match=fuzzy_match,
            max_results=max_results,
        )

    results: list[models.GetFunctionDefByFunctionCallOutput] = []
    total_start = time.perf_counter()
    limit = max_results if max_results > 0 else 0
    project_path = context.project_path

    # 阶段 1: 根据输入定位调用点；helper 内记录候选来源、去重后数量和耗时。
    stage1_start = time.perf_counter()
    callsite_candidates = _locate_callsite_candidates(
        context, project_path, function_call, file_path, line
    )
    stage1_ms = (time.perf_counter() - stage1_start) * 1000
    log_util.info(
        "get_function_by_call 阶段1 定位调用点完成: "
        f"candidates={len(callsite_candidates)}, "
        f"filepath={file_path} , line={line} , function_call={function_call}",
        logger=logger,
    )

    accessor = get_callgraph_repository(context)
    if accessor is None:
        return results

    language = context.get_main_languages()

    # 阶段 2 只负责把"候选调用点"映射成 callgraph edge；阶段 3 只消费 valid_edges 组装函数定义结果。
    # 主语言路由：固定查仓库主语言，不再逐语言循环，避免副语言（如 java 仓里的 javascript）空跑翻倍点查。
    seen_results: set[tuple] = set()
    valid_edges: list[tuple[dict, models.Location, str]] = []

    # 阶段 2：根据调用点找调用边。
    # 用 batch_get_edges_by_callsite_ranges 一次批量查回所有候选调用点的边，替代逐点串行点查。
    # 两轮批量，复刻旧「精确行先查 + 未命中再 ±2 兜底」语义：
    #   第1批：所有候选用精确行 (call_line, call_line) 一次查；若第1批整体有结果则直接采用，不再放宽。
    #   第2批：仅当第1批整体为空时，所有候选拓宽到 (max(1,call_line-2), call_line+2) 再查一次。
    # 命中边按 (file, start_line) 分组：单条直接确认；多条读源码校验 file/line/content 消歧。
    stage2_start = time.perf_counter()

    # 第1批：所有候选用精确行 (call_line, call_line) 一次批量查。
    effective_rows: list[dict] = []
    exact_callsites = [
        (rel_path_str, call_line, call_line)
        for rel_path_str, call_line, _ in callsite_candidates
    ]
    batch_rows = accessor.batch_get_edges_by_callsite_ranges(language, exact_callsites)

    # 第1批整体为空时才发第2批 ±2 兜底；第1批有任何结果就直接用第1批，不再放宽行号。
    if not batch_rows:
        fuzzy_callsites = [
            (rel_path_str, max(1, call_line - 2), call_line + 2)
            for rel_path_str, call_line, _ in callsite_candidates
        ]
        batch_rows = accessor.batch_get_edges_by_callsite_ranges(language, fuzzy_callsites)
    effective_rows = batch_rows

    # 调用点只查到一条 edge，说明 调用关系 已经唯一定位，直接确认。
    if len(effective_rows) == 1:
        erow = effective_rows[0]
        callsite_loc = accessor.callsite_row_to_location(erow)
        callsite_content = file_util.get_file_content_by_location(project_path, callsite_loc)
        valid_edges.append((erow, callsite_loc, callsite_content))
    else:
    # 调用点查到多条 edge，需要校验内容
        for erow in effective_rows:
            callsite_loc = accessor.callsite_row_to_location(erow)
            candidate_path = callsite_loc.file_path
            if not candidate_path.is_absolute():
                candidate_path = (project_path / candidate_path).resolve()

            # 多条 edge 时先校验文件和行号，确保没有偏离用户指定的调用点。
            if not ParamsValidator.validate(
                fuzzy_match=True,
                file_path=(Path(file_path), candidate_path),
                line=(line, callsite_loc.start_line),
            ):
                continue
            # 再按调用图位置读取真实源码片段，并用 function_call 做内容消歧。
            callsite_content = file_util.get_file_content_by_location(project_path, callsite_loc)
            # if not callsite_content_matches(function_call, callsite_content):
            #     continue
            valid_edges.append((erow, callsite_loc, callsite_content))

    stage2_ms = (time.perf_counter() - stage2_start) * 1000
    log_util.info(
        f"get_function_by_call 阶段2 根据调用点定位调用边完成: "
        f"language={language} valid_edges={len(valid_edges)}",
        logger=logger,
    )

    # 阶段 3：根据调用关系找到调用方和被调方的实现。
    # 这里不再做被调函数名与 function_call 的校验，因为匿名函数会被误杀。
    # 批量查询有效边涉及的 source/target node，然后直接消费有效边组装结果。
    stage3_start = time.perf_counter()
    node_ids = {
        erow[node_key]
        for erow, _, _ in valid_edges
        for node_key in ("source_node_id", "target_node_id")
    }
    func_defs = accessor.build_function_defs_from_cg_node_ids(language, list(node_ids))

    stage3_ms = (time.perf_counter() - stage3_start) * 1000
    log_util.info(
        f"get_function_by_call 阶段3 根据调用边获取函数定义完成: "
        f"language={language}, node_ids={len(node_ids)}, func_defs={len(func_defs)}",
        logger=logger,
    )

    stage4_start = time.perf_counter()
    for erow, callsite_loc, callsite_content in valid_edges:
        if limit and len(results) >= limit:
            break

        caller_function = func_defs.get(erow["source_node_id"])
        callee_function = func_defs.get(erow["target_node_id"])
        if (
            caller_function is None
            or callee_function is None
            or callee_function.location.file_path == Path("default")
        ):
            continue

        # 去重和 limit 在 append 前完成：同一函数定义只返回一次，避免先追加后裁剪导致分页语义混乱。
        result_key = (
            callee_function.location.file_path.as_posix(),
            callee_function.location.start_line,
            callee_function.location.end_line,
            callee_function.function_fqn,
        )
        if result_key in seen_results:
            continue
        seen_results.add(result_key)

        results.append(build_function_call_result(
            project_path=project_path,
            caller_function=caller_function,
            callee_function=callee_function,
            callsite_loc=callsite_loc,
            callsite_content=callsite_content,
            function_call=function_call,
        ))

    stage4_ms = (time.perf_counter() - stage4_start) * 1000
    log_util.info(
        f"get_function_by_call 阶段4 结果组装完成: "
        f"language={language}, results={len(results)}",
        logger=logger,
    )

    total_ms = (time.perf_counter() - total_start) * 1000
    log_util.info(
        f"get_function_by_call 完成: total_results={len(results)}, limit={limit}, "
        f"stage1_duration={stage1_ms:.1f}ms, stage2_duration={stage2_ms:.1f}ms, "
        f"stage3_duration={stage3_ms:.1f}ms, stage4_duration={stage4_ms:.1f}ms, "
        f"total_duration={total_ms:.1f}ms",
        logger=logger,
    )

    return results

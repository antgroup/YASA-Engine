"""
代码上下文查找 Service（DuckDB 版）

将原有 CPU 密集的内存遍历改造为 DuckDB IO 查询，提升高并发下的吞吐量。

包含以下接口：
1. get_import_by_file：查询 CodeGraph 记录的文件导入语句
2. get_class_by_name：根据类名查找类定义
3. get_function_by_name：根据函数名和函数签名查找函数定义
4. get_function_by_code：根据代码片段查找所在的函数定义
5. get_function_by_file：根据文件路径获取该文件中所有函数定义
6. get_file_by_keyword：根据关键字查找文件内容
7. get_entry_points：从 yasa-scan routes 投影接口入口及实现函数
"""
import bisect
import logging
import re
import time
from pathlib import Path

from yasa_mcp.core.cache_status import CacheStatusMask
from yasa_mcp.core.enums import Tool
from yasa_mcp.core.context import YasaMcpContext
from yasa_mcp.repository.codegraph_repo import CodeGraphAnalysisRepository
from yasa_mcp.repository.dao.codegraph import CodeGraphNodeRow
from yasa_mcp.repository.query.codegraph.class_analysis_processor import ClassAnalysisProcessor
from yasa_mcp.repository.query.codegraph.function_analysis_processor import FunctionAnalysisProcessor
from yasa_mcp.repository.query.codegraph.query_models import FunctionRecord
from yasa_mcp.repository.query.codegraph.interface_implementation_processor import (
    InterfaceImplementationProcessor,
)
from yasa_mcp.service import models
from yasa_mcp.service.repository_service import (
    get_codegraph_repository,
)
from yasa_mcp.service.models import Location, YasaMcpResults
from yasa_mcp.util.truncation_util import with_truncation
from yasa_mcp.util import file_util, log_util
from yasa_mcp.util.codegraph_param_util import CodeGraphParamUtil
from yasa_mcp.util.extract_annotation_util import extract_annotations
from yasa_mcp.util.async_util import async_wrap
from yasa_mcp.util.timer_util import timed
from yasa_mcp.util.selector_util import normalize_selector
from yasa_mcp.util.location_util import safe_symbol_location

from yasa_mcp.service.realtime.realtime_service import (
    realtime_get_class_by_name,
    realtime_get_function_by_name,
    realtime_get_function_by_code,
    realtime_get_function_by_file,
)

logger = logging.getLogger(__name__)

# ── 辅助函数 ─────────────────────────────────────────────────────


def _dict_to_location(row: dict) -> Location:
    """将 DuckDB 查询结果 dict 转换为 Location 对象。"""
    return Location(
        file_path=Path(row["file_path"]),
        start_line=row["start_line"],
        start_column=row["start_column"],
        end_line=row["end_line"],
        end_column=row["end_column"],
    )


def _get_codegraph_repo_or_warn(context: YasaMcpContext) -> CodeGraphAnalysisRepository | None:
    """兼容现有代码搜索调用；实际 consumer repository 获取由共享服务负责。"""
    return get_codegraph_repository(context)


# ── 0. get_import_by_file ─────────────────────────────────────────


@async_wrap
@timed(logger, "code_search_service", "get_import_by_file")
@with_truncation
def get_import_by_file(
    context: YasaMcpContext,
    file_path: str,
    fuzzy_match: bool = True,
    exclude_external_import: bool = False,
    max_results: int = 0,
    max_output_tokens: int = 0,
) -> YasaMcpResults[models.ImportResult]:
    """查询 CodeGraph ``nodes`` 表记录的当前文件导入语句。

    CodeGraph import node 直接提供导入模块名与源码行号。本接口不再解析源码，也不
    关联 ``edges`` 推导目标文件，因此 ``names`` 和 ``resolved_file_path`` 使用模型
    约定的空值。``exclude_external_import`` 依赖 resolved path 判断；在 nodes-only
    语义下无法证明任何记录属于项目内依赖，开启后会返回空列表。
    """

    if context is None or not context.is_cache_ready(CacheStatusMask.REPO):
        logger.error(
            "get_import_by_file: repo 未就绪，cache_status=%s",
            context.cache_status if context else "None",
        )
        return []

    if context.project_path is None:
        log_util.warning("get_import_by_file: project_path 不可用", logger=logger)
        return []
    # CodeGraph 的公开查询统一复用同一套路径规范，避免各 service 对相对路径、
    # Windows 分隔符和项目内绝对路径产生不同解释。
    query_path = CodeGraphParamUtil.normalize_file_path(
        context.project_path,
        file_path,
    )

    repository = get_codegraph_repository(context)
    if repository is None:
        log_util.warning(
            f"get_import_by_file: CodeGraph repository 不可用, file_path={query_path!r}",
            logger=logger,
        )
        return []

    try:
        # 过滤外部依赖需要 resolved_file_path，但 nodes 单表没有该字段。此处仍完成
        # 参数化查询再统一过滤，确保该参数不会意外触发旧 resolver 或 edges 查询。
        rows = repository.find_import_nodes_by_file(
            query_path,
            fuzzy_match=fuzzy_match,
            limit=0 if exclude_external_import else max_results,
        )
    except Exception as exc:
        log_util.exception(
            "get_import_by_file 查询失败: "
            f"file_path={query_path!r}, reason={str(exc) or type(exc).__name__}",
            logger=logger,
        )
        return []

    results = [
        models.ImportResult(
            module=str(row.get("name") or row.get("qualified_name") or ""),
            names=[],
            line=int(row.get("start_line") or 0),
            resolved_file_path="",
        )
        for row in rows
    ]
    if exclude_external_import:
        return []
    return results


# ── 1. get_class_by_name（原 get_class_def）─────────────────────────


@async_wrap
@timed(logger, "code_search_service", "get_class_by_name")
@with_truncation
def get_class_by_name(
    context: YasaMcpContext,
    name: str | list[str],
    class_fqn: str | list[str] = "",
    use_regex: bool = False,
    include_methods: bool = False,
    offset: int = 0,
    max_results: int = 10,
    max_output_tokens: int = 0,
) -> YasaMcpResults[models.GetClassDefOutput]:
    if not name and not class_fqn:
        return []

    # ── 路由：REPO 态走 realtime，NONE 态返回空 ──
    if context is None or not context.is_cache_ready(CacheStatusMask.REPO):
        logger.error("get_class_by_name: repo 未就绪，cache_status=%s", context.cache_status if context else "None")
        return []

    if not context.is_cache_ready(CacheStatusMask.ALL):
        lang_str = context.get_project_main_language()
        return realtime_get_class_by_name(
            project_path=context.project_path,
            language=lang_str,
            name=name,
            class_fqn=class_fqn,
            include_methods=include_methods,
            use_regex=use_regex,
            offset=offset,
            max_results=max_results,
        )

    limit = max_results if max_results > 0 else 0
    repo = _get_codegraph_repo_or_warn(context)
    if repo is None:
        return []

    # 阶段 1: DuckDB 查询
    stage1_start = time.perf_counter()
    processor = ClassAnalysisProcessor(
        repo,
        name=name,
        class_fqn=class_fqn,
        use_regex=use_regex,
    )
    candidates = processor.search(limit=limit, offset=offset)
    stage1_ms = (time.perf_counter() - stage1_start) * 1000
    log_util.info(
        f"get_class_by_name 阶段1(代码索引查询): candidates={len(candidates)}, "
        f"duration={stage1_ms:.1f}ms",
        logger=logger,
    )

    # 阶段 2: 文件内容提取 + 方法列表
    stage2_start = time.perf_counter()
    results = []
    for row in candidates:
        if limit and len(results) >= limit:
            break

        location = _dict_to_location(row)
        content = file_util.get_file_content_by_location(
            context.project_path, location
        )
        method_list = []
        if include_methods:
            method_rows = processor.get_methods(row["class_fqn"])
            method_list = [
                models.MethodInfo(
                    name=m["short_name"],
                    function_signature=m["function_signature"],
                    line=m["start_line"],
                )
                for m in method_rows
            ]
        results.append(
            models.GetClassDefOutput(
                class_fqn=row["class_fqn"],
                file_path=location.file_path.as_posix(),
                location=location,
                content=content,
                methods=method_list,
            )
        )

    stage2_ms = (time.perf_counter() - stage2_start) * 1000
    log_util.info(
        f"get_class_by_name 阶段2(内容提取): results={len(results)}, "
        f"duration={stage2_ms:.1f}ms",
        logger=logger,
    )

    return results


# ── 2. get_function_by_name（原 get_function_def）──────────────────


@async_wrap
@timed(logger, "code_search_service", "get_function_by_name")
@with_truncation
def get_function_by_name(
    context: YasaMcpContext,
    name: str | list[str],
    function_fqn: str | list[str] = "",
    function_signature: str | list[str] = "",
    use_regex: bool = False,
    offset: int = 0,
    max_results: int = 10,
    max_output_tokens: int = 0,
) -> YasaMcpResults[models.GetFunctionDefOutput]:
    if not name and not function_fqn:
        return []

    # ── 路由：REPO 态走 realtime，NONE 态返回空 ──
    if context is None or not context.is_cache_ready(CacheStatusMask.REPO):
        logger.error("get_function_by_name: repo 未就绪，cache_status=%s", context.cache_status if context else "None")
        return []

    if not context.is_cache_ready(CacheStatusMask.ALL):
        lang_str = context.get_project_main_language()
        return realtime_get_function_by_name(
            project_path=context.project_path,
            language=lang_str,
            name=name,
            function_fqn=function_fqn,
            function_signature="",
            use_regex=use_regex,
            offset=offset,
            max_results=max_results,
        )

    limit = max_results if max_results > 0 else 0
    repo = _get_codegraph_repo_or_warn(context)
    if repo is None:
        return []

    # 阶段 1: 代码索引查询候选集
    stage1_start = time.perf_counter()
    processor = FunctionAnalysisProcessor(
        repo,
        project_path=context.project_path,
        name=name,
        function_fqn=function_fqn,
        use_regex=use_regex,
    )
    candidates = processor.search(limit=limit, offset=offset)
    stage1_ms = (time.perf_counter() - stage1_start) * 1000
    log_util.info(
        f"get_function_by_name 阶段1(代码索引查询): name={name}, fqn={function_fqn}, "
        f"candidates={len(candidates)}, duration={stage1_ms:.1f}ms",
        logger=logger,
    )

    # 阶段 2: 提取文件内容和注解
    stage3_start = time.perf_counter()
    results = []
    for row in candidates:
        if limit and len(results) >= limit:
            break
        location = _dict_to_location(row)
        content = file_util.get_file_content_by_location(
            context.project_path, location
        )
        f_annos, p_annos = extract_annotations(
            context.project_path,
            location.file_path,
            location.start_line,
            content,
        )
        results.append(
            models.GetFunctionDefOutput(
                function_fqn=row["function_fqn"],
                function_signature=row["function_signature"],
                file_path=location.file_path.as_posix(),
                location=location,
                content=content,
                function_annotations=f_annos,
                parameter_annotations=p_annos,
            )
        )
    stage3_ms = (time.perf_counter() - stage3_start) * 1000
    log_util.info(
        f"get_function_by_name 阶段3(内容提取): results={len(results)}, "
        f"duration={stage3_ms:.1f}ms",
        logger=logger,
    )

    return results


# ── 3. get_function_by_code（原 get_function_def_by_code_snippet）──
@async_wrap
@timed(logger, "code_search_service", "get_function_by_code")
@with_truncation
def get_function_by_code(
    context: YasaMcpContext,
    code_snippet: str,
    use_regex: bool = False,
    offset: int = 0,
    max_results: int = 10,
    max_output_tokens: int = 0,
) -> YasaMcpResults[models.GetFunctionDefOutput]:
    """
    根据代码片段查找所在的函数定义。

    1. 使用 Ripgrep 搜索包含该代码片段的文件 + 行号
    2. 批量从 DuckDB 获取相关文件的函数定义
    3. 对每个命中行，找到距离最近的函数定义
    """
    if not code_snippet:
        return []

    # ── 路由：REPO 态走 realtime，NONE 态返回空 ──
    if context is None or not context.is_cache_ready(CacheStatusMask.REPO):
        logger.error("get_function_by_code: repo 未就绪，cache_status=%s", context.cache_status if context else "None")
        return []

    if not context.is_cache_ready(CacheStatusMask.ALL):
        lang_str = context.get_project_main_language()
        return realtime_get_function_by_code(
            project_path=context.project_path,
            language=lang_str,
            code_snippet=code_snippet,
            use_regex=use_regex,
            offset=offset,
            max_results=max_results,
        )

    ripgrep_tool = context.get_tool(Tool.RIPGREP)
    repo = _get_codegraph_repo_or_warn(context)
    if repo is None:
        return []

    # 阶段 1: Ripgrep 搜索
    stage1_start = time.perf_counter()
    matches = ripgrep_tool.search_keyword_with_line(
        context.project_path.as_posix(), code_snippet
    )
    stage1_ms = (time.perf_counter() - stage1_start) * 1000
    log_util.info(
        f"get_function_by_code 阶段1(ripgrep): "
        f"matches={len(matches) if matches else 0}, duration={stage1_ms:.1f}ms",
        logger=logger,
    )
    if not matches:
        return []

    # ripgrep 多线程遍历顺序非确定，跨进程会得到不同文件顺序，
    # 这里按 (file_path, line) 排序，使结果顺序与 offset/limit 选取均跨进程稳定。
    matches = sorted(matches, key=lambda m: (str(m.file_path), m.line))

    # 将命中的行号按文件分组
    limit = max_results if max_results > 0 else 0
    file_to_lines: dict[str, list[int]] = {}
    for file_line_result in matches:
        # 对结果进行截断，避免大量数据进入后续计算
        if limit and len(file_to_lines) >= 5 * (limit + offset):
            break
        file_path = str(file_line_result.file_path.relative_to(context.project_path))
        file_to_lines.setdefault(file_path, []).append(file_line_result.line)

    # 阶段 2: 批量获取相关文件的函数定义
    stage2_start = time.perf_counter()
    func_rows = FunctionAnalysisProcessor.for_files(
        repo,
        context.project_path,
        list(file_to_lines.keys()),
    ).search_files()
    # search_files 返回扁平 list[FunctionRecord]，按 file_path 分组还原成 {path: [records]}
    file_functions: dict[str, list[FunctionRecord]] = {}
    for row in func_rows:
        file_functions.setdefault(row["file_path"], []).append(row)
    stage2_ms = (time.perf_counter() - stage2_start) * 1000
    log_util.info(
        f"get_function_by_code 阶段2(函数查询): "
        f"files={len(file_functions)}, duration={stage2_ms:.1f}ms",
        logger=logger,
    )

    # 阶段 3: 匹配最近函数 + 提取内容
    stage3_start = time.perf_counter()
    results: list[models.GetFunctionDefOutput] = []
    seen_functions: set[tuple[str, int]] = set()
    skipped = 0  # 用于实现 offset 跳过

    for file_path_str, hit_lines in file_to_lines.items():
        if limit and len(results) >= limit:
            break

        func_rows = file_functions.get(file_path_str, [])
        if not func_rows:
            continue

        func_rows_sorted = sorted(func_rows, key=lambda r: r["start_line"])
        start_lines = [r["start_line"] for r in func_rows_sorted]

        for hit_line in sorted(hit_lines):
            if limit and len(results) >= limit:
                break

            nearest = _find_nearest_function_from_rows(
                func_rows_sorted, start_lines, hit_line
            )
            if nearest is None:
                continue

            key = (nearest["file_path"], nearest["start_line"])
            if key in seen_functions:
                continue
            seen_functions.add(key)

            # 先跳过 offset 条结果，再收集 max_results 条
            if skipped < offset:
                skipped += 1
                continue

            location = _dict_to_location(nearest)
            content = file_util.get_file_content_by_location(
                context.project_path, location
            )
            f_annos, p_annos = extract_annotations(
                context.project_path,
                location.file_path,
                location.start_line,
                content,
            )

            results.append(
                models.GetFunctionDefOutput(
                    function_fqn=nearest["function_fqn"],
                    function_signature=nearest["function_signature"],
                    file_path=location.file_path.as_posix(),
                    location=location,
                    content=content,
                    function_annotations=f_annos,
                    parameter_annotations=p_annos,
                )
            )

    stage3_ms = (time.perf_counter() - stage3_start) * 1000
    log_util.info(
        f"get_function_by_code 阶段3(匹配+内容提取): "
        f"results={len(results)}, duration={stage3_ms:.1f}ms",
        logger=logger,
    )    
    return results


# ── 4. get_function_by_file（原 get_function_defs_in_file）─────────


@async_wrap
@timed(logger, "code_search_service", "get_function_by_file")
@with_truncation
def get_function_by_file(
    context: YasaMcpContext,
    file_path: str | list[str],
    use_regex: bool = False,
    detail_level: str = "summary",
    offset: int = 0,
    max_results: int = 0,
    max_output_tokens: int = 0,
) -> YasaMcpResults[models.GetFunctionDefOutput]:
    """根据文件路径获取该文件中所有函数定义。"""
    # ── 路由：REPO 态走 realtime，NONE 态返回空 ──
    if context is None or not context.is_cache_ready(CacheStatusMask.REPO):
        logger.error("get_function_by_file: repo 未就绪，cache_status=%s", context.cache_status if context else "None")
        return []

    project_path: Path = context.project_path
    file_paths = normalize_selector(file_path)

    if not context.is_cache_ready(CacheStatusMask.ALL):
        lang_str = context.get_project_main_language()
        realtime_file_path: str | list[str] = file_paths[0] if isinstance(file_path, str) and file_paths else list(file_paths)
        return realtime_get_function_by_file(
            project_path=project_path,
            language=lang_str,
            file_path=realtime_file_path,
            use_regex=use_regex,
            detail_level=detail_level,
            offset=offset,
            max_results=max_results,
        )

    repo = _get_codegraph_repo_or_warn(context)
    if repo is None:
        return []

    # 阶段 1: CodeGraph 请求级 processor 查询
    stage1_start = time.perf_counter()
    limit = max_results if max_results > 0 else 0
    if isinstance(file_path, str):
        processor = FunctionAnalysisProcessor.for_file(
            repo,
            project_path,
            file_path,
            use_regex=use_regex,
        )
        rows = processor.search_file(limit=limit, offset=offset)
    else:
        processor = FunctionAnalysisProcessor.for_files(
            repo,
            project_path,
            list(file_paths),
        )
        processor.use_regex = use_regex
        rows = processor.search_files(limit=limit, offset=offset)
    stage1_ms = (time.perf_counter() - stage1_start) * 1000
    log_util.info(
        f"get_function_by_file 阶段1(代码索引查询): paths={file_paths}, "
        f"regex={use_regex}, rows={len(rows)}, duration={stage1_ms:.1f}ms",
        logger=logger,
    )

    # 排序并构建结果
    rows.sort(key=lambda r: r["start_line"])

    stage3_start = time.perf_counter()
    results: list[models.GetFunctionDefOutput] = []
    for row in rows:
        location = _dict_to_location(row)
        content = ""
        if detail_level == "full":
            content = file_util.get_file_content_by_location(
                project_path, location
            )

        f_annos, p_annos = extract_annotations(
            project_path,
            location.file_path,
            location.start_line,
            content,
        )
        results.append(
            models.GetFunctionDefOutput(
                function_fqn=row["function_fqn"],
                function_signature=row["function_signature"],
                file_path=location.file_path.as_posix(),
                location=location,
                content=content,
                function_annotations=f_annos,
                parameter_annotations=p_annos,
            )
        )

    stage3_ms = (time.perf_counter() - stage3_start) * 1000
    log_util.info(
        f"get_function_by_file 阶段3(结果构建): "
        f"results={len(results)}, duration={stage3_ms:.1f}ms",
        logger=logger,
    )

    return results


# ── 4.5 search_symbol（统一 CodeGraph FTS 符号查询）───────────────

@async_wrap
@timed(logger, "code_search_service", "search_symbol")
@with_truncation
def search_symbol(
    context: YasaMcpContext,
    search: str | list[str],
    kind: str = "",
    detail_level: str = "summary",
    offset: int = 0,
    max_results: int = 0,
    max_output_tokens: int = 0,
) -> YasaMcpResults[models.QuerySymbolResult]:
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
    # —— 归一化搜索词 ——
    searches = normalize_selector(search)
    if not searches:
        return []

    # —— 缓存就绪检查 ——
    if context is None or not context.is_cache_ready(CacheStatusMask.ALL):
        logger.error(
            "search_symbol: repo 未就绪，cache_status=%s",
            context.cache_status if context else "None",
        )
        return []
    repo = _get_codegraph_repo_or_warn(context)
    if repo is None:
        return []

    # —— kind 是后置语义提示，不是封闭枚举 ——
    # 未登记的 kind 为 None，表示不过滤，保证新 CodeGraph 节点类型不被静默丢弃。
    requested_kind = (kind or "").strip().lower()
    # 已登记 kind → 一组节点 kind；未登记非空 kind → 单值；空 → 不过滤。
    accepted_kinds = CodeGraphParamUtil.SEARCH_SYMBOL_NODE_KINDS.get(requested_kind) or (
        {requested_kind} if requested_kind else None
    )
    # 所有召回节点存入 recalled_rows；kind 筛选推迟到最终组装前，避免冗余存储。
    recalled_rows: set[CodeGraphNodeRow] = set()
    # —— FTS 召回 ——
    # 对每个搜索词构建 FTS5 前缀表达式，repository 负责参数化执行和 LIMIT/OFFSET。
    # 召回不限制 kind，语义筛选在 service 层完成。
    # 与 codegraph 一致：FTS 先取 max(limit*5, 100) 条候选，再在 service 层做后置筛选和多信号重排。
    fts_limit = max(max_results * 5, 100) if max_results > 0 else 0
    query_offset = max(offset, 0)
    for value in searches:
        match_query = CodeGraphParamUtil.build_search_symbol_match(value)
        if not match_query:
            continue
        for raw_row in repo.search_symbol_nodes(
            match_query, limit=fts_limit, offset=query_offset
        ):
            row = raw_row if isinstance(raw_row, CodeGraphNodeRow) else CodeGraphNodeRow.from_mapping(raw_row)
            recalled_rows.add(row)

    # —— 筛选接口类和接口函数 ——
    # 接口类：kind == interface 的节点。
    # 接口函数：method/function 的 owner FQN（:: 前面部分）是某个接口节点 FQN。
    interface_fqns: set[str] = {
        row.qualified_name for row in recalled_rows if row.kind == "interface"
    }
    interface_rows: set[CodeGraphNodeRow] = set()
    for row in recalled_rows:
        if row.kind == "interface":
            interface_rows.add(row)
        elif row.kind in ("method", "function") and "::" in row.qualified_name:
            owner_fqn = row.qualified_name.rsplit("::", 1)[0]
            if owner_fqn in interface_fqns:
                interface_rows.add(row)

    # —— 接口实现展开（批量） ——
    # 一次性传入所有接口类和接口函数，返回实现类和实现函数，合并到 recalled_rows。
    impl_classes, impl_methods = InterfaceImplementationProcessor.expand_implementations(repo, interface_rows)
    recalled_rows |= impl_classes
    recalled_rows |= impl_methods

    # —— kind 后置筛选 ——
    filtered_rows = [
        row for row in recalled_rows
        if accepted_kinds is None or row.kind in accepted_kinds
    ]

    # —— 多信号重排（与 codegraph 一致）——
    # codegraph 在 BM25 之上叠加 nameMatchBonus（精确名 +80，前缀 +10~40）
    # 和 kindBonus（function/method +10，interface +9，class +8，import +1），
    # 使精确名匹配的符号声明排在 import/field 之上。这里复刻同样的信号。
    search_str = " ".join(searches)
    # 多信号重排：BM25(取绝对值) + 名称匹配加分 + 类型优先级加分，按总分降序。
    # import 节点除非用户显式 kind=import，否则不获得名称加分，自然沉到末尾。
    # 主键保留 codegraph 一致的总分（BM25 + nameMatchBonus + kindBonus）降序。
    # 关键：补稳定、构建无关的 tiebreak——候选取自 recalled_rows（set），其迭代顺序
    # 随 PYTHONHASHSEED 跨进程变化，单纯按总和排序会让同分行回退到 set 顺序，导致
    # 跨进程结果与 max_results 边界节点漂移。末位 qualified_name 唯一，彻底定序。
    candidates = sorted(
        filtered_rows,
        key=lambda row: (
            -(abs(row.score)
              + CodeGraphParamUtil.name_match_bonus(
                  row.name, search_str, node_kind=row.kind, requested_kind=requested_kind
              )
              + CodeGraphParamUtil.kind_bonus(row.kind)),
            row.kind,
            row.language,
            row.file_path,
            row.start_line,
            row.start_column,
            row.qualified_name,
        ),
    )
    # 截取到最终 max_results（接口展开的结果不计入 limit）
    if max_results > 0:
        candidates = candidates[:max_results]

    # —— 读取源码并组装统一响应 ——
    results: list[models.QuerySymbolResult] = []
    seen: set[str] = set()
    for row in candidates:
        # 去重：按节点 id 去重，已出现的跳过，不重复读取源码
        dedup_key = row.id
        if dedup_key in seen:
            continue
        seen.add(dedup_key)
        location = safe_symbol_location(context.project_path, row.to_symbol_dict())
        content = ""
        if detail_level == "full" and location is not None:
            if row.kind == "file":
                content = file_util.get_file_content(context.project_path / location.file_path)
            else:
                content = file_util.get_file_content_by_location(context.project_path, location)
        results.append(
            models.QuerySymbolResult(
                kind=row.kind,
                name=row.name,
                qualified_name=row.qualified_name,
                language=row.language,
                location=location,
                content=content,
            )
        )
    return results


# ── 5. get_file_by_keyword（原 get_file_content_by_keyword）───────


@async_wrap
@timed(logger, "code_search_service", "get_file_by_keyword")
@with_truncation
def get_file_by_keyword(
    context: YasaMcpContext,
    keyword: str | list[str],
    use_regex: bool = False,
    detail_level: str = "summary",
    offset: int = 0,
    max_results: int = 10,
    max_output_tokens: int = 0,
) -> YasaMcpResults[models.GetFileContentByKeywordOutput]:
    # ── REPO 缓存校验 ──
    if context is None or not context.is_cache_ready(CacheStatusMask.REPO):
        logger.error("get_file_by_keyword: repo 未就绪，cache_status=%s", context.cache_status if context else "None")
        return []

    keywords = normalize_selector(keyword)
    if not keywords:
        return []
    if use_regex:
        for value in keywords:
            try:
                re.compile(value)
            except re.error as exc:
                log_util.warning(
                    f"get_file_by_keyword: 非法正则 keyword={value!r}, error={exc}",
                    logger=logger,
                )
                return []

    limit = max_results if max_results > 0 else 0
    results = []

    ripgrep_tool = context.get_tool(Tool.RIPGREP)

    stage1_start = time.perf_counter()
    # search_keyword_with_line 返回带行号的结果
    if isinstance(keyword, str):
        matches = ripgrep_tool.search_keyword_with_line(
            context.project_path.as_posix(), keyword, use_regex=use_regex,
        )
    else:
        batch_search = getattr(ripgrep_tool, "search_keywords_with_line", None)
        if batch_search is None:
            matches = ripgrep_tool.search_keyword_with_line(
                context.project_path.as_posix(), keywords[0], use_regex=use_regex,
            )
        else:
            matches = batch_search(
                context.project_path.as_posix(), list(keywords), use_regex=use_regex,
            )
    stage1_ms = (time.perf_counter() - stage1_start) * 1000
    log_util.info(
        f"get_file_by_keyword 阶段1(ripgrep): keywords={keywords}, "
        f"matches={len(matches) if matches else 0}, "
        f"duration={stage1_ms:.1f}ms",
        logger=logger,
    )

    if not matches:
        return []

    # 按文件分组
    file_to_matches: dict[str, list] = {}
    for m in matches:
        rel_path = Path(m.file_path).relative_to(context.project_path).as_posix()
        file_to_matches.setdefault(rel_path, []).append(m)

    # ripgrep 多线程跨文件遍历顺序非确定，且多关键字并集往往远超 max_results；
    # 同一文件内命中行由 ripgrep 单次扫描天然按行号递增，无需再排。
    # 这里只对文件维度按 file_path 字典序稳定排序，使 offset/limit 截断后的
    # 结果集逐次运行稳定、可回归。
    file_list = sorted(file_to_matches.items(), key=lambda kv: kv[0])

    # 应用 offset
    if offset > 0:
        file_list = file_list[offset:]

    stage2_start = time.perf_counter()
    for rel_path, file_matches in file_list:
        if limit and len(results) >= limit:
            break

        if detail_level == "full":
            abs_path = context.project_path / rel_path
            content = file_util.get_file_content(abs_path)
            results.append(
                models.GetFileContentByKeywordOutput(
                    file_path=rel_path,
                    matches=[models.MatchSnippet(content=content)],
                )
            )
        else:
            # summary 模式：返回匹配行及前后各5行上下文片段
            abs_path = context.project_path / rel_path
            try:
                all_lines = abs_path.read_text(encoding="utf-8", errors="replace").splitlines()
            except Exception:
                all_lines = []

            snippets = []
            for m in file_matches:
                hit_line = m.line
                ctx_start = max(0, hit_line - 1 - 5)
                ctx_end = min(len(all_lines), hit_line + 5)
                snippet_lines = all_lines[ctx_start:ctx_end]
                snippet_content = "\n".join(snippet_lines)
                snippets.append(
                    models.MatchSnippet(
                        line=hit_line,
                        content=snippet_content,
                    )
                )

            results.append(
                models.GetFileContentByKeywordOutput(
                    file_path=rel_path,
                    matches=snippets,
                )
            )

    stage2_ms = (time.perf_counter() - stage2_start) * 1000
    log_util.info(
        f"get_file_by_keyword 阶段2(内容读取): "
        f"results={len(results)}, duration={stage2_ms:.1f}ms",
        logger=logger,
    )

    return results


# ── 最近函数查找 ─────────────────────────────────────────────────


def _find_nearest_function_from_rows(
    func_rows_sorted: list[dict],
    start_lines: list[int],
    hit_line: int,
    max_distance: int = 3,
) -> dict | None:
    """在按 start_line 排序的函数 dict 列表中，找到 hit_line 所属的函数。"""
    idx = bisect.bisect_right(start_lines, hit_line)

    if idx > 0:
        func = func_rows_sorted[idx - 1]
        if func["start_line"] <= hit_line <= func["end_line"]:
            return func

    best_func = None
    best_distance = float("inf")

    if idx > 0:
        func = func_rows_sorted[idx - 1]
        dist = hit_line - func["end_line"]
        if 0 < dist <= max_distance and dist < best_distance:
            best_distance = dist
            best_func = func

    if idx < len(func_rows_sorted):
        func = func_rows_sorted[idx]
        dist = func["start_line"] - hit_line
        if 0 < dist <= max_distance and dist < best_distance:
            best_func = func

    return best_func

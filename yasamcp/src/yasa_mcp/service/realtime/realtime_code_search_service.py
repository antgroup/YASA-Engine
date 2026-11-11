"""Realtime code search service: function-by-file, function-by-code,
class-by-name, function-by-name, entry-points.

Consolidates public APIs from realtime_function_file_code.py and
realtime_class_func_name.py, using shared utilities from util.realtime_common.
"""

import logging
import re
import time
from pathlib import Path

from yasa_mcp.service.models import (
    GetClassDefOutput,
    GetFunctionDefOutput,
    Location,
    MethodInfo,
    ParameterAnnotation,
)
from yasa_mcp.tools.ast_grep.ast.ast_grep_module import ClassInfo, FuncInfo
from yasa_mcp.tools.ast_grep.util.realtime_common import (
    LANGUAGE_EXTENSIONS,
    ast_location_to_service_location,
    find_nearest_function,
    funcinfo_to_function_def_output,
    get_ast_client,
    get_ripgrep_tool,
    is_test_path,
    ripgrep_search_files,
)
from yasa_mcp.util import extract_annotation_util, file_util
from yasa_mcp.util.params_validator_util import ParamsValidator
from yasa_mcp.util.timer_util import timed

logger = logging.getLogger(__name__)


# ── Private helpers ───────────────────────────────────────────────────


def _build_class_output(cls: ClassInfo, project_path: Path) -> GetClassDefOutput:
    """Convert internal ClassInfo to GetClassDefOutput."""
    content = cls.content
    if not content:
        content = file_util.get_file_content_by_location(project_path, cls.location) or ""

    methods = [
        MethodInfo(name=m.name, function_signature=m.signature, line=m.line)
        for m in cls.methods
    ]

    # Ensure file_path is relative to project_path
    raw_path = cls.location.file_path
    if raw_path.is_absolute():
        try:
            rel_path = raw_path.relative_to(project_path)
        except ValueError:
            rel_path = raw_path
    else:
        rel_path = raw_path

    location = Location(
        file_path=rel_path,
        start_line=cls.location.start_line,
        start_column=cls.location.start_column,
        end_line=cls.location.end_line,
        end_column=cls.location.end_column,
    )

    return GetClassDefOutput(
        class_fqn=cls.fqn,
        file_path=str(rel_path),
        location=location,
        content=content,
        methods=methods,
    )


@timed(logger, "realtime_analysis", "_collect_files_by_extension")
def _collect_files_by_extension(
    project_path: Path,
    extensions: tuple[str, ...],
    file_path_query: str = "",
    use_regex: bool = False,
) -> list[Path]:
    """按扩展名收集指定文件。

    默认按项目相对路径精确匹配；use_regex=True 时，才把 file_path_query
    作为正则表达式匹配项目相对路径。返回绝对路径。
    """
    if file_path_query and file_path_query != ".":
        if not use_regex:
            candidate = (project_path / file_path_query).resolve()
            if candidate.is_file() and candidate.suffix in extensions:
                return [candidate]
            return []

        try:
            pattern = re.compile(file_path_query)
        except re.error:
            return []

        results = []
        for ext in extensions:
            for p in project_path.rglob(f"*{ext}"):
                if not p.is_file():
                    continue
                rel = p.relative_to(project_path).as_posix()
                if pattern.search(rel):
                    results.append(p)
        return results

    # get_function_by_file 必须提供明确文件路径或正则；这里禁止兜底全仓收集，
    # 避免在大仓库中递归扫描海量源码文件。
    return []


def _extract_literal_core(pattern: str) -> str:
    """Extract the longest contiguous literal substring from a regex pattern.

    The regex is intended for matching function/class names, not source lines.
    We extract the literal core to use as a ripgrep pre-filter (fast fixed-string
    search), while the original regex is applied in Phase 2 on AST-extracted names.

    Examples:
        "^queryDepartment$"      -> "queryDepartment"
        ".*OverloadDemo.*"       -> "OverloadDemo"
        "get_.*_data"            -> "get_"  (longest segment)
        "Col.*Service(Impl)?"    -> "Service"
    """
    segments: list[str] = []
    current: list[str] = []
    i = 0
    while i < len(pattern):
        ch = pattern[i]
        if ch == '\\' and i + 1 < len(pattern):
            # Escaped character is literal (e.g. \. -> .)
            current.append(pattern[i + 1])
            i += 2
        elif ch in r'^$.*+?|[](){}':
            # Regex metacharacter ends current literal segment
            if current:
                segments.append(''.join(current))
                current = []
            i += 1
        else:
            current.append(ch)
            i += 1
    if current:
        segments.append(''.join(current))
    return max(segments, key=len) if segments else ""


@timed(logger, "realtime_analysis", "_find_candidate_files")
def _find_candidate_files(
    project_path: Path,
    name: str,
    language: str,
    use_regex: bool = False,
    context_pattern_fn=None,
) -> list[Path]:
    """Find candidate files that likely contain a named definition.

    Args:
        name: The name (or regex) to search for.
        language: Target language for file suffix filtering.
        use_regex: If True, name is a regex pattern for matching names (not source lines).
        context_pattern_fn: When use_regex=False, a callable(name, language) -> ripgrep regex
            that builds a language-aware search pattern (e.g. wrapping with `def\\s+...\\s*\\(`).
            If None, uses the name as a literal search.
    """
    if use_regex:
        # Extract literal core for fast pre-filtering; Phase 2 does precise regex match
        keyword = _extract_literal_core(name)
        if not keyword:
            return []
        return ripgrep_search_files(project_path, re.escape(keyword), language, exclude_tests=False)
    else:
        if context_pattern_fn:
            pattern = context_pattern_fn(name, language)
            if not pattern:
                return []
        else:
            pattern = re.escape(name)
        return ripgrep_search_files(project_path, pattern, language, exclude_tests=False)


def _class_pattern(name: str, language: str) -> str:
    """Build a ripgrep regex for class definition context."""
    escaped = re.escape(name)
    if language == "java":
        return rf"(class|interface|enum)\s+{escaped}\b"
    if language == "javascript":
        return rf"(class|interface)\s+{escaped}\b"
    return rf"class\s+{escaped}\b"


def _function_pattern(name: str, language: str) -> str | None:
    """Build a ripgrep regex for function definition context."""
    escaped = re.escape(name)
    if language == "python":
        return rf"def\s+{escaped}\s*\("
    elif language == "java":
        return rf"\b{escaped}\s*\("
    elif language == "javascript":
        return (
            rf"(function\s+{escaped}\s*\(|"
            rf"(const|let|var)\s+{escaped}\s*=\s*(async\s*)?(function\b|\(?[^=;]*\)?\s*=>)|"
            rf"\b{escaped}\s*\()"
        )
    return None


# ── Public API ────────────────────────────────────────────────────────


@timed(logger, "realtime_analysis", "realtime_get_function_by_file")
def realtime_get_function_by_file(
    project_path: Path,
    language: str,
    file_path: str = "",
    use_regex: bool = False,
    detail_level: str = "summary",
    offset: int = 0,
    max_results: int = 0,
) -> list[GetFunctionDefOutput]:
    """Realtime function-by-file lookup using ast-grep AST parsing.

    Flow: resolve files → AST extract function defs → sort + paginate → convert output.

    Args:
        max_results: Maximum results to return (0 or negative = unlimited)
    """
    extensions = LANGUAGE_EXTENSIONS.get(language)
    if not extensions:
        logger.warning(f"Unsupported language for realtime analysis: {language}")
        return []

    client = get_ast_client()

    # Stage 1: Collect matching files
    stage_start = time.perf_counter()
    files = _collect_files_by_extension(project_path, extensions, file_path, use_regex)
    if not files:
        return []
    logger.info(
        "[realtime_get_function_by_file] 阶段1(文件收集): files=%d, duration=%.1fms",
        len(files), (time.perf_counter() - stage_start) * 1000,
    )

    # Stage 2: Extract function defs from each file via AST
    stage_start = time.perf_counter()
    all_funcs: list[FuncInfo] = []
    for f in files:
        try:
            funcs = client.extract_function_defs(language, f, project_path)
            all_funcs.extend(funcs)
        except Exception as e:
            logger.warning(f"Failed to extract functions from {f}: {e}")
            continue
    logger.info(
        "[realtime_get_function_by_file] 阶段2(AST提取): functions=%d, duration=%.1fms",
        len(all_funcs), (time.perf_counter() - stage_start) * 1000,
    )

    # Sort before pagination for stable ordering
    all_funcs.sort(key=lambda fn: (str(fn.location.file_path), fn.location.start_line, fn.fqn))

    # Stage 3: Apply offset + limit
    limit = max_results if max_results > 0 else 0
    if offset > 0:
        all_funcs = all_funcs[offset:]
    if limit > 0:
        all_funcs = all_funcs[:limit]

    # Stage 4: Convert to output format
    results = [
        funcinfo_to_function_def_output(func, project_path, detail_level)
        for func in all_funcs
    ]

    logger.info("[realtime_get_function_by_file] 返回结果数量: %d", len(results))
    return results


@timed(logger, "realtime_analysis", "realtime_get_function_by_code")
def realtime_get_function_by_code(
    project_path: Path,
    language: str,
    code_snippet: str,
    use_regex: bool = False,
    offset: int = 0,
    max_results: int = 0,
) -> list[GetFunctionDefOutput]:
    """Realtime function-by-code lookup using ripgrep + ast-grep.

    Flow: ripgrep search → group by file → AST extract → bisect match → dedup → output.

    Args:
        max_results: Maximum results to return (0 or negative = unlimited)
    """
    if not code_snippet:
        return []

    extensions = LANGUAGE_EXTENSIONS.get(language)
    if not extensions:
        logger.warning(f"Unsupported language for realtime analysis: {language}")
        return []

    client = get_ast_client()

    # Stage 1: Ripgrep search for code snippet
    stage_start = time.perf_counter()
    rg_tool = get_ripgrep_tool()
    if rg_tool is None:
        logger.warning("function-by-code 无可用 ripgrep，直接返回空结果")
        return []

    matches = rg_tool.search_keyword_with_line(
        project_path, code_snippet, use_regex=use_regex,
    )
    if not matches:
        return []

    # Filter matches to target language files only
    matches = [m for m in matches if any(str(m.file_path).endswith(ext) for ext in extensions)]
    if not matches:
        return []

    # Group hit lines by file
    limit = max_results if max_results > 0 else 0
    file_to_lines: dict[str, list[int]] = {}
    for m in matches:
        # Truncate to avoid excessive AST parsing
        if limit and len(file_to_lines) >= 5 * (limit + offset):
            break
        file_key = str(m.file_path)
        file_to_lines.setdefault(file_key, []).append(m.line)
    logger.info(
        "[realtime_get_function_by_code] 阶段1(ripgrep搜索): matches=%d, duration=%.1fms",
        len(matches), (time.perf_counter() - stage_start) * 1000,
    )

    # Stage 2: AST extract + bisect match per file
    stage_start = time.perf_counter()
    results: list[GetFunctionDefOutput] = []
    seen: set[tuple[str, int]] = set()
    skipped = 0

    for file_path_str, hit_lines in file_to_lines.items():
        if limit and len(results) >= limit:
            break

        abs_path = Path(file_path_str)
        if not abs_path.is_absolute():
            abs_path = (project_path / abs_path).resolve()

        try:
            funcs = client.extract_function_defs(language, abs_path, project_path)
        except Exception as e:
            logger.warning(f"Failed to extract functions from {abs_path}: {e}")
            continue

        if not funcs:
            continue

        funcs_sorted = sorted(funcs, key=lambda fn: (fn.location.start_line, fn.location.end_line, fn.fqn))
        start_lines = [fn.location.start_line for fn in funcs_sorted]

        for hit_line in sorted(hit_lines):
            if limit and len(results) >= limit:
                break

            nearest = find_nearest_function(funcs_sorted, start_lines, hit_line)
            if nearest is None:
                continue

            key = (str(nearest.location.file_path), nearest.location.start_line)
            if key in seen:
                continue
            seen.add(key)

            if skipped < offset:
                skipped += 1
                continue

            output = funcinfo_to_function_def_output(nearest, project_path, detail_level="full")
            results.append(output)

    logger.info(
        "[realtime_get_function_by_code] 阶段2(AST匹配): results=%d, duration=%.1fms",
        len(results), (time.perf_counter() - stage_start) * 1000,
    )
    logger.info("[realtime_get_function_by_code] 返回结果数量: %d", len(results))
    return results


@timed(logger, "realtime_analysis", "realtime_get_class_by_name")
def realtime_get_class_by_name(
    project_path: Path,
    language: str,
    name: str,
    class_fqn: str = "",
    include_methods: bool = False,
    use_regex: bool = False,
    offset: int = 0,
    max_results: int = 10,
) -> list[GetClassDefOutput]:
    """Realtime get_class_by_name: ripgrep pre-filter → ast-grep AST match → output.

    Args:
        project_path: Project root path
        language: "python" or "java"
        name: Class short name to search (required)
        class_fqn: Optional FQN filter for precise matching
        include_methods: Whether to include method summaries
        use_regex: Whether name is a regex pattern (default: False)
        offset: Pagination offset
        max_results: Maximum results to return (0 or negative = unlimited)
    """
    # If name is empty but class_fqn is provided, extract short name from FQN
    search_name = name
    if not search_name and class_fqn:
        search_name = class_fqn.rsplit(".", 1)[-1]

    if not search_name:
        return []

    client = get_ast_client()

    # Phase 1: ripgrep candidate file discovery
    stage_start = time.perf_counter()
    candidate_files = _find_candidate_files(project_path, search_name, language, use_regex=use_regex, context_pattern_fn=_class_pattern)
    if not candidate_files:
        return []
    logger.info(
        "[realtime_get_class_by_name] 阶段1(候选文件): files=%d, duration=%.1fms",
        len(candidate_files), (time.perf_counter() - stage_start) * 1000,
    )

    # Phase 2: ast-grep precise matching per candidate file
    stage_start = time.perf_counter()
    all_classes: list[ClassInfo] = []
    for file_path in candidate_files:
        classes = client.find_all_classes_by_name(language, file_path, search_name, project_path)
        for cls in classes:
            # Phase 3: FQN validation (if user provided class_fqn)
            if class_fqn:
                if not ParamsValidator.validate(
                    fuzzy_match=True,
                    fqn=(class_fqn, cls.fqn),
                ):
                    continue
            all_classes.append(cls)
    logger.info(
        "[realtime_get_class_by_name] 阶段2(AST匹配): classes=%d, duration=%.1fms",
        len(all_classes), (time.perf_counter() - stage_start) * 1000,
    )

    all_classes.sort(key=lambda cls: (str(cls.location.file_path), cls.location.start_line, cls.fqn))

    # Pagination
    if max_results > 0:
        paginated = all_classes[offset:offset + max_results]
    else:
        paginated = all_classes[offset:] if offset > 0 else all_classes

    # Phase 4: build output models
    results: list[GetClassDefOutput] = []
    for cls in paginated:
        output = _build_class_output(cls, project_path)

        # Strip methods if not requested
        if not include_methods:
            output.methods = []

        results.append(output)

    logger.info("[realtime_get_class_by_name] 返回结果数量: %d", len(results))
    return results


@timed(logger, "realtime_analysis", "realtime_get_function_by_name")
def realtime_get_function_by_name(
    project_path: Path,
    language: str,
    name: str,
    function_fqn: str = "",
    function_signature: str = "",
    use_regex: bool = False,
    offset: int = 0,
    max_results: int = 10,
) -> list[GetFunctionDefOutput]:
    """Realtime get_function_by_name: ripgrep pre-filter → ast-grep AST match → output.

    Args:
        project_path: Project root path
        language: "python" or "java"
        name: Function short name to search (required)
        function_fqn: Optional FQN filter for precise matching
        function_signature: Optional signature filter
        use_regex: Whether name is a regex pattern (default: False)
        offset: Pagination offset
        max_results: Maximum results to return (0 or negative = unlimited)
    """
    # If name is empty but function_fqn is provided, extract short name from FQN
    search_name = name
    if not search_name and function_fqn:
        search_name = function_fqn.rsplit(".", 1)[-1]

    if not search_name:
        return []

    client = get_ast_client()

    # Phase 1: ripgrep candidate file discovery
    stage_start = time.perf_counter()
    candidate_files = _find_candidate_files(project_path, search_name, language, use_regex=use_regex, context_pattern_fn=_function_pattern)
    if not candidate_files:
        return []
    logger.info(
        "[realtime_get_function_by_name] 阶段1(候选文件): files=%d, duration=%.1fms",
        len(candidate_files), (time.perf_counter() - stage_start) * 1000,
    )

    # Phase 2: extract candidate functions from files
    stage_start = time.perf_counter()
    # - regex mode: extract ALL functions, filter by regex on short name
    # - exact mode: use AST pattern matching to find by literal name
    name_re = re.compile(search_name) if use_regex else None
    all_funcs: list[FuncInfo] = []
    for file_path in candidate_files:
        if use_regex:
            funcs = client.extract_function_defs(language, file_path, project_path)
        else:
            funcs = client.find_functions_by_name(language, file_path, search_name, project_path)

        for func in funcs:
            # Name regex filter (only for regex mode; exact mode already filtered by AST)
            if name_re:
                short_name = func.name or (func.fqn.rsplit(".", 1)[-1] if func.fqn else "")
                if not name_re.search(short_name):
                    continue

            # FQN + signature validation
            if not ParamsValidator.validate(
                fuzzy_match=True,
                fqn=(function_fqn, func.fqn),
                signature=(function_signature, func.signature),
            ):
                continue

            all_funcs.append(func)
    logger.info(
        "[realtime_get_function_by_name] 阶段2(AST提取): functions=%d, duration=%.1fms",
        len(all_funcs), (time.perf_counter() - stage_start) * 1000,
    )

    all_funcs.sort(key=lambda fn: (str(fn.location.file_path), fn.location.start_line, fn.fqn))

    all_funcs.sort(key=lambda fn: (str(fn.location.file_path), fn.location.start_line, fn.fqn))

    # Pagination
    if max_results > 0:
        paginated = all_funcs[offset:offset + max_results]
    else:
        paginated = all_funcs[offset:] if offset > 0 else all_funcs

    # Phase 4: build output models with annotations and content
    results: list[GetFunctionDefOutput] = []
    for func in paginated:
        output = funcinfo_to_function_def_output(func, project_path)
        results.append(output)

    logger.info("[realtime_get_function_by_name] 返回结果数量: %d", len(results))
    return results


# ── Entry Points (Python only) ────────────────────────────────────────

# Combined regex patterns for entry point detection
_ENTRYPOINT_PATTERNS = [
    r'if\s+__name__\s*==\s*["\x27]__main__["\x27]',
    r'@(app|blueprint)\.(route|get|post|put|delete)',
    r'@(celery\.task|shared_task)',
    r'@click\.(command|group)',
    r'@(app|router)\.(get|post|put|delete|patch)',
]

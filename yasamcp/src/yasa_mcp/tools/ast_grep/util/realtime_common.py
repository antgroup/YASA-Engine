"""Shared utilities for realtime analysis modules.

Common constants, singletons, and conversion helpers used across
service.realtime.realtime_code_search_service and service.realtime.realtime_callgraph_service.
"""

import bisect
import logging
from pathlib import Path

from yasa_mcp.service.models import (
    GetFunctionDefOutput,
    Location,
    ParameterAnnotation,
)
from yasa_mcp.core.enums import Tool
from yasa_mcp.core.runtime import get_runtime
from yasa_mcp.tools.ast_grep.ast.ast_grep_module import FuncInfo, Location as AstLocation
from yasa_mcp.tools.ast_grep.search.client import AstSearchClient
from yasa_mcp.tools.ripgrep.ripgrep_tool import RipgrepTool
from yasa_mcp.util import file_util
from yasa_mcp.util.extract_annotation_util import extract_annotations

logger = logging.getLogger(__name__)

# ── Constants ──────────────────────────────────────────────────────────────────

# Test directory path components to exclude from results.
# Matches are filtered by checking if any path component (relative to project root)
# is one of these names, to align with DuckDB which only indexes production code.
TEST_DIR_NAMES: set[str] = {"test", "tests", "Test"}

# Language → file extensions mapping
LANGUAGE_EXTENSIONS: dict[str, tuple[str, ...]] = {
    "java": (".java",),
    "python": (".py",),
    "javascript": (".js", ".ts"),
}

# Language → ripgrep type filter mapping
LANGUAGE_RG_TYPES: dict[str, str] = {
    "python": "py",
    "java": "java",
    "javascript": "js",
}


# ── Singletons ─────────────────────────────────────────────────────────────────

_ast_client: AstSearchClient | None = None


def get_ast_client() -> AstSearchClient:
    """Get or create the module-level AstSearchClient singleton."""
    global _ast_client
    if _ast_client is None:
        _ast_client = AstSearchClient()
    return _ast_client


def get_ripgrep_tool() -> RipgrepTool | None:
    """Get RipgrepTool from global YasaMcpRuntime singleton."""
    runtime = get_runtime()
    if runtime is None:
        return None
    return runtime.get_tool(Tool.RIPGREP)


# ── Path helpers ───────────────────────────────────────────────────────────────


def is_test_path(file_path: Path, project_path: Path) -> bool:
    """Check if a file path is inside a test directory relative to the project root."""
    try:
        rel = file_path.relative_to(project_path)
    except ValueError:
        return False
    return bool(TEST_DIR_NAMES & set(rel.parts))


# ── Location conversion ───────────────────────────────────────────────────────


def ast_location_to_service_location(loc: AstLocation) -> Location:
    """Convert ast_grep_module.Location (dataclass) → service.models.Location (Pydantic)."""
    return Location(
        file_path=loc.file_path,
        start_line=loc.start_line,
        start_column=loc.start_column,
        end_line=loc.end_line,
        end_column=loc.end_column,
    )


# ── FuncInfo → GetFunctionDefOutput ────────────────────────────────────────────


def funcinfo_to_function_def_output(
    func: FuncInfo,
    project_path: Path,
    detail_level: str = "full",
) -> GetFunctionDefOutput:
    """Convert ast-grep FuncInfo to service GetFunctionDefOutput.

    Args:
        func: Internal FuncInfo from AST parsing.
        project_path: Project root path (used to relativize file paths).
        detail_level: "summary" skips content, "full" includes it.
    """
    # Ensure file_path is relative to project_path (DuckDB stores relative paths)
    raw_path = func.location.file_path
    if raw_path.is_absolute():
        try:
            rel_path = raw_path.relative_to(project_path)
        except ValueError:
            rel_path = raw_path
    else:
        rel_path = raw_path

    location = Location(
        file_path=rel_path,
        start_line=func.location.start_line,
        start_column=func.location.start_column,
        end_line=func.location.end_line,
        end_column=func.location.end_column,
    )

    content = ""
    if detail_level == "full":
        content = func.content or file_util.get_file_content_by_location(
            project_path, location
        )

    # Extract annotations from source file (supplements AST-extracted ones)
    f_annos, p_annos = extract_annotations(
        project_path,
        location.file_path,
        location.start_line,
        content or func.content,
    )

    # Merge AST-extracted annotations with file-extracted ones (dedup)
    if func.annotations:
        for ann in func.annotations:
            if ann not in f_annos:
                f_annos.append(ann)

    # Convert parameter annotations: FuncInfo uses list[dict] with "annotation"/"parameter_name" keys
    if func.parameter_annotations and not p_annos:
        p_annos = [
            ParameterAnnotation(
                annotation=pa.get("annotation", ""),
                parameter_name=pa.get("parameter_name", ""),
            )
            for pa in func.parameter_annotations
        ]

    return GetFunctionDefOutput(
        function_fqn=func.fqn,
        function_signature=func.signature,
        file_path=location.file_path.as_posix(),
        location=location,
        content=content,
        function_annotations=f_annos,
        parameter_annotations=p_annos,
    )


# ── Bisect-based function locator ──────────────────────────────────────────────


def find_nearest_function(
    funcs_sorted: list[FuncInfo],
    start_lines: list[int],
    hit_line: int,
    max_distance: int = 3,
    prefer_outermost: bool = False,
) -> FuncInfo | None:
    """Find the function that contains or is nearest to the hit_line.

    Uses bisect_right for O(log n) lookup on the sorted start_lines.
    When prefer_outermost=True, returns the outermost enclosing function (for caller context).
    When prefer_outermost=False (default), returns the innermost enclosing function.
    """
    idx = bisect.bisect_right(start_lines, hit_line)

    # Check backwards for enclosing functions
    enclosing = None
    for i in range(idx - 1, -1, -1):
        func = funcs_sorted[i]
        if func.location.start_line <= hit_line <= func.location.end_line:
            if prefer_outermost:
                # Keep looking for an even outer enclosing function
                enclosing = func
            else:
                # Return the first (innermost) match immediately
                return func
        elif enclosing is not None:
            break
    if enclosing:
        return enclosing

    # Fallback: find nearest function within max_distance
    best_func = None
    best_distance = float("inf")

    if idx > 0:
        func = funcs_sorted[idx - 1]
        dist = hit_line - func.location.end_line
        if 0 < dist <= max_distance and dist < best_distance:
            best_distance = dist
            best_func = func

    if idx < len(funcs_sorted):
        func = funcs_sorted[idx]
        dist = func.location.start_line - hit_line
        if 0 < dist <= max_distance and dist < best_distance:
            best_func = func

    return best_func


# ── Ripgrep file search ───────────────────────────────────────────────────────


def ripgrep_search_files(
    project_path: Path,
    pattern: str,
    language: str,
    exclude_tests: bool = True,
) -> list[Path]:
    """Use ripgrep to find files containing a pattern.

    Returns deduplicated list of file paths filtered by language suffix.
    Falls back to empty list if ripgrep is unavailable.
    """
    rg_tool = get_ripgrep_tool()
    if rg_tool is None:
        return []

    extensions = LANGUAGE_EXTENSIONS.get(language)
    if not extensions:
        logger.warning(f"Unsupported language for ripgrep file filtering: {language}")
        return []

    try:
        hits = rg_tool.search_keyword_with_line(
            project_path, pattern, use_regex=True, timeout=30,
        )
        seen: set[Path] = set()
        result: list[Path] = []
        for hit in hits:
            fp = hit.file_path
            if fp in seen:
                continue
            if not any(str(fp).endswith(ext) for ext in extensions):
                continue
            if exclude_tests and is_test_path(fp, project_path):
                continue
            seen.add(fp)
            result.append(fp)
        return result
    except Exception as e:
        logger.warning(f"Ripgrep search failed for pattern '{pattern}': {e}")
        return []

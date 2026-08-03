"""Search Java method bodies with a regular-expression pattern."""

from __future__ import annotations

import logging
import os
import re
from bisect import bisect_right
from typing import Any

from yasa_mcp.registry import mcp_tool
from yasa_mcp.tools.search_code_by_signature_pattern import (
    _CONTROL_FLOW_KEYWORDS,
    _EXCLUDED_DIRS,
    _MAX_RESULTS_LIMIT,
    _MODIFIERS,
    _build_class_ranges_by_depth,
    _compute_brace_metadata,
    _compute_line_depths,
    _extract_package,
    _is_binary,
    _prepare_java_source,
)

logger = logging.getLogger("yasa_mcp.tools.search_code_by_body_pattern")

_CONTEXT_LINES = 2
_METHOD_NAME = re.compile(r"([A-Za-z_$][\w$]*)\s*$")
_METHOD_TAIL = re.compile(
    r"\s*(?:throws\s+[A-Za-z_$][\w$.,<>?\[\]\s&]*)?\s*$"
)
_DECLARATION_KEYWORDS = frozenset({
    "class", "interface", "enum", "record", "package", "import",
})


def _line_starts(content: str) -> list[int]:
    starts = [0]
    starts.extend(match.end() for match in re.finditer("\n", content))
    return starts


def _offset_to_line(offset: int, starts: list[int]) -> int:
    return bisect_right(starts, offset) - 1


def _contains_top_level_token(content: str, token: str) -> bool:
    """Return whether token occurs outside (), [], or <> in a declaration."""
    paren = 0
    bracket = 0
    angle = 0
    i = 0
    while i < len(content):
        ch = content[i]
        if ch == "(":
            paren += 1
        elif ch == ")":
            paren = max(0, paren - 1)
        elif ch == "[":
            bracket += 1
        elif ch == "]":
            bracket = max(0, bracket - 1)
        elif ch == "<":
            angle += 1
        elif ch == ">":
            angle = max(0, angle - 1)
        elif paren == 0 and bracket == 0 and angle == 0:
            if content.startswith(token, i):
                return True
        i += 1
    return False


def _find_parameter_open(header: str, close_pos: int) -> int | None:
    depth = 0
    for i in range(close_pos, -1, -1):
        if header[i] == ")":
            depth += 1
        elif header[i] == "(":
            depth -= 1
            if depth == 0:
                return i
    return None


def _declaration_start(header: str, absolute_start: int, name_pos: int) -> int:
    """Skip blank and annotation-only lines when reporting method start."""
    cursor = 0
    for line in header[:name_pos].splitlines(keepends=True):
        stripped = line.strip()
        if stripped and not stripped.startswith("@"):
            return absolute_start + cursor + len(line) - len(line.lstrip())
        cursor += len(line)

    leading = len(header) - len(header.lstrip())
    return absolute_start + leading


def _parse_method_header(
    header: str,
    absolute_start: int,
    containing_class: str,
) -> dict[str, Any] | None:
    """Parse a possibly multiline Java method header ending before ``{``."""
    close_pos = header.rfind(")")
    while close_pos >= 0 and not _METHOD_TAIL.fullmatch(header[close_pos + 1:]):
        close_pos = header.rfind(")", 0, close_pos)
    if close_pos < 0:
        return None

    open_pos = _find_parameter_open(header, close_pos)
    if open_pos is None:
        return None

    name_match = _METHOD_NAME.search(header[:open_pos])
    if name_match is None:
        return None

    method_name = name_match.group(1)
    prefix = header[:name_match.start(1)]
    prefix_without_annotations = re.sub(r"@[A-Za-z_$][\w$.]*\s*", "", prefix)
    prefix_tokens = re.findall(r"[A-Za-z_$][\w$-]*", prefix_without_annotations)

    if method_name in _CONTROL_FLOW_KEYWORDS or method_name in _DECLARATION_KEYWORDS:
        return None
    if prefix.rstrip().endswith("."):
        return None
    if _contains_top_level_token(prefix, "=") or _contains_top_level_token(prefix, "->"):
        return None
    if "new" in prefix_tokens:
        return None

    class_name = containing_class.rsplit(".", 1)[-1]
    non_modifier_tokens = [token for token in prefix_tokens if token not in _MODIFIERS]
    if not non_modifier_tokens and method_name != class_name:
        # A declaration without a return type is valid only for constructors.
        return None

    return {
        "method_name": method_name,
        "declaration_start": _declaration_start(
            header, absolute_start, name_match.start(1)
        ),
    }


def _select_containing_class(
    opening: int,
    opening_depth: int,
    line_index: int,
    class_info: list[tuple[int, int, str]],
    depths: list[int],
) -> tuple[int, int, str] | None:
    candidates = [
        item for item in class_info
        if item[0] <= line_index <= item[1]
        and opening_depth == depths[item[0]] + 1
    ]
    if not candidates:
        return None
    return max(candidates, key=lambda item: (depths[item[0]], item[0]))


def _extract_method_ranges(
    lines: list[str],
    depths: list[int],
    class_info: list[tuple[int, int, str]],
    package: str | None,
    structural_content: str | None = None,
    brace_metadata: tuple[dict[int, int], dict[int, int], dict[int, int]] | None = None,
    line_starts: list[int] | None = None,
) -> list[dict[str, Any]]:
    """Locate class-body-level methods and return exact body ranges."""
    del package  # Class names in class_info are already fully qualified.
    structural = structural_content if structural_content is not None else "\n".join(lines)
    if brace_metadata is None:
        pairs, open_depths, header_starts = _compute_brace_metadata(structural)
    else:
        pairs, open_depths, header_starts = brace_metadata
    starts = line_starts if line_starts is not None else _line_starts(structural)
    methods: list[dict[str, Any]] = []

    for opening in sorted(open_depths):
        closing = pairs.get(opening)
        if closing is None:
            continue

        line_index = _offset_to_line(opening, starts)
        containing_class = _select_containing_class(
            opening,
            open_depths[opening],
            line_index,
            class_info,
            depths,
        )
        if containing_class is None:
            continue

        header_start = header_starts[opening]
        parsed = _parse_method_header(
            structural[header_start:opening],
            header_start,
            containing_class[2],
        )
        if parsed is None:
            continue

        start_line = _offset_to_line(parsed["declaration_start"], starts)
        end_line = _offset_to_line(closing, starts)
        methods.append({
            "method_name": parsed["method_name"],
            "start_line": start_line,
            "end_line": end_line,
            "body_start": opening + 1,
            "body_end": closing,
            "containing_class": containing_class[2],
            "containing_method": f"{containing_class[2]}.{parsed['method_name']}",
            "method_depth": open_depths[opening],
        })

    return methods


def _search_method_body(
    searchable_content: str,
    original_content: str,
    original_lines: list[str],
    starts: list[int],
    method: dict[str, Any],
    user_pattern: re.Pattern[str],
    max_results: int,
    results: list[dict[str, Any]],
    rel_path: str,
) -> int:
    """Search one exact method-body interval and append structured matches."""
    body_start = method["body_start"]
    body_end = method["body_end"]
    body_text = searchable_content[body_start:body_end]
    added = 0

    for match in user_pattern.finditer(body_text):
        absolute_start = body_start + match.start()
        absolute_end = body_start + match.end()
        match_line = _offset_to_line(absolute_start, starts)
        snippet = original_content[absolute_start:absolute_end]
        if len(snippet) > 200:
            snippet = snippet[:200] + "..."

        context_start = max(0, match_line - _CONTEXT_LINES)
        context_end = min(len(original_lines), match_line + _CONTEXT_LINES + 1)
        context = []
        for line_number in range(context_start, context_end):
            marker = ">>> " if line_number == match_line else ""
            context.append(marker + original_lines[line_number].rstrip())

        results.append({
            "file_path": rel_path,
            "containing_method": method["containing_method"],
            "method_start_line": method["start_line"] + 1,
            "method_end_line": method["end_line"] + 1,
            "match_line": match_line + 1,
            "match_snippet": snippet.strip(),
            "snippet_with_context": "\n".join(context),
        })
        added += 1
        if len(results) >= max_results:
            break

    return added


def _parse_and_search_file(
    filepath: str,
    repo_root: str,
    user_pattern: re.Pattern[str],
    max_results: int,
    results: list[dict[str, Any]],
) -> int:
    try:
        with open(filepath, "r", encoding="utf-8", errors="replace") as source:
            content = source.read()
    except OSError:
        return 0

    without_comments, structural = _prepare_java_source(content)
    structural_lines = structural.split("\n")
    depths = _compute_line_depths(structural_lines)
    package = _extract_package(structural)
    starts = _line_starts(structural)
    brace_metadata = _compute_brace_metadata(structural)
    class_info = _build_class_ranges_by_depth(
        structural_lines,
        depths,
        package,
        structural,
        brace_metadata,
        starts,
    )
    methods = _extract_method_ranges(
        structural_lines,
        depths,
        class_info,
        package,
        structural,
        brace_metadata,
        starts,
    )
    original_lines = content.splitlines()
    rel_path = os.path.relpath(filepath, repo_root).replace(os.sep, "/")

    added = 0
    for method in methods:
        if len(results) >= max_results:
            break
        added += _search_method_body(
            without_comments,
            content,
            original_lines,
            starts,
            method,
            user_pattern,
            max_results,
            results,
            rel_path,
        )
    return added


def _is_within(root: str, candidate: str) -> bool:
    try:
        return os.path.commonpath([root, candidate]) == root
    except ValueError:
        return False


def _empty_result(pattern: str, error: str | None = None) -> dict[str, Any]:
    result: dict[str, Any] = {
        "pattern": pattern,
        "total_matches": 0,
        "results": [],
    }
    if error is not None:
        result["error"] = error
    return result


@mcp_tool(
    name="search_code_by_body_pattern",
    description=(
        "Search for a regex pattern within Java method bodies and return each "
        "match with its containing method's fully qualified name and source range."
    ),
)
async def search_code_by_body_pattern(
    pattern: str,
    repository_path: str,
    path_prefix: str = "",
    language: str = "java",
    multi_line: bool = True,
    max_results: int = 100,
) -> dict[str, Any]:
    """Search Java method bodies for a regular-expression pattern."""
    if not pattern:
        return _empty_result("")
    if language.lower() != "java":
        return _empty_result(pattern, f"Unsupported language: {language}")
    if not repository_path or not os.path.isabs(repository_path):
        return _empty_result(pattern, "repository_path must be an absolute path")

    repo_root = os.path.realpath(repository_path)
    if not os.path.isdir(repo_root):
        return _empty_result(pattern, "repository_path does not exist")

    try:
        max_results = min(max(int(max_results), 1), _MAX_RESULTS_LIMIT)
    except (TypeError, ValueError):
        return _empty_result(pattern, "max_results must be an integer")

    flags = re.MULTILINE | (re.DOTALL if multi_line else 0)
    try:
        user_pattern = re.compile(pattern, flags)
    except re.error as error:
        return _empty_result(pattern, f"Invalid regex pattern: {error}")

    search_root = os.path.realpath(os.path.join(repo_root, path_prefix))
    if not _is_within(repo_root, search_root):
        return _empty_result(pattern, "path_prefix must stay within repository_path")
    if not os.path.isdir(search_root):
        return _empty_result(pattern, "path_prefix does not exist")

    results: list[dict[str, Any]] = []
    for dirpath, dirnames, filenames in os.walk(search_root):
        dirnames[:] = sorted(
            directory for directory in dirnames
            if directory not in _EXCLUDED_DIRS
        )
        for filename in sorted(filenames):
            if len(results) >= max_results:
                break
            if not filename.endswith(".java"):
                continue

            filepath = os.path.join(dirpath, filename)
            real_filepath = os.path.realpath(filepath)
            if not _is_within(repo_root, real_filepath) or _is_binary(filepath):
                continue
            _parse_and_search_file(
                filepath,
                repo_root,
                user_pattern,
                max_results,
                results,
            )
        if len(results) >= max_results:
            break

    logger.info(
        "search_code_by_body_pattern: pattern=%r, repo=%s, matches=%d",
        pattern,
        repo_root,
        len(results),
    )
    return {
        "pattern": pattern,
        "total_matches": len(results),
        "results": results,
    }

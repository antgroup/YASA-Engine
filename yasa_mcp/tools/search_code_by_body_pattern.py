"""
MCP Tool: search_code_by_body_pattern

在方法体内按正则模式匹配代码片段, 命中后返回所在方法的全限定名。
与签名级搜索的核心区别: 知道"命中点属于哪个方法"。

实现方式: 复用 #134 的 O(n) 花括号深度状态机确定方法体边界,
在方法体内逐行 (或整体) 做 re.search 匹配。

典型用例:
- 找所有调用了 ``Runtime.exec(...)`` 的方法
- 找所有 catch 了异常但只打 log 没 rethrow 的方法
- 找所有读取 ``request.getParameter`` 后直接拼到 SQL 的方法
"""

from __future__ import annotations

import os
import re
import logging
from typing import Any

from yasa_mcp.registry import mcp_tool
# 复用 #134 的核心组件
from yasa_mcp.tools.search_code_by_signature_pattern import (
    _EXCLUDED_DIRS,
    _CLASS_PATTERN,
    _METHOD_LINE_PATTERN,
    _CONTROL_FLOW_KEYWORDS,
    _MODIFIERS,
    _strip_comments,
    _is_binary,
    _extract_package,
    _compute_line_depths,
    _build_class_ranges_by_depth,
)

logger = logging.getLogger("yasa_mcp.tools.search_code_by_body_pattern")

# 上下文行数 (snippet_with_context 中命中行前后各取几行)
_CONTEXT_LINES = 2

# max_results 上限
_MAX_RESULTS_LIMIT = 1000


# ---------------------------------------------------------------------------
# 方法体范围提取
# ---------------------------------------------------------------------------

def _extract_method_ranges(
    lines: list[str],
    depths: list[int],
    class_info: list[tuple[int, int, str]],
    package: str | None,
) -> list[dict[str, Any]]:
    """
    利用预计算的 depth 数组, 定位所有**类体级别**的方法定义及其方法体范围。

    只识别类体级别 (depth = class_body_depth) 的方法定义,
    忽略方法体内嵌套的 lambda / 匿名类方法声明。

    返回列表, 每个元素:
        method_name, start_line (0-based), end_line (0-based),
        containing_class, method_depth
    """
    methods: list[dict[str, Any]] = []

    for i, line in enumerate(lines):
        m = _METHOD_LINE_PATTERN.search(line)
        if not m:
            continue

        method_name = m.group(1)

        # 跳过控制流关键字
        if method_name in _CONTROL_FLOW_KEYWORDS:
            continue

        # 跳过返回类型以控制流关键字开头的情况
        name_pos = m.start(1)
        prefix = line[:name_pos].strip()
        tokens = prefix.split()
        non_anno_tokens = [t for t in tokens if not t.startswith("@")]
        ret_type_tokens = [t for t in non_anno_tokens if t not in _MODIFIERS]
        ret_type = " ".join(ret_type_tokens) if ret_type_tokens else ""
        if ret_type and ret_type.split()[0] in _CONTROL_FLOW_KEYWORDS:
            continue

        # 只接受有方法体的方法 (group(3) == "{"), 跳过抽象方法/接口声明 (;)
        if m.group(3) != "{":
            continue

        method_depth = depths[i]

        # 确定方法体结束行: depth 回落到 method_depth 的行
        end_line = len(lines) - 1
        for j in range(i + 1, len(lines)):
            if depths[j] <= method_depth:
                end_line = j
                break

        # 查找所属类
        containing_class = ""
        for cls_start, cls_end, cls_full_name in class_info:
            if cls_start < i < cls_end:
                containing_class = cls_full_name
                break

        # 构建 containing_method 全限定名
        if containing_class:
            containing_method = f"{containing_class}.{method_name}"
        else:
            containing_method = method_name

        methods.append({
            "method_name": method_name,
            "start_line": i,       # 方法声明行 (0-based)
            "end_line": end_line,   # 方法体结束 } 行 (0-based)
            "containing_class": containing_class,
            "containing_method": containing_method,
            "method_depth": method_depth,
        })

    return methods


# ---------------------------------------------------------------------------
# 方法体内搜索
# ---------------------------------------------------------------------------

def _search_method_body(
    lines: list[str],
    method: dict[str, Any],
    user_pattern: re.Pattern,
    max_results: int,
    results: list[dict[str, Any]],
    rel_path: str,
) -> int:
    """
    在单个方法体内搜索 pattern, 将结果追加到 results。
    返回本次新增的匹配数。
    """
    start = method["start_line"]
    end = method["end_line"]
    containing_method = method["containing_method"]

    # 方法体行范围: start+1 到 end-1 (跳过方法声明行和结束 })
    body_lines = lines[start + 1: end]
    if not body_lines:
        return 0

    body_text = "\n".join(body_lines)
    added = 0

    for m in user_pattern.finditer(body_text):
        # 计算匹配在 body_text 中的行偏移
        match_offset_in_body = m.start()
        body_line_offset = body_text[:match_offset_in_body].count("\n")
        match_line = start + 1 + body_line_offset  # 0-based

        # 匹配的文本片段
        match_snippet = m.group(0)
        # 清理多余空白
        if len(match_snippet) > 200:
            match_snippet = match_snippet[:200] + "..."

        # 构建 snippet_with_context (命中行前后 _CONTEXT_LINES 行)
        ctx_start = max(0, match_line - _CONTEXT_LINES)
        ctx_end = min(len(lines), match_line + _CONTEXT_LINES + 1)
        context_lines = []
        for j in range(ctx_start, ctx_end):
            ctx_line = lines[j].rstrip()
            if j == match_line:
                ctx_line = ">>> " + ctx_line
            context_lines.append(ctx_line)
        snippet_with_context = "\n".join(context_lines)

        results.append({
            "file_path": rel_path,
            "containing_method": containing_method,
            "method_start_line": start + 1,  # 1-based
            "method_end_line": end + 1,       # 1-based
            "match_line": match_line + 1,     # 1-based
            "match_snippet": match_snippet.strip(),
            "snippet_with_context": snippet_with_context,
        })
        added += 1

        if len(results) >= max_results:
            return added

    return added


# ---------------------------------------------------------------------------
# 文件解析
# ---------------------------------------------------------------------------

def _parse_and_search_file(
    filepath: str,
    repo_root: str,
    user_pattern: re.Pattern,
    max_results: int,
    results: list[dict[str, Any]],
) -> int:
    """
    解析单个 Java 文件, 提取方法体范围, 在方法体内搜索 pattern。
    """
    try:
        with open(filepath, "r", encoding="utf-8", errors="replace") as f:
            content = f.read()
    except (OSError, IOError):
        return 0

    stripped = _strip_comments(content)
    lines = stripped.split("\n")
    rel_path = os.path.relpath(filepath, repo_root)
    package = _extract_package(stripped)

    # O(n) 一次遍历计算花括号深度
    depths = _compute_line_depths(lines)

    # 确定类范围
    class_info = _build_class_ranges_by_depth(lines, depths, package)

    # 定位所有类体级别的方法
    methods = _extract_method_ranges(lines, depths, class_info, package)

    added = 0
    for method in methods:
        if len(results) >= max_results:
            break
        added += _search_method_body(
            lines, method, user_pattern, max_results, results, rel_path
        )

    return added


# ---------------------------------------------------------------------------
# MCP Tool
# ---------------------------------------------------------------------------

@mcp_tool(
    name="search_code_by_body_pattern",
    description=(
        "Search for a regex pattern within method bodies in a Java repository. "
        "Returns matches with their containing method's fully qualified name, "
        "method line range, and code snippet with context. "
        "Supports multi-line matching by default."
    ),
)
async def search_code_by_body_pattern(
    pattern: str,
    repository_path: str,
    path_prefix: str = "",
    language: str = "java",
    multi_line: bool = True,
    max_results: int = 100,
) -> dict:
    """
    Search code by body pattern within method bodies.

    Matches a regex pattern against code inside method bodies, returning
    the containing method's fully qualified name and match location.

    Args:
        pattern: Regex pattern to match within method bodies,
                 e.g. ``Runtime\\s*\\.\\s*exec\\s*\\(``
        repository_path: Absolute path to the repository root
        path_prefix: Subdirectory prefix to limit search scope (e.g. "src/main/java/")
        language: Programming language (default: java)
        multi_line: If true (default), pattern can match across lines
        max_results: Maximum number of results (default 100, max 1000)
    """
    # --- 参数校验 ---
    if not pattern:
        return {"pattern": "", "total_matches": 0, "results": []}

    if not repository_path or not os.path.isdir(repository_path):
        return {"pattern": pattern, "total_matches": 0, "results": []}

    max_results = min(max(max_results, 1), _MAX_RESULTS_LIMIT)

    # --- 编译用户 pattern ---
    flags = re.MULTILINE
    if multi_line:
        flags |= re.DOTALL
    try:
        user_pattern = re.compile(pattern, flags)
    except re.error as e:
        return {
            "pattern": pattern,
            "total_matches": 0,
            "results": [],
            "error": f"Invalid regex pattern: {e}",
        }

    # --- 构建搜索根目录 ---
    search_root = repository_path
    if path_prefix:
        search_root = os.path.join(repository_path, path_prefix)
        if not os.path.isdir(search_root):
            return {"pattern": pattern, "total_matches": 0, "results": []}

    # --- 遍历 Java 文件 ---
    results: list[dict[str, Any]] = []

    for dirpath, dirnames, filenames in os.walk(search_root):
        dirnames[:] = [d for d in dirnames if d not in _EXCLUDED_DIRS]

        for filename in filenames:
            if len(results) >= max_results:
                break

            if not filename.endswith(".java"):
                continue

            filepath = os.path.join(dirpath, filename)

            if _is_binary(filepath):
                continue

            _parse_and_search_file(
                filepath, repository_path, user_pattern,
                max_results, results,
            )

        if len(results) >= max_results:
            break

    logger.info(
        "search_code_by_body_pattern: pattern=%r, repo=%s, matches=%d",
        pattern, repository_path, len(results),
    )

    return {
        "pattern": pattern,
        "total_matches": len(results),
        "results": results,
    }
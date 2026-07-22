"""
MCP Tool: search_code_by_keyword

在指定代码仓库内按关键词检索代码,支持普通字符串与正则两种模式,
返回所有命中的文件路径、行号与代码片段(含上下文行)。
"""

from __future__ import annotations

import os
import re
import logging
from typing import Any

from yasa_mcp.registry import mcp_tool

logger = logging.getLogger("yasa_mcp.tools.search_code_by_keyword")

# 默认排除的目录
_EXCLUDED_DIRS = frozenset({
    ".git", "node_modules", "target", "build", "dist",
    "__pycache__", ".venv", "venv", ".idea", ".vscode",
})

# 二进制检测:读取前 8192 字节,含 \x00 则判定为二进制
_BINARY_CHECK_SIZE = 8192

# 上下文行数
_CONTEXT_LINES = 3

# max_results 上限
_MAX_RESULTS_LIMIT = 1000


def _is_binary(filepath: str) -> bool:
    """检测文件是否为二进制文件"""
    try:
        with open(filepath, "rb") as f:
            chunk = f.read(_BINARY_CHECK_SIZE)
        return b"\x00" in chunk
    except (OSError, IOError):
        return True


def _should_exclude_dir(dirname: str) -> bool:
    """判断目录是否应该被排除"""
    return dirname in _EXCLUDED_DIRS


def _search_file(
    filepath: str,
    repo_root: str,
    pattern: re.Pattern,
    max_results: int,
    results: list[dict[str, Any]],
) -> int:
    """
    在单个文件中搜索匹配,将结果追加到 results 列表。
    返回本次新增的匹配数。
    """
    try:
        with open(filepath, "r", encoding="utf-8", errors="replace") as f:
            lines = f.readlines()
    except (OSError, IOError):
        return 0

    rel_path = os.path.relpath(filepath, repo_root)
    added = 0

    for i, line in enumerate(lines):
        # 去掉行尾换行符
        line_content = line.rstrip("\n\r")

        match = pattern.search(line_content)
        if match is None:
            continue

        # 计算上下文行
        ctx_start = max(0, i - _CONTEXT_LINES)
        ctx_end = min(len(lines), i + _CONTEXT_LINES + 1)
        context_before = [
            lines[j].rstrip("\n\r") for j in range(ctx_start, i)
        ]
        context_after = [
            lines[j].rstrip("\n\r") for j in range(i + 1, ctx_end)
        ]

        results.append({
            "file_path": rel_path,
            "line_number": i + 1,
            "column_start": match.start() + 1,
            "column_end": match.end() + 1,
            "line_content": line_content,
            "context_before": context_before,
            "context_after": context_after,
        })
        added += 1

        if len(results) >= max_results:
            return added

    return added


@mcp_tool(
    name="search_code_by_keyword",
    description=(
        "Search code by keyword in a local repository. "
        "Returns matching file paths, line numbers, and code snippets "
        "with context lines. Supports plain string and regex modes."
    ),
)
async def search_code_by_keyword(
    keyword: str,
    repository_path: str,
    path_prefix: str = "",
    is_regex: bool = False,
    max_results: int = 100,
    case_sensitive: bool = False,
) -> dict:
    """
    Search code by keyword in a local repository.

    Args:
        keyword: Search keyword (plain string or regex pattern)
        repository_path: Absolute path to the repository root
        path_prefix: Subdirectory prefix to limit search scope (e.g. "src/main/java/")
        is_regex: If true, keyword is interpreted as a regex pattern
        max_results: Maximum number of results to return (default 100, max 1000)
        case_sensitive: If true, search is case-sensitive (default false)
    """
    # 参数校验
    if not keyword:
        return {"total_matches": 0, "results": []}

    if not repository_path or not os.path.isdir(repository_path):
        return {"total_matches": 0, "results": []}

    # 限制 max_results
    max_results = min(max(max_results, 1), _MAX_RESULTS_LIMIT)

    # 构建正则
    flags = 0 if case_sensitive else re.IGNORECASE
    if is_regex:
        pattern = re.compile(keyword, flags)
    else:
        pattern = re.compile(re.escape(keyword), flags)

    # 构建搜索根目录
    search_root = repository_path
    if path_prefix:
        search_root = os.path.join(repository_path, path_prefix)
        if not os.path.isdir(search_root):
            return {"total_matches": 0, "results": []}

    results: list[dict[str, Any]] = []

    # 遍历文件
    for dirpath, dirnames, filenames in os.walk(search_root):
        # 排除目录(原地修改 dirnames 以阻止 os.walk 进入)
        dirnames[:] = [d for d in dirnames if not _should_exclude_dir(d)]

        for filename in filenames:
            if len(results) >= max_results:
                break

            filepath = os.path.join(dirpath, filename)

            # 跳过二进制文件
            if _is_binary(filepath):
                continue

            _search_file(filepath, repository_path, pattern, max_results, results)

        if len(results) >= max_results:
            break

    logger.info(
        "search_code_by_keyword: keyword=%r, repo=%s, matches=%d",
        keyword, repository_path, len(results),
    )

    return {
        "total_matches": len(results),
        "results": results,
    }
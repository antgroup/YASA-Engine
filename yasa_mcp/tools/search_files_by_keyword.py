"""
MCP Tool: search_files_by_keyword

按文件名或路径关键词在指定代码仓库内检索文件,返回命中文件的路径、
文件名、大小与语言标识,支持扩展名过滤。
"""

from __future__ import annotations

import os
import re
import logging
from typing import Any

from yasa_mcp.registry import mcp_tool

logger = logging.getLogger("yasa_mcp.tools.search_files_by_keyword")

# 默认排除的目录
_EXCLUDED_DIRS = frozenset({
    ".git", "node_modules", "target", "build", "dist",
    "__pycache__", ".venv", "venv", ".idea", ".vscode",
})

# max_results 上限
_MAX_RESULTS_LIMIT = 10000

# 扩展名 → 语言标识映射
_EXT_TO_LANGUAGE: dict[str, str] = {
    "java": "java",
    "kt": "kotlin",
    "py": "python",
    "js": "javascript",
    "ts": "typescript",
    "jsx": "javascript",
    "tsx": "typescript",
    "go": "golang",
    "php": "php",
    "c": "c",
    "cpp": "cpp",
    "h": "c",
    "hpp": "cpp",
    "rs": "rust",
    "rb": "ruby",
    "swift": "swift",
    "scala": "scala",
    "sh": "shell",
    "sql": "sql",
    "html": "html",
    "css": "css",
    "xml": "xml",
    "json": "json",
    "yaml": "yaml",
    "yml": "yaml",
    "toml": "toml",
    "md": "markdown",
    "vue": "vue",
    "dart": "dart",
    "lua": "lua",
    "r": "r",
    "pl": "perl",
    "groovy": "groovy",
    "clj": "clojure",
    "ex": "elixir",
    "exs": "elixir",
    "erl": "erlang",
    "hs": "haskell",
    "ml": "ocaml",
    "nim": "nim",
    "zig": "zig",
}


def _should_exclude_dir(dirname: str) -> bool:
    """判断目录是否应该被排除"""
    return dirname in _EXCLUDED_DIRS


def _get_language(filename: str) -> str:
    """根据文件扩展名推断语言标识"""
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    return _EXT_TO_LANGUAGE.get(ext, "unknown")


def _match_extensions(filename: str, extensions: list[str] | None) -> bool:
    """检查文件扩展名是否在指定列表中"""
    if not extensions:
        return True
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    return ext in [e.lower().lstrip(".") for e in extensions]


@mcp_tool(
    name="search_files_by_keyword",
    description=(
        "Search files by filename or path keyword in a local repository. "
        "Returns matching file paths, filenames, sizes, and language identifiers. "
        "Supports regex mode, extension filtering, and match target selection."
    ),
)
async def search_files_by_keyword(
    keyword: str,
    repository_path: str,
    is_regex: bool = False,
    match_target: str = "filename",
    extensions: list[str] | None = None,
    max_results: int = 200,
) -> dict:
    """
    Search files by filename or path keyword in a local repository.

    Args:
        keyword: File name or path keyword to search
        repository_path: Absolute path to the repository root
        is_regex: If true, keyword is interpreted as a regex pattern
        match_target: "filename" (default) to match filename only,
                      "fullpath" to match full relative path
        extensions: Limit to specific file extensions, e.g. ["java", "kt"]
        max_results: Maximum number of results to return (default 200)
    """
    # 参数校验
    if not keyword:
        return {"total_matches": 0, "results": []}

    if not repository_path or not os.path.isdir(repository_path):
        return {"total_matches": 0, "results": []}

    # 限制 max_results
    max_results = min(max(max_results, 1), _MAX_RESULTS_LIMIT)

    # 构建正则
    flags = re.IGNORECASE  # 文件名搜索默认不区分大小写
    if is_regex:
        pattern = re.compile(keyword, flags)
    else:
        pattern = re.compile(re.escape(keyword), flags)

    results: list[dict[str, Any]] = []

    for dirpath, dirnames, filenames in os.walk(repository_path):
        # 排除目录
        dirnames[:] = [d for d in dirnames if not _should_exclude_dir(d)]

        for filename in filenames:
            if len(results) >= max_results:
                break

            # 扩展名过滤
            if not _match_extensions(filename, extensions):
                continue

            # 确定匹配目标
            full_path = os.path.join(dirpath, filename)
            rel_path = os.path.relpath(full_path, repository_path)

            if match_target == "fullpath":
                match_text = rel_path
            else:
                match_text = filename

            # 匹配
            if pattern.search(match_text) is None:
                continue

            # 获取文件大小
            try:
                size_bytes = os.path.getsize(full_path)
            except OSError:
                size_bytes = 0

            results.append({
                "file_path": rel_path,
                "filename": filename,
                "size_bytes": size_bytes,
                "language": _get_language(filename),
            })

        if len(results) >= max_results:
            break

    logger.info(
        "search_files_by_keyword: keyword=%r, repo=%s, matches=%d",
        keyword, repository_path, len(results),
    )

    return {
        "total_matches": len(results),
        "results": results,
    }
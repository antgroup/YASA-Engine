"""
MCP Tool: read_file_by_path

给定文件路径, 在仓库范围内安全读取文件内容, 支持按行号区间读取大文件。
返回内容连同元数据(语言、编码、行数、是否截断)。
强制拒绝路径穿越与越界读取。
"""

from __future__ import annotations

import os
import logging
from typing import Any

from yasa_mcp.registry import mcp_tool
from yasa_mcp.errors import ValidationError

logger = logging.getLogger("yasa_mcp.tools.read_file_by_path")

# 默认最大字节数: 1MB
_DEFAULT_MAX_BYTES = 1024 * 1024

# 二进制检测: 读取前 8192 字节, 含 \x00 则判定为二进制
_BINARY_CHECK_SIZE = 8192

# 文件扩展名 → 语言映射
_LANGUAGE_MAP = {
    ".java": "java",
    ".py": "python",
    ".js": "javascript",
    ".ts": "typescript",
    ".go": "go",
    ".php": "php",
    ".c": "c",
    ".cpp": "cpp",
    ".h": "c",
    ".hpp": "cpp",
    ".cs": "csharp",
    ".rb": "ruby",
    ".rs": "rust",
    ".kt": "kotlin",
    ".scala": "scala",
    ".swift": "swift",
    ".xml": "xml",
    ".html": "html",
    ".css": "css",
    ".json": "json",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".toml": "toml",
    ".sql": "sql",
    ".sh": "shell",
    ".bash": "shell",
    ".md": "markdown",
    ".txt": "text",
    ".properties": "properties",
    ".gradle": "groovy",
    ".vue": "vue",
    ".jsx": "javascript",
    ".tsx": "typescript",
}


def _detect_language(filepath: str) -> str:
    """根据文件扩展名推断语言"""
    _, ext = os.path.splitext(filepath)
    return _LANGUAGE_MAP.get(ext.lower(), "unknown")


def _is_binary(filepath: str) -> bool:
    """检测文件是否为二进制文件"""
    try:
        with open(filepath, "rb") as f:
            chunk = f.read(_BINARY_CHECK_SIZE)
        return b"\x00" in chunk
    except (OSError, IOError):
        return True


def _is_path_safe(file_path: str, repository_path: str) -> bool:
    """
    检查文件路径是否安全:
    1. 解析为绝对路径 (消除 .., 符号链接等)
    2. 检查是否在 repository_path 内
    """
    repo_real = os.path.realpath(repository_path)
    file_real = os.path.realpath(file_path)

    # 检查文件是否在仓库目录内
    if not file_real.startswith(repo_real + os.sep) and file_real != repo_real:
        return False

    return True


def _detect_encoding(filepath: str) -> str:
    """检测文件编码 (简化版: 尝试 utf-8, 失败则返回 latin-1)"""
    try:
        with open(filepath, "r", encoding="utf-8") as f:
            f.read(1024)
        return "utf-8"
    except (UnicodeDecodeError, OSError):
        return "latin-1"


@mcp_tool(
    name="read_file_by_path",
    description=(
        "Read file content by path within a repository. "
        "Supports line range reading, binary file detection, "
        "path traversal protection, and size truncation. "
        "Returns content with metadata (language, encoding, line count)."
    ),
)
async def read_file_by_path(
    file_path: str,
    repository_path: str,
    start_line: int | None = None,
    end_line: int | None = None,
    max_bytes: int = _DEFAULT_MAX_BYTES,
) -> dict:
    """
    Read file content by path within a repository.

    Args:
        file_path: File path (relative to repository or absolute),
                   must be within repository_path
        repository_path: Absolute path to the repository root
        start_line: Start line number (1-based), if not specified read from beginning
        end_line: End line number (1-based, inclusive), if not specified read to end
        max_bytes: Maximum bytes to return (default 1MB, truncated if exceeded)
    """
    # --- 参数校验 ---
    if not file_path:
        return {"error": "file_path is required"}

    if not repository_path or not os.path.isdir(repository_path):
        return {"error": "Invalid repository_path"}

    # --- 构建绝对路径 ---
    if os.path.isabs(file_path):
        abs_file_path = file_path
    else:
        abs_file_path = os.path.join(repository_path, file_path)

    # --- 路径安全检查 ---
    if not _is_path_safe(abs_file_path, repository_path):
        return {
            "error": "Path traversal detected: file_path must be within repository_path",
            "file_path": file_path,
        }

    # --- 文件存在性检查 ---
    if not os.path.isfile(abs_file_path):
        return {
            "error": f"File not found: {file_path}",
            "file_path": file_path,
        }

    # --- 二进制文件检测 ---
    if _is_binary(abs_file_path):
        return {
            "error": "Binary file detected, cannot read as text",
            "file_path": file_path,
        }

    # --- 读取文件 ---
    encoding = _detect_encoding(abs_file_path)
    try:
        with open(abs_file_path, "r", encoding=encoding, errors="replace") as f:
            all_lines = f.readlines()
    except (OSError, IOError) as e:
        return {
            "error": f"Failed to read file: {e}",
            "file_path": file_path,
        }

    total_lines = len(all_lines)

    # --- 行号区间处理 ---
    if start_line is None:
        start_line = 1
    if end_line is None:
        end_line = total_lines

    # Clamp 行号
    start_line = max(1, min(start_line, total_lines))
    end_line = max(start_line, min(end_line, total_lines))

    # 提取指定行范围 (1-based → 0-based)
    selected_lines = all_lines[start_line - 1: end_line]
    content = "".join(selected_lines)

    # --- 字节截断 ---
    size_bytes = len(content.encode("utf-8", errors="replace"))
    truncated = False

    if size_bytes > max_bytes:
        # 按字节截断, 尽量不截断到 UTF-8 字符中间
        content_bytes = content.encode("utf-8", errors="replace")[:max_bytes]
        content = content_bytes.decode("utf-8", errors="replace")
        truncated = True
        size_bytes = len(content_bytes)

    # 计算实际返回的行数
    returned_line_count = content.count("\n") + (1 if content and not content.endswith("\n") else 0)
    if content == "":
        returned_line_count = 0

    # 计算相对路径
    rel_path = os.path.relpath(abs_file_path, repository_path)

    logger.info(
        "read_file_by_path: file=%s, lines=%d-%d/%d, bytes=%d, truncated=%s",
        rel_path, start_line, end_line, total_lines, size_bytes, truncated,
    )

    return {
        "file_path": rel_path,
        "language": _detect_language(abs_file_path),
        "encoding": encoding,
        "total_lines": total_lines,
        "returned_lines": {"start": start_line, "end": end_line},
        "size_bytes": size_bytes,
        "content": content,
        "truncated": truncated,
    }
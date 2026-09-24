from __future__ import annotations

import logging
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from ast_grep_py import SgRoot

from yasa_mcp.tools.ast_grep.ast.ast_grep_module import FuncInfo
from yasa_mcp.tools.ast_grep.ast.ast_parser import parse_file

logger = logging.getLogger(__name__)


class ParseSessionCache:
    """请求级 AST 解析缓存。

    生命周期 = 单次 realtime 函数调用。在一次 callgraph 展开中，
    同一文件可能被多次引用（如解析 caller 函数、解析 callee 定义），
    本缓存确保每个文件只被解析一次。

    不是线程安全的（设计为单请求单线程使用）。
    """

    def __init__(self):
        self._sg_roots: dict[tuple[Path, str], object] = {}  # (file_path, language) → SgRoot | None
        self._func_defs: dict[tuple[Path, str], list[FuncInfo]] = {}  # (file_path, language) → [FuncInfo]
        self._java_imports: dict[Path, dict[str, str]] = {}  # file_path → {simple_name: fqcn}
        self._file_contents: dict[Path, str | None] = {}  # file_path → content
        self._parse_count = 0
        self._cache_hit_count = 0

    def get_sg_root(self, file_path: Path, language: str) -> SgRoot | None:
        """获取或缓存 AST 解析结果。"""
        key = (file_path, language)
        if key in self._sg_roots:
            self._cache_hit_count += 1
            return self._sg_roots[key]
        self._parse_count += 1
        result = parse_file(file_path, language)
        self._sg_roots[key] = result
        return result

    def get_func_defs(self, file_path: Path, language: str, project_path: Path) -> list[FuncInfo]:
        """获取或缓存文件的所有函数定义。"""
        key = (file_path, language)
        if key in self._func_defs:
            return self._func_defs[key]
        from yasa_mcp.tools.ast_grep.util.realtime_common import get_ast_client
        search = get_ast_client().get_search(language)
        if search is None:
            return []
        funcs = search.extract_function_defs(file_path, project_path)
        self._func_defs[key] = funcs
        return funcs

    def get_java_imports(self, file_path: Path) -> dict[str, str]:
        """获取或缓存 Java 文件的 import 映射。"""
        if file_path in self._java_imports:
            return self._java_imports[file_path]
        from yasa_mcp.service.realtime.realtime_callgraph_service import _extract_java_imports
        imports = _extract_java_imports(file_path)
        self._java_imports[file_path] = imports
        return imports

    def get_file_content(self, file_path: Path) -> str | None:
        """获取或缓存文件内容。"""
        if file_path in self._file_contents:
            return self._file_contents[file_path]
        try:
            content = file_path.read_text(encoding="utf-8", errors="replace")
            self._file_contents[file_path] = content
            return content
        except Exception:
            self._file_contents[file_path] = None
            return None

    def log_stats(self):
        """记录缓存命中统计。"""
        logger.info(
            "[ParseSessionCache] parse_count=%d, cache_hits=%d, "
            "cached_files=%d, cached_func_defs=%d",
            self._parse_count, self._cache_hit_count,
            len(self._sg_roots), len(self._func_defs),
        )

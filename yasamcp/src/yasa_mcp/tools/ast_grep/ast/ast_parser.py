"""ast-grep-py file parsing and node utilities.

Provides a thin wrapper around ast_grep_py for parsing source files
and extracting AST information.  Includes a module-level LRU cache
so that repeated ``parse_file()`` calls for the same file are free.
"""

import logging
from functools import lru_cache
from pathlib import Path

from ast_grep_py import SgRoot

from yasa_mcp.tools.ast_grep.ast.ast_grep_module import Location

logger = logging.getLogger(__name__)

_PARSE_CACHE_MAXSIZE = 512


@lru_cache(maxsize=_PARSE_CACHE_MAXSIZE)
def _parse_file_cached(file_path: str, language: str) -> SgRoot | None:
    """LRU-cached file parse (key is str for hashability)."""
    try:
        content = Path(file_path).read_text(encoding="utf-8", errors="replace")
        return SgRoot(content, language)
    except Exception as e:
        logger.debug("Failed to parse %s: %s", file_path, e)
        return None


def parse_file(file_path: Path, language: str) -> SgRoot | None:
    """Parse a source file into an ast-grep SgRoot (LRU cached, maxsize=512).

    Args:
        file_path: Path to the source file
        language: Language identifier ("python", "java", etc.)

    Returns:
        SgRoot object, or None if parsing fails
    """
    return _parse_file_cached(str(file_path.resolve()), language)


def clear_parse_cache() -> None:
    """Clear the AST parse LRU cache (call after incremental updates)."""
    _parse_file_cached.cache_clear()


def parse_cache_info():
    """Return ``CacheInfo`` stats for the AST parse LRU cache."""
    return _parse_file_cached.cache_info()


def node_location(node, file_path: Path) -> Location:
    """Extract Location from an SgNode.

    Args:
        node: An ast-grep SgNode
        file_path: The file this node belongs to

    Returns:
        Location dataclass instance
    """
    start = node.range().start
    end = node.range().end
    return Location(
        file_path=file_path,
        start_line=start.line + 1,  # ast-grep uses 0-based lines
        start_column=start.column,
        end_line=end.line + 1,
        end_column=end.column,
    )


def node_text(node) -> str:
    """Get the text content of an SgNode."""
    return node.text()


def find_child_by_kind(node, kind: str):
    """Find first direct child with the given kind.

    Args:
        node: Parent SgNode
        kind: Tree-sitter node kind string

    Returns:
        Child SgNode or None
    """
    for child in node.children():
        if child.kind() == kind:
            return child
    return None


def find_children_by_kind(node, kind: str) -> list:
    """Find all direct children with the given kind.

    Args:
        node: Parent SgNode
        kind: Tree-sitter node kind string

    Returns:
        List of matching child SgNodes
    """
    return [child for child in node.children() if child.kind() == kind]

from __future__ import annotations

import logging
from pathlib import Path
from typing import Mapping

from yasa_mcp.service.models import Location

logger = logging.getLogger(__name__)


def resolve_project_relative_path(project_path: Path, raw_path: str) -> Path | None:
    """解析路径并在项目根目录内时返回相对路径；项目外返回 ``None``。"""
    source = Path(raw_path)
    root = project_path.resolve()
    candidate = source.resolve() if source.is_absolute() else (root / source).resolve()
    try:
        return candidate.relative_to(root)
    except ValueError:
        return None


def safe_symbol_location(project_path: Path | None, row: Mapping[str, object]) -> Location | None:
    """将 CodeGraph 位置转换为项目内 ``Location``，拒绝路径穿越。"""
    if project_path is None:
        return None
    raw_path = str(row.get("file_path") or "")
    if not raw_path:
        return None
    relative = resolve_project_relative_path(project_path, raw_path)
    if relative is None:
        logger.warning("search_symbol 拒绝项目外路径: %r", raw_path)
        return None
    start_line = int(row.get("start_line") or 0)
    if start_line < 1:
        return None
    return Location(
        file_path=relative,
        start_line=start_line,
        start_column=int(row.get("start_column") or 0),
        end_line=int(row.get("end_line") or start_line),
        end_column=int(row.get("end_column") or 0),
    )


def symbol_identity(row: Mapping[str, object]) -> tuple[object, ...]:
    """返回 CodeGraph 节点的稳定去重键。"""
    return (
        row.get("kind"), row.get("language"), row.get("qualified_name"),
        row.get("file_path"), row.get("start_line"), row.get("start_column"),
        row.get("end_line"), row.get("end_column"), row.get("id"),
    )

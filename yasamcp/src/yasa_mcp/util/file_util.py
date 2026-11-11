import functools
import logging
import os
from dataclasses import dataclass
from pathlib import Path

from yasa_mcp.core.models import LocationProtocol

from yasa_mcp.core import exceptions
from yasa_mcp.util import log_util
from yasa_mcp.util.timer_util import timed

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class _LineRangeLocation:
    """file_util 内部使用的完整源码位置，实现 LocationProtocol 所需字段。"""

    file_path: Path
    start_line: int
    start_column: int
    end_line: int
    end_column: int


@functools.lru_cache(maxsize=2048)
def get_file_content(file_path: Path) -> str:
    # 检查文件是否存在, 读文件失败时返回空字符串
    if not file_path.exists() or not file_path.is_file():
        log_util.error(f'文件未找到: {file_path}', logger=logger)
        return ''

    try:
        with open(file_path, 'r', encoding='utf-8', errors='ignore') as f:
            content = f.read()
        return content
    except Exception as e:
        log_util.error(f'读取文件失败: {file_path}, error: {e}', logger=logger)
        return ''


@functools.lru_cache(maxsize=2048)
def get_file_lines(file_path: Path) -> tuple[str, ...]:
    """
    返回文件按行切分的结果（带换行符），结果被 LRU 缓存。

    相比每次调用 get_file_content().splitlines()，此函数避免了对同一文件的重复切分。
    典型场景: 一个文件中有 N 个函数，get_file_content_by_location 被调用 N 次，
    每次都需要 splitlines — 使用本函数后只需切分 1 次。

    返回 tuple（不可变）以保证缓存安全。
    """
    content = get_file_content(file_path)
    if not content:
        return ()
    return tuple(content.splitlines(keepends=True))


@timed(logger, "file_util", "get_file_content_by_lines")
def get_file_content_by_lines(project_path: Path, location: LocationProtocol, total_line: int = 1) -> str:
    file_path = (project_path / location.file_path).resolve()
    try:
        lines = get_file_lines(file_path)
        if not lines:
            return ''

        end_line = location.start_line + total_line - 1

        if location.start_line < 1 or end_line > len(lines) or end_line < location.start_line:
            log_util.error(f'location中的行号超出文件范围: {file_path}', logger=logger)
            return ''
        if location.start_line == end_line:
            line = lines[location.start_line - 1]
            return line
        else:
            content = [lines[location.start_line - 1]]
            if end_line - location.start_line > 1:
                content.extend(lines[location.start_line:end_line - 1])
            content.append(lines[end_line - 1])
            return ''.join(content)
    except Exception as e:
        log_util.error(f'读取文件失败: {file_path}, error: {e}', logger=logger)
        return ''


@timed(logger, "file_util", "get_file_content_by_line_range")
def get_file_content_by_line_range(
    project_path: Path,
    file_path: str | Path,
    start_line: int,
    end_line: int,
) -> str:
    """读取项目内文件的闭区间行范围，非法路径或范围统一返回空字符串。

    该方法用于读取外部分析结果提供的文件位置。它在
    ``get_file_content_by_location`` 的统一位置读取语义上，额外补充 project root
    边界校验，调用方无需在各个 service 中重复实现路径穿越防护。
    """

    if not file_path or start_line < 1 or end_line < start_line:
        return ''

    project_root = project_path.resolve()
    raw_path = Path(file_path)
    candidate = raw_path.resolve() if raw_path.is_absolute() else (project_root / raw_path).resolve()
    try:
        # 以下为安全注释COSEC：file_path 可能来自外部工具或缓存。读取前必须确认
        # resolve 后仍在 project root 内，防止 ../、绝对路径或符号链接越界读取。
        candidate.relative_to(project_root)
    except ValueError:
        log_util.warning(
            f'拒绝读取项目外源码路径: {file_path!s}',
            logger=logger,
        )
        return ''

    relative_path = candidate.relative_to(project_root)
    location = _LineRangeLocation(
        file_path=relative_path,
        start_line=start_line,
        start_column=0,
        end_line=end_line,
        end_column=0,
    )
    # 统一复用现有 location 读取语义，由 get_file_content_by_location 处理文件不存在、
    # 行号越界、编码异常以及多行拼接；这里只补充项目根目录边界校验。
    return get_file_content_by_location(project_root, location).strip()


def get_file_content_by_location(project_path, location: LocationProtocol, use_column: bool = False) -> str:
    file_path = (project_path / location.file_path).resolve()
    try:
        # 默认文件直接返回空字符串
        if location.file_path.as_posix() == "default":
            return ''
            
        # 使用缓存的行列表，避免每次调用都 splitlines
        lines = get_file_lines(file_path)
        if not lines:
            return ''

        if location.start_line < 1 or location.end_line > len(lines) or location.end_line < location.start_line:
            log_util.error(f'location中的行号超出文件范围: {file_path}, start: {location.start_line}, end: {location.end_line}', logger=logger)
            return ''

        # 单行（起止行一致）处理
        if location.start_line == location.end_line:
            line = lines[location.start_line - 1]
            if use_column:
                start_col = max(0, location.start_column - 1)
                end_col = min(len(line), location.end_column - 1)
                return line[start_col:end_col]
            else:
                return line
        else:
            if use_column:
                start_col = max(0, location.start_column - 1)
                content = [lines[location.start_line - 1][start_col:]]
            else:
                content = [lines[location.start_line - 1]]
            
            if location.end_line - location.start_line > 1:
                content.extend(lines[location.start_line:location.end_line - 1])
                
            if use_column:
                end_col = min(len(lines[location.end_line - 1]), location.end_column - 1)
                content.append(lines[location.end_line - 1][:end_col])
            else:
                content.append(lines[location.end_line - 1])
            return ''.join(content).strip()
    except Exception as e:
        log_util.error(f'读取文件失败: {file_path}, error: {e}', logger=logger)
        return ''


def match_location_by_start_line(source_loc: LocationProtocol, target_loc: LocationProtocol) -> bool:
    """只强校验开始行"""
    if not source_loc.source_file == target_loc.source_file:
        return False
    if not source_loc.location.start_line == target_loc.start_line:
        return False
    return True


def match_location(source_loc: LocationProtocol, target_loc: LocationProtocol) -> bool:
    if not source_loc.source_file == target_loc.source_file:
        return False
    if not source_loc.location.start_line == target_loc.start_line:
        return False
    if not source_loc.location.start_column == target_loc.start_column:
        return False
    if not source_loc.location.end_line == target_loc.end_line:
        return False
    if not source_loc.location.end_column == target_loc.end_column:
        return False
    return True


def get_path_from_appname(full_path: str, project_path: str) -> str:
    name = Path(project_path).name
    # 归一化为Path对象，并转换为parts元组
    parts = Path(full_path).parts
    if name not in parts:
        return full_path  # 未包含name
    app_idx = parts.index(name)
    # 从项目名之后的parts
    sub_path = Path(*parts[app_idx + 1:])  # 不要项目名（因为下面会加上project_path）
    # 拼接到project_path
    final_path = Path(project_path) / sub_path
    return str(final_path)

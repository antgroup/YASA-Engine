"""
路径处理工具类，主要用于转换绝对路径和相对路径
"""

import functools
import os
from pathlib import Path
from yasa_mcp.core import exceptions


def get_relative_path(abs_path, base_dir):
    """
    获取相对路径
    :param abs_path: 绝对路径
    :param base_dir: 基准目录
    :return: 相对路径
    """
    return abs_path.replace(base_dir, '')


def get_abs_path(rel_path, base_dir):
    """
    获取绝对路径
    :param rel_path: 相对路径
    :param base_dir: 基准目录
    :return: 绝对路径
    """
    return base_dir + rel_path


def validate_path(path_to_validate: Path) -> Path:
    """
    校验路径是否存在
    :param path_to_validate:
    :return: Path
    """

    if not path_to_validate.is_absolute():
        raise exceptions.PathNotAbsoluteError(f"Path {path_to_validate} is not absolute")

    if not path_to_validate.exists():
        raise exceptions.FileNotFoundError(f"Path {path_to_validate} does not exist")

    return path_to_validate.resolve()


@functools.lru_cache(maxsize=1024)
def get_relative_path_by_appname(target_path: str | Path, project_path: str | Path) -> Path:
    """
    计算相对路径，以 project_path 的最后一个路径名（appname）作为基准点。
    如果 target_path 中包含 appname，则返回从 appname 之后开始的相对路径。
    如果 target_path 不包含 appname，或者 target_path 不在 appname 下，
    则尝试返回相对于 project_path 的普通相对路径。

    例如:
    project_path = "/Users/admin/workspace/my-app"
    target_path = "/Users/admin/workspace/my-app/src/main.java"
    appname = "my-app"
    返回: "src/main.java" (注意：这里返回的是 appname 之后的路径)

    特殊情况:
    target_path = "/other/path/my-app/src/test.java"
    project_path = "/workspace/my-app"
    返回: "src/test.java" (只要路径中包含 appname，就截取其后部分)
    """
    p_target = Path(target_path)
    p_project = Path(project_path)

    appname = p_project.name
    parts = p_target.parts

    if appname in parts:
        # 找到 appname 最后一次出现的索引（处理路径中可能有多个同名目录的情况，通常取最后一个最保险，或者根据需求取第一个）
        # 这里为了稳妥，取倒数第一个匹配到的 appname，假设它是项目根目录
        # 但考虑到子模块也可能叫 appname，这里取第一个匹配到的可能更符合“以项目名为基准”的直觉？
        # 需求描述：以 project_path 的最后一个路径名作为 appname，然后相对这个 appname 计算相对路径

        # 假设路径是 /a/b/appname/src/c.java，返回 src/c.java
        # 使用 rindex 查找
        try:
            # 找到 appname 在 parts 中的位置
            # list.index 找的是第一个匹配项。如果路径中有多个同名目录，可能需要斟酌。
            # 通常项目名在路径中是唯一的，或者我们只关心作为项目根的那一个。
            idx = parts.index(appname)

            # 返回 appname 之后的部分
            # parts[idx+1:]
            return Path(*parts[idx + 1:])
        except ValueError:
            pass  # Should not happen if 'in' check passed

    # 如果没找到 appname，或者 target_path 根本不包含 appname
    # 尝试标准的 relative_to
    try:
        return p_target.relative_to(p_project)
    except ValueError:
        # 既不包含 appname，也不是 project_path 的子路径，返回原始路径字符串
        return target_path


def ensure_path(path_to_ensure: Path) -> Path:
    """
    确保路径存在，如果不存在则创建
    :param path_to_ensure:
    :return: Path
    """

    if not path_to_ensure.exists():
        path_to_ensure.mkdir(parents=True, exist_ok=True)

    return path_to_ensure.resolve()

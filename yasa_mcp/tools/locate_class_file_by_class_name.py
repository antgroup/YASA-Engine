"""
MCP Tool: locate_class_file_by_class_name

给定类的全限定名（支持普通类、内部类、嵌套类），在指定仓库内精准定位
其源码文件路径与定义行号；找不到时给出近似候选列表。

复用 #128 的 _build_class_index 构建类名 → 文件路径的索引，
在其基础上提供精确查询和近似候选功能。
"""

from __future__ import annotations

import os
import re
import logging
from typing import Any

from yasa_mcp.registry import mcp_tool
from yasa_mcp.tools.find_implementations_by_interface_name import (
    _build_class_index,
    _find_anonymous_impls,
)

logger = logging.getLogger("yasa_mcp.tools.locate_class_file_by_class_name")


def _normalize_class_name(class_full_name: str) -> str:
    """
    规范化类全限定名。

    接受 "com.example.Outer$Inner" 或 "com.example.Outer.Inner" 两种格式，
    统一转换为 "$" 分隔的内部类格式。

    注意：包名中的 "." 不能被替换，只有类名部分中的 "." 才是内部类分隔符。
    策略：从右向左找，如果最后一个 "." 后面的部分本身不含 "."，
    且倒数第二个 "." 后面的部分首字母大写（是类名而非包名），
    则将类名部分的 "." 替换为 "$"。

    更简单的策略：尝试原始名称，再尝试将最后一个 "." 替换为 "$"，
    再尝试将最后两个 "." 替换为 "$" 等。
    """
    if not class_full_name:
        return class_full_name

    # 如果已经包含 $，直接返回
    if "$" in class_full_name:
        return class_full_name

    return class_full_name


def _generate_name_variants(class_full_name: str) -> list[str]:
    """
    为类全限定名生成多种可能的变体。

    "com.example.Outer.Inner" 可能是：
    1. com.example.Outer.Inner（包 com.example.Outer 下的类 Inner）
    2. com.example.Outer$Inner（类 com.example.Outer 的内部类 Inner）

    我们需要生成所有可能的 "$" 替换组合（从最后一个 "." 开始向前尝试）。
    """
    variants = [class_full_name]

    if "$" in class_full_name:
        return variants

    # 找到所有 "." 的位置（从右向左）
    dots = [i for i, ch in enumerate(class_full_name) if ch == "."]
    dots.reverse()  # 从右向左

    # 逐个尝试将 "." 替换为 "$"
    # 第一个 "." 是包名和顶级类名之间的分隔，不应该替换
    # 但从右边开始，每多替换一个 "." 就多一个变体
    for i in range(len(dots)):
        variant = list(class_full_name)
        for j in range(i + 1):
            variant[dots[j]] = "$"
        variants.append("".join(variant))

    return variants


def _determine_kind(info: dict[str, Any]) -> str:
    """根据类信息确定 kind 字段"""
    if info.get("is_interface"):
        return "interface"
    if info.get("is_abstract"):
        return "abstract_class"
    return "class"


def _is_inner_class(full_name: str) -> bool:
    """判断是否是内部类"""
    return "$" in full_name


def _get_outer_class_full_name(full_name: str) -> str | None:
    """从内部类全限定名中提取外层类全限定名"""
    if "$" not in full_name:
        return None
    return full_name.rsplit("$", 1)[0]


def _find_candidates(
    class_full_name: str,
    index: dict[str, dict[str, Any]],
    max_candidates: int = 10,
) -> list[str]:
    """
    在索引中查找近似候选。

    策略：
    1. 提取简单名（最后一个 "." 或 "$" 后的部分）
    2. 在索引中搜索简单名匹配的全限定名
    3. 也搜索包含该简单名的全限定名
    """
    # 提取简单名
    simple_name = class_full_name
    if "$" in simple_name:
        simple_name = simple_name.rsplit("$", 1)[-1]
    if "." in simple_name:
        simple_name = simple_name.rsplit(".", 1)[-1]

    if not simple_name:
        return []

    candidates: list[str] = []
    seen: set[str] = set()

    for full_name, info in index.items():
        # 精确简单名匹配
        if info["simple_name"] == simple_name and full_name != class_full_name:
            if full_name not in seen:
                candidates.append(full_name)
                seen.add(full_name)
        # 包含简单名的全限定名
        elif simple_name in full_name and full_name != class_full_name:
            if full_name not in seen:
                candidates.append(full_name)
                seen.add(full_name)

        if len(candidates) >= max_candidates:
            break

    # 如果没有找到候选，尝试用简单名的子串（如 "NonExistentThreat" → "Threat"）
    if not candidates and len(simple_name) > 4:
        # 从简单名中提取可能的关键词部分（去掉前缀/后缀后的部分）
        # 简单策略：搜索包含简单名后半部分的类名
        keyword = simple_name
        # 逐步缩短关键词直到找到候选
        for min_len in range(len(simple_name) - 1, 3, -1):
            keyword = simple_name[-min_len:] if min_len < len(simple_name) else simple_name
            if len(keyword) < 4:
                break
            for full_name, info in index.items():
                if keyword in full_name and full_name != class_full_name and full_name not in seen:
                    candidates.append(full_name)
                    seen.add(full_name)
                    if len(candidates) >= max_candidates:
                        break
            if candidates:
                break

    return candidates


@mcp_tool(
    name="locate_class_file_by_class_name",
    description=(
        "Locate the source file and definition line of a Java class by its "
        "fully qualified name in a repository. Supports inner classes "
        "(Outer$Inner or Outer.Inner notation). Returns file path, line number, "
        "kind (class/interface/abstract_class), and inner class metadata. "
        "If not found, returns approximate candidates."
    ),
)
async def locate_class_file_by_class_name(
    class_full_name: str,
    repository_path: str,
    include_inner_classes: bool = True,
) -> dict:
    """
    Locate a Java class file by its fully qualified name.

    Args:
        class_full_name: Fully qualified class name, e.g. "com.example.UserController".
                         For inner classes, use "Outer$Inner" or "Outer.Inner".
        repository_path: Absolute path to the repository root
        include_inner_classes: If true (default), return outer file info for inner classes
    """
    # 参数校验
    if not class_full_name:
        return {
            "class_full_name": "",
            "found": False,
            "candidates": [],
        }

    if not repository_path or not os.path.isdir(repository_path):
        return {
            "class_full_name": class_full_name,
            "found": False,
            "candidates": [],
        }

    logger.info(
        "locate_class_file_by_class_name: class=%s, repo=%s",
        class_full_name, repository_path,
    )

    # 1. 构建类索引（复用 #128）
    index = _build_class_index(repository_path)

    # 2. 将匿名实现类加入索引
    anonymous_impls = _find_anonymous_impls(repository_path, index)
    for iface_simple, anon_list in anonymous_impls.items():
        for anon_info in anon_list:
            index[anon_info["class_full_name"]] = anon_info

    # 3. 尝试精确查找 —— 生成名称变体并逐个尝试
    variants = _generate_name_variants(class_full_name)

    for variant in variants:
        if variant in index:
            info = index[variant]
            kind = _determine_kind(info)
            is_inner = _is_inner_class(variant)
            outer_full_name = _get_outer_class_full_name(variant) if is_inner else None

            result: dict[str, Any] = {
                "class_full_name": class_full_name,
                "found": True,
                "file_path": info["file_path"],
                "line_number": info["line_number"],
                "kind": kind,
                "is_inner_class": is_inner,
                "outer_class_full_name": outer_full_name,
            }

            # 如果是内部类且 include_inner_classes=true，补充外层文件信息
            if is_inner and include_inner_classes and outer_full_name and outer_full_name in index:
                outer_info = index[outer_full_name]
                result["outer_file_path"] = outer_info["file_path"]
                result["outer_line_number"] = outer_info["line_number"]

            return result

    # 4. 未找到 — 返回近似候选
    candidates = _find_candidates(class_full_name, index)

    return {
        "class_full_name": class_full_name,
        "found": False,
        "candidates": candidates,
    }
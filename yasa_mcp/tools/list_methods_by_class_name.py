"""
MCP Tool: list_methods_by_class_name

给定类全限定名, 一次性返回该类的所有方法清单(签名、可见性、起止行号、注解),
可选附带方法源码或仅返回签名; 支持是否包含从父类/接口继承的方法。

实现方式: 复用 #137 的方法范围提取和签名构建逻辑,
新增可见性/static 解析、类元数据提取、继承方法查找。
"""

from __future__ import annotations

import os
import re
import logging
from typing import Any

from yasa_mcp.registry import mcp_tool
from yasa_mcp.tools.search_code_by_signature_pattern import (
    _METHOD_LINE_PATTERN,
    _strip_comments,
    _compute_line_depths,
    _build_class_ranges_by_depth,
)
from yasa_mcp.tools.read_method_source_by_method_name import (
    _extract_all_method_ranges,
    _extract_method_info,
    _build_method_signature,
    _extract_annotations,
    _find_class_file,
    _STATIC_INIT_PATTERN,
)

logger = logging.getLogger("yasa_mcp.tools.list_methods_by_class_name")


# ---------------------------------------------------------------------------
# 可见性和 static 提取
# ---------------------------------------------------------------------------

def _extract_visibility_and_static(prefix_tokens: list[str]) -> tuple[str, bool]:
    """
    从方法声明前缀的 token 列表中提取可见性和 static 属性。

    返回: (visibility, is_static)
    visibility: "public" / "protected" / "private" / "package" (无修饰符)
    """
    visibility = "package"  # 默认 package-private
    is_static = False

    for token in prefix_tokens:
        if token == "public":
            visibility = "public"
        elif token == "protected":
            visibility = "protected"
        elif token == "private":
            visibility = "private"
        elif token == "static":
            is_static = True

    return (visibility, is_static)


# ---------------------------------------------------------------------------
# 类元数据提取
# ---------------------------------------------------------------------------

# 类声明正则: [modifiers] abstract? class|interface Name [generic] [extends ...] [implements ...] {
_CLASS_DECL_PATTERN = re.compile(
    r"(?:public|protected|private|final|static|\s)*"
    r"(abstract\s+)?"
    r"(class|interface)\s+"
    r"(\w+)"
    r"(?:\s*<[^{]*?>)?"
    r"(?:\s+extends\s+([\w.,\s<>?]+?))?"
    r"(?:\s+implements\s+([\w.,\s<>?]+?))?"
    r"\s*\{",
    re.DOTALL,
)


def _extract_class_metadata(
    stripped_lines: list[str],
    class_info: list[tuple[int, int, str]],
    target_class_full_name: str,
) -> dict[str, Any]:
    """
    提取类的元数据: extends_class, implements_interfaces, class_start_line, class_end_line。

    从 stripped_lines 中找到目标类的声明行，解析 extends 和 implements。
    """
    result: dict[str, Any] = {
        "class_start_line": None,
        "class_end_line": None,
        "extends_class": None,
        "implements_interfaces": [],
    }

    # 在 class_info 中找到目标类
    target_cls_info = None
    for cls_start, cls_end, cls_full_name in class_info:
        if cls_full_name == target_class_full_name:
            target_cls_info = (cls_start, cls_end, cls_full_name)
            break

    if not target_cls_info:
        return result

    cls_start, cls_end, _ = target_cls_info
    result["class_start_line"] = cls_start + 1  # 1-based
    result["class_end_line"] = cls_end + 1      # 1-based

    # 从类声明行解析 extends 和 implements
    # 类声明可能跨多行, 取从 cls_start 到第一个 { 的内容
    decl_text = ""
    for j in range(cls_start, min(cls_start + 10, len(stripped_lines))):
        decl_text += stripped_lines[j] + "\n"
        if "{" in stripped_lines[j]:
            break

    m = _CLASS_DECL_PATTERN.search(decl_text)
    if m:
        # group(4): extends 列表
        if m.group(4):
            extends_raw = m.group(4).strip()
            # 只取第一个 (不支持多重继承, Java 只能 extends 一个类)
            extends_class = extends_raw.split(",")[0].strip().split("<")[0]
            result["extends_class"] = extends_class

        # group(5): implements 列表
        if m.group(5):
            implements_raw = m.group(5).strip()
            interfaces = [s.strip().split("<")[0] for s in implements_raw.split(",")]
            result["implements_interfaces"] = interfaces

    return result


# ---------------------------------------------------------------------------
# 继承方法查找
# ---------------------------------------------------------------------------

def _find_inherited_methods(
    extends_class: str | None,
    implements_interfaces: list[str],
    repository_path: str,
    package: str,
) -> list[dict[str, Any]]:
    """
    查找父类和接口的方法 (只返回签名, 不返回 source)。

    简化实现: 只查找一层继承 (不递归), 只返回方法签名和 inherited_from。
    """
    inherited: list[dict[str, Any]] = []
    seen_signatures: set[str] = set()  # 避免重复

    # 收集需要查找的父类/接口
    parent_classes: list[tuple[str, str]] = []  # (class_full_name, inherited_from)

    if extends_class:
        # extends_class 可能是简单名, 需要构造全限定名
        if "." in extends_class:
            parent_classes.append((extends_class, extends_class))
        else:
            # 尝试用当前包名
            full_name = f"{package}.{extends_class}" if package else extends_class
            parent_classes.append((full_name, full_name))

    for iface in implements_interfaces:
        if "." in iface:
            parent_classes.append((iface, iface))
        else:
            full_name = f"{package}.{iface}" if package else iface
            parent_classes.append((full_name, full_name))

    # 对每个父类/接口, 查找其方法
    for parent_full_name, inherited_from in parent_classes:
        # 解析 package 和 class_name
        parts = parent_full_name.rsplit(".", 1)
        if len(parts) == 2:
            parent_pkg, parent_cls = parts[0], parts[1]
        else:
            parent_pkg, parent_cls = "", parent_full_name

        # 定位父类文件
        parent_file = _find_class_file(repository_path, parent_pkg, parent_cls)
        if not parent_file:
            continue  # 找不到文件, 跳过

        # 读取并解析父类方法
        try:
            with open(parent_file, "r", encoding="utf-8", errors="replace") as f:
                parent_content = f.read()
        except (OSError, IOError):
            continue

        parent_stripped = _strip_comments(parent_content)
        parent_lines = parent_stripped.split("\n")
        parent_depths = _compute_line_depths(parent_lines)
        parent_class_info = _build_class_ranges_by_depth(parent_lines, parent_depths, parent_pkg)
        parent_methods = _extract_all_method_ranges(parent_lines, parent_depths, parent_class_info, parent_pkg)

        # 只取属于该父类的方法
        for method in parent_methods:
            if method["containing_class"] != parent_full_name:
                continue

            # 提取方法信息 (使用 _match_line 支持跨行签名)
            line = method.get("_match_line", parent_lines[method["start_line"]])
            m_match = _METHOD_LINE_PATTERN.search(line)
            if m_match:
                info = _extract_method_info(line, m_match)
                signature = _build_method_signature(info)
            else:
                continue  # 静态初始化块等, 跳过

            if signature not in seen_signatures:
                seen_signatures.add(signature)
                inherited.append({
                    "method_signature": signature,
                    "method_short_name": method["method_name"],
                    "visibility": "public",  # 继承方法默认 public
                    "is_static": False,
                    "is_abstract": False,
                    "start_line": None,
                    "end_line": None,
                    "annotations": [],
                    "inherited_from": inherited_from,
                })

    return inherited


# ---------------------------------------------------------------------------
# 核心逻辑
# ---------------------------------------------------------------------------

def _list_methods(
    filepath: str,
    repo_root: str,
    package: str,
    class_name: str,
    include_private: bool,
    include_source: bool,
) -> dict[str, Any]:
    """
    列出指定类的所有方法。
    """
    try:
        with open(filepath, "r", encoding="utf-8", errors="replace") as f:
            content = f.read()
    except (OSError, IOError):
        return {"error": "Failed to read file"}

    raw_lines = content.split("\n")
    stripped = _strip_comments(content)
    lines = stripped.split("\n")
    depths = _compute_line_depths(lines)
    class_info = _build_class_ranges_by_depth(lines, depths, package)

    # 目标类全限定名
    target_class = f"{package}.{class_name}" if package else class_name

    # 提取类元数据
    metadata = _extract_class_metadata(lines, class_info, target_class)

    # 提取所有方法
    all_methods = _extract_all_method_ranges(lines, depths, class_info, package)

    # 过滤: 只返回目标类的方法 (不串到内部类)
    target_methods = [
        m for m in all_methods
        if m["containing_class"] == target_class
    ]

    # 构建方法列表
    methods_result: list[dict[str, Any]] = []

    for method in target_methods:
        start_line = method["start_line"]
        end_line = method["end_line"]

        # 提取方法信息
        # 使用方法声明的匹配行 (可能跨行)
        line = method.get("_match_line", lines[start_line])
        m_match = _METHOD_LINE_PATTERN.search(line)

        if m_match:
            info = _extract_method_info(line, m_match)
            signature = _build_method_signature(info)

            # 提取可见性和 static
            name_pos = m_match.start(1)
            prefix = line[:name_pos].strip()
            tokens = prefix.split()
            non_anno_tokens = [t for t in tokens if not t.startswith("@")]
            visibility, is_static = _extract_visibility_and_static(non_anno_tokens)

            is_abstract = info["is_abstract"]
            method_short_name = method["method_name"]
        else:
            # 静态初始化块
            signature = "<static_init>()"
            visibility = "package"
            is_static = True
            is_abstract = False
            method_short_name = "<static_init>"

        # include_private 过滤
        if not include_private and visibility == "private":
            continue

        # 计算实际结束行
        if end_line == start_line:
            actual_end = start_line
        else:
            actual_end = end_line - 1

        # 提取注解
        annotations = _extract_annotations(raw_lines, start_line)

        method_entry: dict[str, Any] = {
            "method_signature": signature,
            "method_short_name": method_short_name,
            "visibility": visibility,
            "is_static": is_static,
            "is_abstract": is_abstract,
            "start_line": start_line + 1,  # 1-based
            "end_line": actual_end + 1 if end_line != start_line else start_line + 1,  # 1-based
            "annotations": [a.strip() for a in annotations],
            "inherited_from": None,
        }

        # 可选: source
        if include_source:
            # 计算源码起始行 (包含注解)
            source_start = start_line
            if annotations:
                first_anno = annotations[0].strip()
                for i in range(start_line - 1, -1, -1):
                    if raw_lines[i].strip() == first_anno:
                        source_start = i
                        break

            source_lines = raw_lines[source_start: actual_end + 1]
            method_entry["source"] = "\n".join(source_lines)

        methods_result.append(method_entry)

    rel_path = os.path.relpath(filepath, repo_root)

    result: dict[str, Any] = {
        "class_full_name": target_class,
        "file_path": rel_path,
        "class_start_line": metadata["class_start_line"],
        "class_end_line": metadata["class_end_line"],
        "extends_class": metadata["extends_class"],
        "implements_interfaces": metadata["implements_interfaces"],
        "total_methods": len(methods_result),
        "methods": methods_result,
    }

    return result


# ---------------------------------------------------------------------------
# MCP Tool
# ---------------------------------------------------------------------------

@mcp_tool(
    name="list_methods_by_class_name",
    description=(
        "List all methods of a Java class by its fully qualified name. "
        "Returns method signatures, visibility, line ranges, annotations, "
        "and optional source code. Supports including inherited methods "
        "from parent classes/interfaces."
    ),
)
async def list_methods_by_class_name(
    class_full_name: str,
    repository_path: str,
    include_inherited: bool = False,
    include_private: bool = True,
    include_source: bool = True,
    language: str = "java",
) -> dict:
    """
    List all methods of a Java class.

    Args:
        class_full_name: Fully qualified class name, e.g. "com.example.UserController"
        repository_path: Absolute path to the repository root
        include_inherited: If true, include methods inherited from parent
                           classes/interfaces (signatures only, no source)
        include_private: If true (default), include private methods
        include_source: If true (default), include method source code.
                        Set to false for a lightweight signature-only listing.
        language: Programming language (default: java)
    """
    # --- 参数校验 ---
    if not class_full_name:
        return {"error": "class_full_name is required"}

    if not repository_path or not os.path.isdir(repository_path):
        return {"error": "Invalid repository_path"}

    # --- 解析类全限定名 ---
    parts = class_full_name.rsplit(".", 1)
    if len(parts) == 2:
        package, class_name = parts[0], parts[1]
    else:
        package, class_name = "", class_full_name

    if not class_name:
        return {"error": "Could not parse class name"}

    # --- 定位文件 ---
    filepath = _find_class_file(repository_path, package, class_name)
    if not filepath:
        return {
            "class_full_name": class_full_name,
            "error": f"Class file not found for {class_full_name}",
        }

    logger.info(
        "list_methods: class=%s, file=%s",
        class_full_name, filepath,
    )

    # --- 列出方法 ---
    result = _list_methods(
        filepath,
        repository_path,
        package,
        class_name,
        include_private,
        include_source,
    )

    # --- 可选: 继承方法 ---
    if include_inherited and result.get("extends_class"):
        inherited = _find_inherited_methods(
            result.get("extends_class"),
            result.get("implements_interfaces", []),
            repository_path,
            package,
        )
        result["methods"].extend(inherited)
        result["total_methods"] = len(result["methods"])

    return result
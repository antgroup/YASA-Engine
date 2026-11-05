"""
MCP Tool: read_method_source_by_method_name

给定方法的全限定名 (可选形参类型用于重载消歧), 精准返回该方法的源码片段
(可选携带 Javadoc 与注解), 不带文件其他部分。

实现方式: 复用 #134/#135 的花括号深度状态机和方法范围提取逻辑,
在原始文件内容中提取方法的完整源码。
"""

from __future__ import annotations

import os
import re
import logging
from typing import Any

from yasa_mcp.registry import mcp_tool
from yasa_mcp.tools.search_code_by_signature_pattern import (
    _EXCLUDED_DIRS,
    _CLASS_PATTERN,
    _METHOD_LINE_PATTERN,
    _CONTROL_FLOW_KEYWORDS,
    _MODIFIERS,
    _strip_comments,
    _extract_package,
    _compute_line_depths,
    _build_class_ranges_by_depth,
    _find_java_files,
)

logger = logging.getLogger("yasa_mcp.tools.read_method_source_by_method_name")

# 静态初始化块模式: static { ... }
_STATIC_INIT_PATTERN = re.compile(r"\bstatic\s*\{")


# ---------------------------------------------------------------------------
# 方法全限定名解析
# ---------------------------------------------------------------------------

def _parse_method_full_name(method_full_name: str) -> tuple[str, str, str]:
    """
    解析方法全限定名, 返回 (package, class_name, method_name)。

    "com.example.UserController.getUser"
      → ("com.example", "UserController", "getUser")

    "com.example.Outer$Inner.method"
      → ("com.example", "Outer$Inner", "method")

    "com.example.Outer.Inner.method"
      → ("com.example", "Outer.Inner", "method")
    """
    if not method_full_name:
        return ("", "", "")

    # 方法名是最后一个 . 后的部分
    # 但内部类用 $ 分隔, $ 后的 . 不分割
    # 简化: 最后一个 . 分割
    parts = method_full_name.rsplit(".", 1)
    if len(parts) != 2:
        return ("", "", method_full_name)

    class_part = parts[0]  # com.example.UserController
    method_name = parts[1]  # getUser

    # 从 class_part 中提取 package 和 class_name
    # class_name 是最后一个 . 后的部分 (支持 Outer$Inner)
    class_parts = class_part.rsplit(".", 1)
    if len(class_parts) == 2:
        package = class_parts[0]
        class_name = class_parts[1]
    else:
        package = ""
        class_name = class_part

    return (package, class_name, method_name)


# ---------------------------------------------------------------------------
# 方法范围提取 (增强版, 同时接受有方法体和抽象方法)
# ---------------------------------------------------------------------------

def _extract_all_method_ranges(
    lines: list[str],
    depths: list[int],
    class_info: list[tuple[int, int, str]],
    package: str | None,
) -> list[dict[str, Any]]:
    """
    定位所有类体级别的方法定义, 同时接受有方法体 ({) 和抽象方法/接口声明 (;)。

    与 #135 的 _extract_method_ranges 的区别: 不跳过 ; 结尾的方法。
    """
    methods: list[dict[str, Any]] = []

    for i, line in enumerate(lines):
        m = _METHOD_LINE_PATTERN.search(line)
        if not m:
            continue

        method_name = m.group(1)
        if method_name in _CONTROL_FLOW_KEYWORDS:
            continue

        method_depth = depths[i]

        # 只接受类体级别的方法 (depth = 类体深度)
        # 类体深度 = 类定义行 depth + 1
        # 排除方法体内的方法调用 (如 userService.findById(id);)
        in_class_body = False
        for cls_start, cls_end, cls_full_name in class_info:
            if cls_start < i < cls_end:
                class_depth = depths[cls_start]
                if method_depth == class_depth + 1:
                    in_class_body = True
                break
        if not in_class_body:
            continue

        # 检查返回类型
        name_pos = m.start(1)
        prefix = line[:name_pos].strip()
        tokens = prefix.split()
        non_anno_tokens = [t for t in tokens if not t.startswith("@")]
        ret_type_tokens = [t for t in non_anno_tokens if t not in _MODIFIERS]
        ret_type = " ".join(ret_type_tokens).strip() if ret_type_tokens else ""
        if ret_type and ret_type.split()[0] in _CONTROL_FLOW_KEYWORDS:
            continue

        ending = m.group(3)  # { 或 ;

        # 确定方法体结束行
        if ending == "{":
            end_line = len(lines) - 1
            for j in range(i + 1, len(lines)):
                if depths[j] <= method_depth:
                    end_line = j
                    break
        else:
            # 抽象方法/接口声明, 只有一行
            end_line = i

        # 查找所属类
        containing_class = ""
        for cls_start, cls_end, cls_full_name in class_info:
            if cls_start < i < cls_end:
                containing_class = cls_full_name
                break

        containing_method = f"{containing_class}.{method_name}" if containing_class else method_name

        methods.append({
            "method_name": method_name,
            "start_line": i,
            "end_line": end_line,
            "containing_class": containing_class,
            "containing_method": containing_method,
            "method_depth": method_depth,
        })

    # 检测静态初始化块: static { ... }
    for i, line in enumerate(lines):
        if not _STATIC_INIT_PATTERN.search(line):
            continue

        method_depth = depths[i]

        # 只接受类体级别
        in_class_body = False
        containing_class = ""
        for cls_start, cls_end, cls_full_name in class_info:
            if cls_start < i < cls_end:
                class_depth = depths[cls_start]
                if method_depth == class_depth + 1:
                    in_class_body = True
                    containing_class = cls_full_name
                break
        if not in_class_body:
            continue

        # 确定结束行
        end_line = len(lines) - 1
        for j in range(i + 1, len(lines)):
            if depths[j] <= method_depth:
                end_line = j
                break

        methods.append({
            "method_name": "<static_init>",
            "start_line": i,
            "end_line": end_line,
            "containing_class": containing_class,
            "containing_method": f"{containing_class}.<static_init>" if containing_class else "<static_init>",
            "method_depth": method_depth,
        })

    return methods


# ---------------------------------------------------------------------------
# 文件定位
# ---------------------------------------------------------------------------

def _find_class_file(
    repository_path: str,
    package: str,
    class_name: str,
) -> str | None:
    """
    在仓库中查找包含指定类的 Java 文件。

    策略:
    1. 按 Java 包路径约定拼接文件路径 (快)
    2. 找不到则遍历所有 Java 文件用正则匹配类名 (准)
    """
    # 策略1: 按包路径约定, 尝试常见目录前缀
    if package:
        file_class_name = class_name.split("$")[0]
        rel_path = package.replace(".", "/") + "/" + file_class_name + ".java"
        for prefix in ["", "src/main/java/", "src/"]:
            candidate = os.path.join(repository_path, prefix + rel_path)
            if os.path.isfile(candidate):
                return candidate

    # 策略2: 遍历查找
    file_class_name = class_name.split("$")[0]
    pattern = re.compile(
        rf"\b(?:abstract\s+)?(?:class|interface)\s+{re.escape(file_class_name)}\b"
    )

    for filepath in _find_java_files(repository_path):
        try:
            with open(filepath, "r", encoding="utf-8", errors="replace") as f:
                # 只读前 100 行找类声明 (类声明通常在文件开头)
                head = "".join(f.readline() for _ in range(100))
        except (OSError, IOError):
            continue

        stripped = _strip_comments(head)
        if pattern.search(stripped):
            return filepath

    return None


# ---------------------------------------------------------------------------
# 方法信息增强提取
# ---------------------------------------------------------------------------

def _extract_method_info(
    line: str,
    method_match: re.Match,
) -> dict[str, Any]:
    """
    从方法声明行中提取详细信息: 返回类型、参数类型列表、是否构造器、是否抽象。
    """
    method_name = method_match.group(1)
    params_raw = method_match.group(2)
    ending = method_match.group(3)

    # 提取返回类型
    name_pos = method_match.start(1)
    prefix = line[:name_pos].strip()
    tokens = prefix.split()
    non_anno_tokens = [t for t in tokens if not t.startswith("@")]

    is_abstract = "abstract" in non_anno_tokens
    ret_type_tokens = [t for t in non_anno_tokens if t not in _MODIFIERS]
    ret_type = " ".join(ret_type_tokens).strip() if ret_type_tokens else ""

    # 解析参数类型
    param_types = _parse_param_types(params_raw)

    # 判断是否构造器 (无返回类型)
    is_constructor = not ret_type

    return {
        "method_name": method_name,
        "return_type": ret_type,
        "param_types": param_types,
        "is_abstract": is_abstract or (ending == ";"),
        "is_constructor": is_constructor,
        "has_body": ending == "{",
    }


def _parse_param_types(params_str: str) -> list[str]:
    """
    解析方法参数列表, 返回参数类型列表。

    "HttpServletRequest req, @PathVariable String id"
      → ["HttpServletRequest", "String"]

    "" → []
    """
    if not params_str.strip():
        return []

    result: list[str] = []
    parts = _split_params(params_str)
    for part in parts:
        part = part.strip()
        if not part:
            continue
        # 去掉注解 (@PathVariable 等)
        part = re.sub(r"@\w+(?:\([^)]*\))?\s*", "", part).strip()
        # 去掉 final 修饰符
        part = re.sub(r"\bfinal\s+", "", part).strip()
        # 取最后一个空格前的部分作为类型 (Type name)
        tokens = part.rsplit(None, 1)
        if len(tokens) == 2:
            param_type = tokens[0]
        else:
            param_type = part
        # 去掉可变参数 ...
        param_type = param_type.replace("...", "").strip()
        if param_type:
            result.append(param_type)

    return result


def _split_params(params_str: str) -> list[str]:
    """
    按顶层逗号分割参数列表, 忽略泛型尖括号内的逗号。
    """
    result: list[str] = []
    current: list[str] = []
    depth = 0

    for ch in params_str:
        if ch == "<":
            depth += 1
        elif ch == ">":
            depth -= 1
        if ch == "," and depth == 0:
            result.append("".join(current))
            current = []
        else:
            current.append(ch)

    if current:
        result.append("".join(current))

    return result


def _build_method_signature(method_info: dict[str, Any]) -> str:
    """
    构建方法签名字符串: "getUser(HttpServletRequest, String): ResponseEntity<User>"
    """
    name = method_info["method_name"]
    param_types = method_info["param_types"]
    ret_type = method_info["return_type"]

    params_str = ", ".join(param_types) if param_types else ""
    if ret_type:
        return f"{name}({params_str}): {ret_type}"
    else:
        return f"{name}({params_str})"


# ---------------------------------------------------------------------------
# Javadoc 和注解提取
# ---------------------------------------------------------------------------

def _extract_javadoc(lines: list[str], method_line: int) -> str | None:
    """
    从方法声明行向上搜索 Javadoc 注释 (/** ... */)。

    method_line: 0-based 方法声明行号
    返回 Javadoc 文本 (含 /** 和 */), 如果没有则返回 None。
    """
    # 向上搜索非空行, 跳过注解行
    i = method_line - 1
    while i >= 0:
        line = lines[i].strip()
        if not line:
            i -= 1
            continue
        # 找到 Javadoc 结尾 */
        if line.endswith("*/"):
            # 向上搜索 /** 开头
            javadoc_end = i
            j = i
            while j >= 0:
                jline = lines[j].strip()
                if jline.startswith("/**"):
                    # 提取 Javadoc
                    javadoc_lines = lines[j: javadoc_end + 1]
                    return "\n".join(javadoc_lines)
                j -= 1
            # 如果没找到 /**, 可能是普通块注释, 不是 Javadoc
            return None
        # 如果不是 */ 结尾, 可能是注解行或代码行
        if line.startswith("@"):
            i -= 1
            continue
        # 既不是注释结尾也不是注解, 停止搜索
        break

    return None


def _extract_annotations(lines: list[str], method_line: int) -> list[str]:
    """
    从方法声明行向上搜索注解。

    返回注解行列表 (从上到下), 如果没有则返回空列表。
    """
    annotations: list[str] = []
    i = method_line - 1

    # 从方法声明行向上搜索注解行
    # 遇到非注解、非空行 (如 Javadoc */ 或代码行) 时停止
    while i >= 0:
        line = lines[i].strip()
        if not line:
            break  # 空行, 停止
        if line.startswith("@"):
            annotations.insert(0, lines[i].rstrip())
            i -= 1
            continue
        break  # 非注解行, 停止

    return annotations


# ---------------------------------------------------------------------------
# 核心逻辑
# ---------------------------------------------------------------------------

def _read_method_source(
    filepath: str,
    repo_root: str,
    package: str,
    class_name: str,
    method_name: str,
    parameter_types: list[str] | None,
    include_javadoc: bool,
    include_annotations: bool,
) -> dict[str, Any]:
    """
    读取指定方法的源码。
    """
    try:
        with open(filepath, "r", encoding="utf-8", errors="replace") as f:
            content = f.read()
    except (OSError, IOError):
        return {"found": False}

    raw_lines = content.split("\n")
    stripped = _strip_comments(content)
    lines = stripped.split("\n")
    depths = _compute_line_depths(lines)
    class_info = _build_class_ranges_by_depth(lines, depths, package)

    # 提取所有方法范围 (包括有方法体的和抽象方法/接口声明)
    methods = _extract_all_method_ranges(lines, depths, class_info, package)

    # 按 method_name 筛选
    candidates: list[dict[str, Any]] = []
    for method in methods:
        # 匹配方法名
        if method["method_name"] != method_name:
            continue
        # 匹配类名 (class_name 可能含 $)
        expected_class = f"{package}.{class_name}" if package else class_name
        # 也支持内部类: class_name = "Outer$Inner", expected_class = "package.Outer$Inner"
        if method["containing_class"] != expected_class:
            # 尝试匹配内部类变体
            if class_name not in method["containing_class"]:
                continue
        candidates.append(method)

    if not candidates:
        return {"found": False}

    # 提取每个候选的详细信息
    for c in candidates:
        line = lines[c["start_line"]]
        m = _METHOD_LINE_PATTERN.search(line)
        if m:
            info = _extract_method_info(line, m)
            c.update(info)
        else:
            c.update({
                "return_type": "",
                "param_types": [],
                "is_abstract": True,
                "is_constructor": False,
                "has_body": False,
            })
        c["method_signature"] = _build_method_signature(c)

    # 重载消歧
    if len(candidates) > 1:
        if parameter_types:
            # 按参数类型消歧
            for c in candidates:
                if c["param_types"] == parameter_types:
                    candidates = [c]
                    break
            else:
                # 没有精确匹配, 返回 ambiguous
                return {
                    "method_full_name": f"{package}.{class_name}.{method_name}" if package else f"{class_name}.{method_name}",
                    "found": False,
                    "ambiguous": True,
                    "candidates": [c["method_signature"] for c in candidates],
                }
        else:
            # 未提供参数类型, 返回 ambiguous
            return {
                "method_full_name": f"{package}.{class_name}.{method_name}" if package else f"{class_name}.{method_name}",
                "found": False,
                "ambiguous": True,
                "candidates": [c["method_signature"] for c in candidates],
            }

    # 选中的方法
    method = candidates[0]
    start_line = method["start_line"]  # 0-based, 方法声明行
    end_line = method["end_line"]      # 0-based, depths 回落后的行
    containing_class = method["containing_class"]

    # 实际方法体结束行: } 所在的行
    # end_line 是 depths <= method_depth 的行 (} 之后的行)
    # 方法体的 } 在 end_line - 1
    if end_line == start_line:
        actual_end = start_line  # 抽象方法, 只有一行
    else:
        actual_end = end_line - 1  # 方法 } 行

    # 提取 Javadoc (独立字段)
    javadoc = None
    if include_javadoc:
        javadoc = _extract_javadoc(raw_lines, start_line)

    # 计算源码起始行: 注解行 + 方法声明行 + 方法体
    source_start = start_line
    if include_annotations:
        annos = _extract_annotations(raw_lines, start_line)
        if annos:
            # 找到第一个注解行
            first_anno_text = annos[0].strip()
            for i in range(start_line - 1, -1, -1):
                if raw_lines[i].strip() == first_anno_text:
                    source_start = i
                    break

    # 提取源码 (从注解行或方法声明行到 } 行)
    source_lines = raw_lines[source_start: actual_end + 1]
    source = "\n".join(source_lines)

    # 构建全限定名
    method_full_name = f"{containing_class}.{method_name}" if containing_class else method_name

    rel_path = os.path.relpath(filepath, repo_root)

    result: dict[str, Any] = {
        "method_full_name": method_full_name,
        "method_signature": method["method_signature"],
        "file_path": rel_path,
        "start_line": start_line + 1,  # 1-based
        "end_line": (actual_end + 1) if end_line != start_line else (start_line + 1),  # 1-based
        "containing_class": containing_class,
        "source": source,
    }

    if include_javadoc:
        result["javadoc"] = javadoc

    return result


# ---------------------------------------------------------------------------
# MCP Tool
# ---------------------------------------------------------------------------

@mcp_tool(
    name="read_method_source_by_method_name",
    description=(
        "Read the complete source code of a Java method by its fully qualified name. "
        "Returns the method source with optional Javadoc and annotations. "
        "Handles overloaded methods by returning candidates when parameter_types "
        "are not specified."
    ),
)
async def read_method_source_by_method_name(
    method_full_name: str,
    repository_path: str,
    parameter_types: list[str] | None = None,
    include_javadoc: bool = True,
    include_annotations: bool = True,
    language: str = "java",
) -> dict:
    """
    Read method source code by fully qualified name.

    Args:
        method_full_name: Fully qualified method name,
                          e.g. "com.example.UserController.getUser"
        repository_path: Absolute path to the repository root
        parameter_types: Parameter type list for overload disambiguation,
                         e.g. ["HttpServletRequest", "String"]. If not provided
                         and overloads exist, returns ambiguous candidates.
        include_javadoc: If true (default), include Javadoc in source
        include_annotations: If true (default), include annotations in source
        language: Programming language (default: java)
    """
    # --- 参数校验 ---
    if not method_full_name:
        return {"found": False, "error": "method_full_name is required"}

    if not repository_path or not os.path.isdir(repository_path):
        return {"found": False, "error": "Invalid repository_path"}

    # --- 解析方法全限定名 ---
    package, class_name, method_name = _parse_method_full_name(method_full_name)

    if not method_name:
        return {
            "method_full_name": method_full_name,
            "found": False,
            "error": "Could not parse method name from method_full_name",
        }

    # --- 定位文件 ---
    filepath = _find_class_file(repository_path, package, class_name)
    if not filepath:
        return {
            "method_full_name": method_full_name,
            "found": False,
            "error": f"Class file not found for {package}.{class_name}" if package else f"Class file not found for {class_name}",
        }

    logger.info(
        "read_method_source: method=%s, file=%s",
        method_full_name, filepath,
    )

    # --- 读取方法源码 ---
    return _read_method_source(
        filepath,
        repository_path,
        package,
        class_name,
        method_name,
        parameter_types,
        include_javadoc,
        include_annotations,
    )
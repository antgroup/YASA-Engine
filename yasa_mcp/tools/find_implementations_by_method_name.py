"""
MCP Tool: find_implementations_by_method_name

给定接口的全限定名 + 方法名（可选形参类型消歧），返回所有实现该方法的位置 —
包括所在类、方法签名、文件路径、行号。

基于 find_implementations_by_interface_name 的类索引，进一步解析每个实现类
中的方法定义，定位到方法级别。
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
    _find_implementations,
)

logger = logging.getLogger("yasa_mcp.tools.find_implementations_by_method_name")


# ---------------------------------------------------------------------------
# Java 方法解析
# ---------------------------------------------------------------------------

# 匹配 Java 方法定义
# 格式: [@Override] [modifiers] [abstract] return_type method_name(params) [throws ...] { body }
#   或: [@Override] [modifiers] [abstract] return_type method_name(params) [throws ...] ;  (抽象方法/接口声明)
#
# 分组说明:
#   group(1): 方法前所有注解（如 @Override, @SuppressWarnings）
#   group(2): abstract 关键字（有则说明是抽象方法）
#   group(3): 返回类型
#   group(4): 方法名
#   group(5): 参数列表原文
#   group(6): 结尾符号 { 或 ;

_METHOD_PATTERN = re.compile(
    r"(?:@\w+(?:\([^)]*\))?\s+)*"                    # 注解（如 @Override, @SuppressWarnings("unchecked")）
    r"(?:public|protected|private|static|final|synchronized|default|native|\s)*"  # 修饰符
    r"(abstract\s+)?"                                # abstract 关键字
    r"([\w.<>?,\[\]\s]+?)\s+"                       # 返回类型
    r"(\w+)\s*"                                      # 方法名
    r"\(\s*([^)]*)\s*\)"                            # 参数列表
    r"(?:\s*throws\s+[\w.,\s]+)?"                    # throws 子句
    r"\s*(\{|;)",                                    # 方法体 { 或声明 ;
    re.MULTILINE,
)


def _parse_method_params(params_str: str) -> list[str]:
    """
    解析方法参数列表字符串，返回参数类型列表。

    例如: "Object request, String mode" -> ["Object", "String"]
         "" -> []
    """
    if not params_str.strip():
        return []

    result: list[str] = []
    # 按逗号分割，但注意泛型中的逗号（如 Map<String, Object> arg）
    # 简化处理：按 ", " 分割，取每段最后一个空格前的部分作为类型
    parts = _split_params(params_str)
    for part in parts:
        part = part.strip()
        if not part:
            continue
        # 参数格式: "Type name" 或 "final Type name" 或 "Type... name" (可变参数)
        # 取最后一个空格前的部分作为类型
        tokens = part.rsplit(None, 1)
        if len(tokens) == 2:
            param_type = tokens[0]
            # 去掉可变参数的 ...
            param_type = param_type.replace("...", "")
            # 去掉泛型参数中的通配符前缀
            result.append(param_type.strip())
        else:
            # 只有类型没有参数名（如接口声明中可能出现的）
            result.append(part.replace("...", "").strip())

    return result


def _split_params(params_str: str) -> list[str]:
    """
    按顶层逗号分割参数列表，忽略泛型尖括号内的逗号。
    """
    result: list[str] = []
    current: list[str] = []
    depth = 0

    for ch in params_str:
        if ch == "<":
            depth += 1
            current.append(ch)
        elif ch == ">":
            depth -= 1
            current.append(ch)
        elif ch == "," and depth == 0:
            result.append("".join(current))
            current = []
        else:
            current.append(ch)

    if current:
        result.append("".join(current))

    return result


def _build_method_signature(
    method_name: str,
    param_types: list[str],
    return_type: str,
) -> str:
    """
    构建方法签名字符串。

    例如: "validate(Object): boolean"
    """
    params_str = ", ".join(param_types) if param_types else ""
    return f"{method_name}({params_str}): {return_type.strip()}"


def _parse_java_methods(
    filepath: str,
    content: str,
    class_name: str,
) -> list[dict[str, Any]]:
    """
    解析 Java 文件中指定类的方法定义。

    返回每个方法的: {
        method_name, return_type, parameter_types, line_number,
        is_abstract, is_override, method_signature
    }
    """
    results: list[dict[str, Any]] = []

    # 找到类定义的位置，只搜索该类的范围
    # 简化：在整个文件内容中搜索方法定义，然后通过方法名和位置过滤
    # 对于大多数情况，一个 Java 文件通常只有一个顶级类
    for m in _METHOD_PATTERN.finditer(content):
        method_name = m.group(3)

        # 跳过构造方法（方法名与类名相同）
        if method_name == class_name:
            continue

        # 跳过很可能是字段或其他非方法定义
        # 方法名应该是一个合法的 Java 标识符
        if not method_name[0].islower() and method_name[0] != "_":
            # 允许一些特殊情况，但如果不是小写字母开头，很可能是误匹配
            # 例如枚举常量、静态块等
            # 但要保留一些可能的命名（如 _method）
            if not method_name.replace("_", "").isalnum():
                continue

        is_abstract = m.group(1) is not None
        return_type = m.group(2).strip()
        params_raw = m.group(4)
        ending = m.group(5)

        # 如果以 ; 结尾且有 abstract 关键字，是抽象方法声明
        # 如果以 ; 结尾但没有 abstract，可能是接口方法声明
        is_declaration = ending == ";"
        if is_declaration and not is_abstract:
            # 接口方法声明（非 abstract 但以 ; 结尾）
            is_abstract = True

        # 解析参数类型
        param_types = _parse_method_params(params_raw)

        # 检测 @Override 注解
        # group(0) 包含了注解部分，检查是否包含 @Override
        full_match = m.group(0)
        is_override = "@Override" in full_match

        # 计算行号
        line_number = content[:m.start()].count("\n") + 1

        # 构建方法签名
        method_signature = _build_method_signature(
            method_name, param_types, return_type
        )

        results.append({
            "method_name": method_name,
            "return_type": return_type,
            "parameter_types": param_types,
            "line_number": line_number,
            "is_abstract": is_abstract,
            "is_override": is_override,
            "method_signature": method_signature,
        })

    return results


def _parse_anonymous_class_methods(
    content: str,
    anon_start: int,
    anon_class_simple_name: str,
) -> list[dict[str, Any]]:
    """
    解析匿名类中的方法定义。

    anon_start 是匿名类定义开始的位置（new InterfaceName() { 的位置）。
    """
    # 找到匿名类体的范围：从 { 到匹配的 }
    brace_start = content.index("{", anon_start)
    brace_end = _find_matching_brace(content, brace_start)

    if brace_end == -1:
        brace_end = len(content)

    anon_body = content[brace_start + 1:brace_end]

    # 在匿名类体中搜索方法
    return _parse_java_methods("", anon_body, anon_class_simple_name)


def _find_matching_brace(content: str, start: int) -> int:
    """找到与 start 位置的 { 匹配的 } 位置。"""
    depth = 0
    for i in range(start, len(content)):
        if content[i] == "{":
            depth += 1
        elif content[i] == "}":
            depth -= 1
            if depth == 0:
                return i
    return -1


def _params_match(
    method_param_types: list[str],
    requested_param_types: list[str] | None,
) -> bool:
    """
    检查方法的参数类型是否与请求的参数类型匹配。

    匹配规则：
    - 如果 requested_param_types 为 None，匹配所有
    - 简单名匹配：如 method 的 "Object" 匹配 request 的 "Object" 或 "java.lang.Object"
    - 最后一个组件匹配：如 "com.example.Request" 匹配 "Request"
    """
    if requested_param_types is None:
        return True

    if len(method_param_types) != len(requested_param_types):
        return False

    for method_type, requested_type in zip(method_param_types, requested_param_types):
        method_type = method_type.strip()
        requested_type = requested_type.strip()

        # 完全匹配
        if method_type == requested_type:
            continue

        # 去掉泛型后比较
        method_base = re.sub(r"<.*>", "", method_type).strip()
        requested_base = re.sub(r"<.*>", "", requested_type).strip()

        if method_base == requested_base:
            continue

        # 简单名匹配（取最后一个 . 后的部分）
        method_simple = method_base.split(".")[-1]
        requested_simple = requested_base.split(".")[-1]

        if method_simple == requested_simple:
            continue

        return False

    return True


# ---------------------------------------------------------------------------
# MCP Tool
# ---------------------------------------------------------------------------

@mcp_tool(
    name="find_implementations_by_method_name",
    description=(
        "Find all implementations of a specific interface method in a repository. "
        "Given an interface full name and method name, returns the implementing classes, "
        "method signatures, file paths, and line numbers. Supports parameter type "
        "disambiguation for overloaded methods."
    ),
)
async def find_implementations_by_method_name(
    interface_full_name: str,
    method_name: str,
    repository_path: str,
    parameter_types: list[str] | None = None,
) -> dict:
    """
    Find all implementations of a specific interface method.

    Args:
        interface_full_name: Fully qualified interface name, e.g. "com.example.RequestValidator"
        method_name: Method name to search for, e.g. "validate"
        repository_path: Absolute path to the repository root
        parameter_types: Optional parameter type list for overload disambiguation,
                         e.g. ["com.example.Request"]. If not provided, all overloads are returned.
    """
    # 参数校验
    if not interface_full_name or not method_name:
        return {
            "interface_full_name": interface_full_name,
            "method_name": method_name,
            "total_implementations": 0,
            "implementations": [],
        }

    if not repository_path or not os.path.isdir(repository_path):
        return {
            "interface_full_name": interface_full_name,
            "method_name": method_name,
            "total_implementations": 0,
            "implementations": [],
        }

    logger.info(
        "find_implementations_by_method_name: interface=%s, method=%s, repo=%s",
        interface_full_name, method_name, repository_path,
    )

    # 1. 构建类索引（复用 #128 的逻辑）
    index = _build_class_index(repository_path)

    # 2. 查找匿名实现类并加入索引
    anonymous_impls = _find_anonymous_impls(repository_path, index)
    for iface_simple, anon_list in anonymous_impls.items():
        for anon_info in anon_list:
            index[anon_info["class_full_name"]] = anon_info

    # 3. 查找接口的所有实现类（包含抽象类）
    impl_classes = _find_implementations(
        interface_full_name, index, include_abstract=True
    )

    # 4. 在每个实现类中查找目标方法
    implementations: list[dict[str, Any]] = []

    # 同时也查找接口本身的方法定义（用于获取接口方法的签名信息）
    # 但接口方法声明不应出现在结果中

    for impl_class in impl_classes:
        class_full_name = impl_class["class_full_name"]
        file_path = impl_class["file_path"]

        # 获取类的绝对路径
        abs_filepath = os.path.join(repository_path, file_path)

        if not os.path.isfile(abs_filepath):
            continue

        try:
            with open(abs_filepath, "r", encoding="utf-8", errors="replace") as f:
                file_content = f.read()
        except OSError:
            continue

        # 获取类信息
        class_info = index.get(class_full_name, {})
        is_abstract_class = class_info.get("is_abstract", False)
        class_simple_name = class_info.get("simple_name", class_full_name.split(".")[-1])

        # 解析类中的方法
        if "$" in class_simple_name:
            # 匿名类：解析匿名类体中的方法
            # 找到匿名类定义的位置
            anon_pattern = re.compile(
                r"new\s+\w+\s*\([^)]*\)\s*\{",
            )
            methods: list[dict[str, Any]] = []
            for m in anon_pattern.finditer(file_content):
                anon_methods = _parse_anonymous_class_methods(
                    file_content, m.start(), class_simple_name
                )
                methods.extend(anon_methods)
        else:
            methods = _parse_java_methods(abs_filepath, file_content, class_simple_name)

        # 过滤出匹配的方法
        for method in methods:
            if method["method_name"] != method_name:
                continue

            # 参数类型消歧
            if not _params_match(method["parameter_types"], parameter_types):
                continue

            # 跳过抽象方法（仅声明未实现）
            if method["is_abstract"]:
                continue

            implementations.append({
                "class_full_name": class_full_name,
                "method_signature": method["method_signature"],
                "file_path": file_path,
                "line_number": method["line_number"],
                "is_override_annotation_present": method["is_override"],
            })

    return {
        "interface_full_name": interface_full_name,
        "method_name": method_name,
        "total_implementations": len(implementations),
        "implementations": implementations,
    }
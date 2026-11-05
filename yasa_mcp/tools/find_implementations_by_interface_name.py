"""
MCP Tool: find_implementations_by_interface_name

给定 Java 接口的全限定名，在指定代码仓库内检索并返回该接口的所有实现类位置
（类名、文件路径、定义行号），包括直接 implements 与通过抽象类间接实现的情况。

通过子进程调用 YASA Engine 的 client.ts 交互模式，使用 getsubclass 命令查询继承关系，
然后用正则解析 Java 文件补充文件路径、行号和 kind 信息。
"""

from __future__ import annotations

import os
import re
import json
import logging
import subprocess
import asyncio
from typing import Any

from yasa_mcp.registry import mcp_tool

logger = logging.getLogger("yasa_mcp.tools.find_implementations_by_interface_name")

# 默认排除的目录
_EXCLUDED_DIRS = frozenset({
    ".git", "node_modules", "target", "build", "dist",
    "__pycache__", ".venv", "venv", ".idea", ".vscode",
})


def _find_java_files(repo_path: str) -> list[str]:
    """遍历仓库，返回所有 Java 文件的绝对路径"""
    result: list[str] = []
    for dirpath, dirnames, filenames in os.walk(repo_path):
        dirnames[:] = [d for d in dirnames if d not in _EXCLUDED_DIRS]
        for f in filenames:
            if f.endswith(".java"):
                result.append(os.path.join(dirpath, f))
    return result


def _parse_java_file(filepath: str) -> list[dict[str, Any]]:
    """
    解析 Java 文件，返回所有类/接口定义的列表。
    每个元素: {class_name, line_number, is_abstract, is_interface, extends, implements}
    支持内部类。
    """
    try:
        with open(filepath, "r", encoding="utf-8", errors="replace") as f:
            content = f.read()
    except OSError:
        return []

    results: list[dict[str, Any]] = []

    # 提取 package
    pkg_match = re.search(r"^\s*package\s+([\w.]+)\s*;", content, re.MULTILINE)
    package_name = pkg_match.group(1) if pkg_match else None

    # 匹配所有 class/interface 定义（包括内部类）
    # 格式: [modifiers] abstract? class|interface ClassName [generic] [extends ...] [implements ...] {
    pattern = re.compile(
        r"(?:public|protected|private|final|static|\s)*"
        r"(abstract\s+)?"
        r"(class|interface)\s+"
        r"(\w+)"
        r"(?:\s*<[^{]*?>)?"
        r"(?:\s+extends\s+([\w.,\s<>]+?))?"
        r"(?:\s+implements\s+([\w.,\s<>]+?))?"
        r"\s*\{",
        re.DOTALL,
    )

    for m in pattern.finditer(content):
        is_abstract = m.group(1) is not None
        keyword = m.group(2)
        class_name = m.group(3)

        # 计算行号
        line_number = content[:m.start()].count("\n") + 1

        extends_list: list[str] = []
        implements_list: list[str] = []

        if m.group(4):
            extends_raw = m.group(4).strip()
            extends_list = [s.strip().split("<")[0] for s in extends_raw.split(",")]
        if m.group(5):
            implements_raw = m.group(5).strip()
            implements_list = [s.strip().split("<")[0] for s in implements_raw.split(",")]

        results.append({
            "package": package_name,
            "class_name": class_name,
            "line_number": line_number,
            "is_abstract": is_abstract,
            "is_interface": keyword == "interface",
            "extends": extends_list,
            "implements": implements_list,
        })

    return results


def _build_class_index(repo_path: str) -> dict[str, dict[str, Any]]:
    """
    扫描仓库所有 Java 文件，构建类名 -> 信息的索引。
    包括: full_name, file_path, line_number, is_abstract, is_interface, implements_list, extends_list
    """
    index: dict[str, dict[str, Any]] = {}

    for filepath in _find_java_files(repo_path):
        classes = _parse_java_file(filepath)
        if not classes:
            continue

        rel_path = os.path.relpath(filepath, repo_path)

        for cls in classes:
            package_name = cls["package"]
            class_name = cls["class_name"]
            full_name = f"{package_name}.{class_name}" if package_name else class_name

            # 对于内部类，用 OuterClass$InnerClass 作为 full_name
            if len(classes) > 1 and not cls["is_interface"] and package_name:
                # 检查是否是内部类（不是文件中第一个类定义）
                outer_class = classes[0]["class_name"]
                if class_name != outer_class:
                    full_name = f"{package_name}.{outer_class}${class_name}"

            index[full_name] = {
                "full_name": full_name,
                "simple_name": class_name,
                "file_path": rel_path,
                "line_number": cls["line_number"],
                "is_abstract": cls["is_abstract"],
                "is_interface": cls["is_interface"],
                "extends": cls["extends"],
                "implements": cls["implements"],
            }

    return index


def _find_anonymous_impls(
    repo_path: str, index: dict[str, dict[str, Any]]
) -> dict[str, list[dict[str, Any]]]:
    """
    扫描所有 Java 文件，查找匿名实现类。
    匿名类格式: new InterfaceName() { ... }
    
    返回: 接口简单名 -> 匿名类信息列表
    """
    result: dict[str, list[dict[str, Any]]] = {}

    for filepath in _find_java_files(repo_path):
        try:
            with open(filepath, "r", encoding="utf-8", errors="replace") as f:
                content = f.read()
        except OSError:
            continue

        rel_path = os.path.relpath(filepath, repo_path)

        # 匹配 new InterfaceName() { — 匿名实现类
        # 排除 new InterfaceName() 后面不跟 { 的情况（普通实例化）
        pattern = re.compile(
            r"new\s+(\w+)\s*\(\s*\)\s*\{",
        )

        for m in pattern.finditer(content):
            interface_simple_name = m.group(1)
            line_number = content[:m.start()].count("\n") + 1

            # 获取包名
            pkg_match = re.search(r"^\s*package\s+([\w.]+)\s*;", content, re.MULTILINE)
            package_name = pkg_match.group(1) if pkg_match else ""

            # 匿名类命名: PackageName.FileName$序号
            filename = os.path.basename(filepath).replace(".java", "")
            # 计算这是文件中第几个匿名类
            anon_count_before = len(list(pattern.finditer(content[:m.start()])))
            anon_name = f"{package_name}.{filename}${anon_count_before + 1}" if package_name else f"{filename}${anon_count_before + 1}"

            if interface_simple_name not in result:
                result[interface_simple_name] = []

            result[interface_simple_name].append({
                "class_full_name": anon_name,
                "file_path": rel_path,
                "line_number": line_number,
                "is_abstract": False,
                "is_interface": False,
                "simple_name": f"{filename}${anon_count_before + 1}",
                "extends": [],
                "implements": [interface_simple_name],
            })

    return result


def _find_all_supers(class_info: dict[str, Any]) -> list[str]:
    """获取一个类的所有父类和接口（简单名）"""
    return class_info.get("extends", []) + class_info.get("implements", [])


def _resolve_simple_name_to_full(
    simple_name: str, index: dict[str, dict[str, Any]]
) -> list[str]:
    """通过简单名查找所有可能的全限定名"""
    result = []
    for full_name, info in index.items():
        if info["simple_name"] == simple_name:
            result.append(full_name)
    # 也可能是全限定名直接传入
    if simple_name in index:
        if simple_name not in result:
            result.append(simple_name)
    return result


def _find_implementations(
    interface_full_name: str,
    index: dict[str, dict[str, Any]],
    include_abstract: bool,
) -> list[dict[str, Any]]:
    """
    在索引中查找接口的所有实现类。
    支持直接 implements 和通过抽象类间接 extends。
    """
    result: list[dict[str, Any]] = []
    visited: set[str] = set()

    # 先确认接口存在
    interface_info = index.get(interface_full_name)
    if not interface_info:
        # 尝试去掉泛型参数
        base_name = re.sub(r"<.*>", "", interface_full_name) if "<" in interface_full_name else interface_full_name
        interface_info = index.get(base_name)
        if interface_info:
            interface_full_name = base_name

    if not interface_info:
        # 接口不在索引中，仍然扫描所有类看是否 implements 了同名接口
        interface_simple = interface_full_name.split(".")[-1]
    else:
        interface_simple = interface_info["simple_name"]

    # 递归查找
    def search(iface_name: str, iface_simple: str):
        for full_name, info in index.items():
            if full_name in visited:
                continue

            # 检查是否直接 implements 或 extends 这个接口
            all_supers = _find_all_supers(info)
            matched = False

            for super_name in all_supers:
                super_full_names = _resolve_simple_name_to_full(super_name, index)
                if iface_name in super_full_names:
                    matched = True
                    break
                # 也检查简单名匹配
                if super_name == iface_simple:
                    matched = True
                    break

            if matched:
                visited.add(full_name)
                # 接口 extends 接口：不加入结果，但继续递归查找子接口和实现类
                # 类 implements/extends：加入结果
                if not info["is_interface"]:
                    if include_abstract or not info["is_abstract"]:
                        result.append({
                            "class_full_name": full_name,
                            "file_path": info["file_path"],
                            "line_number": info["line_number"],
                            "kind": "abstract_class" if info["is_abstract"] else "class",
                        })
                # 递归查找这个类的子类/子接口（间接实现）
                search(full_name, info["simple_name"])

    search(interface_full_name, interface_simple)
    return result


@mcp_tool(
    name="find_implementations_by_interface_name",
    description=(
        "Find all implementation classes of a given Java interface in a repository. "
        "Returns class names, file paths, line numbers, and kind (class/abstract_class). "
        "Supports direct implements and indirect extends through abstract classes."
    ),
)
async def find_implementations_by_interface_name(
    interface_full_name: str,
    repository_path: str,
    include_abstract_classes: bool = True,
) -> dict:
    """
    Find all classes implementing a given Java interface.

    Args:
        interface_full_name: Fully qualified interface name, e.g. "com.example.RequestValidator"
        repository_path: Absolute path to the repository root
        include_abstract_classes: If true (default), include abstract classes as implementations
    """
    if not interface_full_name:
        return {
            "interface_full_name": "",
            "total_implementations": 0,
            "implementations": [],
        }

    if not repository_path or not os.path.isdir(repository_path):
        return {
            "interface_full_name": interface_full_name,
            "total_implementations": 0,
            "implementations": [],
        }

    logger.info(
        "find_implementations_by_interface_name: interface=%s, repo=%s",
        interface_full_name, repository_path,
    )

    # 构建类索引
    index = _build_class_index(repository_path)

    # 查找匿名实现类
    anonymous_impls = _find_anonymous_impls(repository_path, index)

    # 将匿名类加入索引
    for iface_simple, anon_list in anonymous_impls.items():
        for anon_info in anon_list:
            index[anon_info["class_full_name"]] = anon_info

    # 查找实现类
    implementations = _find_implementations(
        interface_full_name, index, include_abstract_classes
    )

    return {
        "interface_full_name": interface_full_name,
        "total_implementations": len(implementations),
        "implementations": implementations,
    }
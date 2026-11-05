"""
MCP Tool: find_callers_by_method_name

反向引用查询: 给定一个方法的全限定名, 返回仓库内所有调用该方法的位置。
包括调用方所在方法、行号、调用表达式片段。
支持把通过父类/接口间接调用的位置也算上。

实现分三步:
1. 索引构建: 遍历仓库, 构建方法索引 + 类继承索引
2. 调用点提取: 逐文件搜索调用表达式
3. 类型解析: 推断接收者类型, 判断是否匹配目标
"""

from __future__ import annotations

import os
import re
import logging
from typing import Any

from yasa_mcp.registry import mcp_tool
from yasa_mcp.tools.search_code_by_signature_pattern import (
    _strip_comments,
    _find_java_files,
    _extract_package,
    _compute_line_depths,
    _build_class_ranges_by_depth,
)
from yasa_mcp.tools.read_method_source_by_method_name import (
    _parse_method_full_name,
    _extract_all_method_ranges,
    _extract_method_info,
    _find_class_file,
)
from yasa_mcp.tools.list_methods_by_class_name import (
    _extract_class_metadata,
)

logger = logging.getLogger("yasa_mcp.tools.find_callers_by_method_name")

_MAX_RESULTS_LIMIT = 1000


# ---------------------------------------------------------------------------
# Step 1: 索引构建
# ---------------------------------------------------------------------------

def _build_method_index(
    repository_path: str,
) -> tuple[dict[str, dict[str, Any]], dict[str, dict[str, Any]]]:
    """
    遍历仓库, 构建方法索引和类继承索引。

    返回:
        method_index: {方法全限定名: {class, method_name, param_types, is_static, file_path, start_line}}
        class_index: {类全限定名: {extends, implements, all_parents}}
    """
    method_index: dict[str, dict[str, Any]] = {}
    class_index: dict[str, dict[str, Any]] = {}

    for filepath in _find_java_files(repository_path):
        try:
            with open(filepath, "r", encoding="utf-8", errors="replace") as f:
                content = f.read()
        except (OSError, IOError):
            continue

        stripped = _strip_comments(content)
        lines = stripped.split("\n")
        package = _extract_package(stripped)

        if not package:
            continue

        depths = _compute_line_depths(lines)
        class_info = _build_class_ranges_by_depth(lines, depths, package)

        # 构建类继承索引
        for cls_start, cls_end, cls_full_name in class_info:
            metadata = _extract_class_metadata(lines, class_info, cls_full_name)
            class_index[cls_full_name] = {
                "extends": metadata.get("extends_class"),
                "implements": metadata.get("implements_interfaces", []),
                "all_parents": [],  # 后面递归填充
                "file_path": filepath,
            }

        # 构建方法索引
        methods = _extract_all_method_ranges(lines, depths, class_info, package)
        for method in methods:
            if method["method_name"] == "<static_init>":
                continue

            method_key = method["containing_method"]
            line = method.get("_match_line", lines[method["start_line"]])

            # 提取方法信息
            m_match = re.search(r"(\w+)\s*\(([^)]*)\)\s*(\{|;)", line)
            if not m_match:
                continue

            info = _extract_method_info(line, m_match)
            method_index[method_key] = {
                "class_full_name": method["containing_class"],
                "method_name": method["method_name"],
                "param_types": info["param_types"],
                "return_type": info["return_type"],
                "is_static": "static" in line[:m_match.start(1)].split(),
                "is_abstract": info["is_abstract"],
                "file_path": filepath,
                "start_line": method["start_line"],
            }

    # 递归填充 all_parents
    _fill_all_parents(class_index, repository_path)

    return method_index, class_index


def _fill_all_parents(
    class_index: dict[str, dict[str, Any]],
    repository_path: str,
) -> None:
    """递归填充每个类的 all_parents 列表。"""
    for class_name in class_index:
        visited: set[str] = set()
        _collect_parents(class_name, class_index, repository_path, visited)
        class_index[class_name]["all_parents"] = list(visited - {class_name})


def _collect_parents(
    class_name: str,
    class_index: dict[str, dict[str, Any]],
    repository_path: str,
    visited: set[str],
) -> None:
    """递归收集类的所有父类和接口。"""
    if class_name in visited:
        return
    visited.add(class_name)

    info = class_index.get(class_name)
    if not info:
        return

    extends = info.get("extends")
    if extends:
        # 尝试构造全限定名
        if "." not in extends:
            # 简单名, 尝试在同包中查找
            pkg = class_name.rsplit(".", 1)[0] if "." in class_name else ""
            extends_full = f"{pkg}.{extends}" if pkg else extends
        else:
            extends_full = extends
        _collect_parents(extends_full, class_index, repository_path, visited)

    for iface in info.get("implements", []):
        if "." not in iface:
            pkg = class_name.rsplit(".", 1)[0] if "." in class_name else ""
            iface_full = f"{pkg}.{iface}" if pkg else iface
        else:
            iface_full = iface
        _collect_parents(iface_full, class_index, repository_path, visited)


# ---------------------------------------------------------------------------
# Step 2: 调用点提取
# ---------------------------------------------------------------------------

# 调用表达式正则: 接收者.方法名( 或 接收者::方法名
_CALL_PATTERN = re.compile(r"(\w+)\.(\w+)\s*\(")
_METHOD_REF_PATTERN = re.compile(r"(\w+)::(\w+)")
# 无接收者调用: methodName( — 同类内部方法调用
# 排除 new Xxx( (构造器调用) 和 方法声明
_BARE_CALL_PATTERN = re.compile(r"\b(\w+)\s*\(")


def _strip_strings(content: str) -> str:
    """
    将字符串字面量内容替换为空格, 保留引号和换行符。
    避免 "_BARE_CALL_PATTERN" 匹配字符串内的 "foo.bar();"。
    """
    result: list[str] = []
    i = 0
    in_string = False
    in_char = False

    while i < len(content):
        ch = content[i]

        if in_string:
            if ch == "\\" and i + 1 < len(content):
                result.append("  ")  # 转义字符替换为2个空格
                i += 2
                continue
            if ch == '"':
                result.append('"')
                in_string = False
            else:
                result.append("\n" if ch == "\n" else " ")
            i += 1
            continue

        if in_char:
            if ch == "\\" and i + 1 < len(content):
                result.append("  ")
                i += 2
                continue
            if ch == "'":
                result.append("'")
                in_char = False
            else:
                result.append("\n" if ch == "\n" else " ")
            i += 1
            continue

        if ch == '"':
            result.append('"')
            in_string = True
            i += 1
            continue

        if ch == "'":
            result.append("'")
            in_char = True
            i += 1
            continue

        result.append(ch)
        i += 1

    return "".join(result)


def _build_import_map(stripped: str) -> tuple[dict[str, str], dict[str, str]]:
    """
    从文件内容中提取 import 语句。

    返回:
        import_map: 简单名 → 全限定类名 (普通 import)
        static_import_map: 方法名 → 全限定类名 (静态导入的方法)
            import static com.example.Utils.calculate;
            → {"calculate": "com.example.Utils"}
    """
    import_map: dict[str, str] = {}
    static_import_map: dict[str, str] = {}

    for m in re.finditer(r"^\s*import\s+(static\s+)?([\w.]+);", stripped, re.MULTILINE):
        is_static = m.group(1) is not None
        full_name = m.group(2)

        if full_name.endswith(".*"):
            continue  # 通配符, 跳过

        if is_static:
            # import static com.example.Utils.calculate
            # 最后一段是方法名, 前面是类全限定名
            parts = full_name.rsplit(".", 1)
            if len(parts) == 2:
                method_name = parts[1]
                class_full_name = parts[0]
                static_import_map[method_name] = class_full_name
        else:
            # import com.example.dao.UserDao
            simple_name = full_name.rsplit(".", 1)[-1]
            import_map[simple_name] = full_name

    return import_map, static_import_map


def _is_test_file(filepath: str) -> bool:
    """判断是否是测试文件。"""
    parts = filepath.replace("\\", "/").split("/")
    return any(p in ("test", "tests") for p in parts) or filepath.endswith("Test.java") or filepath.endswith("Tests.java")


def _find_call_sites(
    filepath: str,
    repository_path: str,
    method_short_name: str,
    target_method_keys: set[str],
    include_test_code: bool,
    max_results: int,
    results: list[dict[str, Any]],
    method_index: dict[str, dict[str, Any]],
    class_index: dict[str, dict[str, Any]],
) -> int:
    """
    在单个文件中搜索调用目标方法的位置。

    返回本次新增的匹配数。
    """
    try:
        with open(filepath, "r", encoding="utf-8", errors="replace") as f:
            content = f.read()
    except (OSError, IOError):
        return 0

    is_test = _is_test_file(filepath)
    if is_test and not include_test_code:
        return 0

    stripped = _strip_comments(content)
    stripped = _strip_strings(stripped)  # 移除字符串内容, 避免伪命中
    lines = stripped.split("\n")
    raw_lines = content.split("\n")
    package = _extract_package(stripped)
    import_map, static_import_map = _build_import_map(stripped)

    depths = _compute_line_depths(lines)
    class_info = _build_class_ranges_by_depth(lines, depths, package)
    methods = _extract_all_method_ranges(lines, depths, class_info, package)

    # 收集方法声明的位置 (行号, 方法名起始列), 搜索时跳过这些位置
    # 不跳过整个行, 因为方法声明行内可能有其他调用
    method_decl_positions: list[tuple[int, int, int]] = []  # (line, name_start, paren_end)
    for m in methods:
        if m["method_name"] == "<static_init>":
            continue
        line = m.get("_match_line", lines[m["start_line"]])
        m_match = re.search(r"(\w+)\s*\(([^)]*)\)\s*(\{|;)", line)
        if not m_match:
            continue

        # 验证是否为真正的方法声明: 方法名前面应有返回类型或修饰符
        # 排除 static { init(); } 中的 init() 被误判为方法声明
        prefix_before_name = line[:m_match.start(1)].strip()
        if not prefix_before_name:
            # 方法名前没有任何内容 (如 { init(); }), 不是方法声明
            continue
        # 检查前缀是否以 { 或 } 结尾 (表示在代码块内, 不是声明)
        if prefix_before_name.endswith("{") or prefix_before_name.endswith("}"):
            continue

        method_decl_positions.append((m["start_line"], m_match.start(1), m_match.end(3)))

    rel_path = os.path.relpath(filepath, repository_path)
    added = 0

    for i, line in enumerate(lines):
        if method_short_name not in line:
            continue  # 快速过滤

        # 搜索普通调用: receiver.methodName(
        for m in _CALL_PATTERN.finditer(line):
            receiver = m.group(1)
            called_name = m.group(2)

            if called_name != method_short_name:
                continue

            # 跳过方法声明 (匹配位置在声明范围内)
            if _is_in_declaration(i, m.start(), method_decl_positions):
                continue

            # 推断接收者类型
            receiver_type = _resolve_receiver_type(
                receiver, i, lines, raw_lines, methods, class_info,
                package, import_map, method_index, class_index,
            )

            # 检查是否匹配目标方法集合
            if _is_matching_receiver(receiver_type, target_method_keys, class_index):
                # 找到调用方方法
                caller_method = _find_containing_method(i, methods)
                caller_class = caller_method["containing_class"] if caller_method else ""

                results.append({
                    "caller_method_full_name": caller_method["containing_method"] if caller_method else "",
                    "file_path": rel_path,
                    "line_number": i + 1,
                    "call_expression_snippet": line.strip()[:200],
                    "caller_class": caller_class,
                    "is_test_code": is_test,
                })
                added += 1

                if len(results) >= max_results:
                    return added

        # 搜索方法引用: Receiver::methodName
        for m in _METHOD_REF_PATTERN.finditer(line):
            receiver = m.group(1)
            called_name = m.group(2)

            if called_name != method_short_name:
                continue

            if _is_in_declaration(i, m.start(), method_decl_positions):
                continue

            receiver_type = _resolve_receiver_type(
                receiver, i, lines, raw_lines, methods, class_info,
                package, import_map, method_index, class_index,
            )

            if _is_matching_receiver(receiver_type, target_method_keys, class_index):
                caller_method = _find_containing_method(i, methods)
                caller_class = caller_method["containing_class"] if caller_method else ""

                results.append({
                    "caller_method_full_name": caller_method["containing_method"] if caller_method else "",
                    "file_path": rel_path,
                    "line_number": i + 1,
                    "call_expression_snippet": line.strip()[:200],
                    "caller_class": caller_class,
                    "is_test_code": is_test,
                })
                added += 1

                if len(results) >= max_results:
                    return added

        # 搜索无接收者调用: methodName( — 同类内部方法调用或静态导入调用
        for m in _BARE_CALL_PATTERN.finditer(line):
            called_name = m.group(1)
            if called_name != method_short_name:
                continue

            # 跳过构造器调用: new Xxx(
            before_match = line[:m.start()].rstrip()
            if before_match.endswith("new"):
                continue

            # 跳过方法声明
            if _is_in_declaration(i, m.start(), method_decl_positions):
                continue

            # 确定接收者类型:
            # 1. 如果方法名在 static_import_map 中, 接收者是导入的类
            # 2. 否则接收者隐含为 this → 当前类
            if called_name in static_import_map:
                receiver_type = static_import_map[called_name]
            else:
                receiver_type = None
                for cls_start, cls_end, cls_full_name in class_info:
                    if cls_start < i < cls_end:
                        receiver_type = cls_full_name
                        break

            if _is_matching_receiver(receiver_type, target_method_keys, class_index):
                caller_method = _find_containing_method(i, methods)
                caller_class = caller_method["containing_class"] if caller_method else ""

                results.append({
                    "caller_method_full_name": caller_method["containing_method"] if caller_method else "",
                    "file_path": rel_path,
                    "line_number": i + 1,
                    "call_expression_snippet": line.strip()[:200],
                    "caller_class": caller_class,
                    "is_test_code": is_test,
                })
                added += 1

                if len(results) >= max_results:
                    return added

    return added


def _is_in_declaration(
    line_idx: int,
    match_start: int,
    decl_positions: list[tuple[int, int, int]],
) -> bool:
    """检查匹配位置是否在方法声明范围内。"""
    for dl, name_start, paren_end in decl_positions:
        if dl == line_idx and name_start <= match_start < paren_end:
            return True
    return False


# ---------------------------------------------------------------------------
# Step 3: 类型解析
# ---------------------------------------------------------------------------

def _resolve_receiver_type(
    receiver: str,
    line_idx: int,
    lines: list[str],
    raw_lines: list[str],
    methods: list[dict[str, Any]],
    class_info: list[tuple[int, int, str]],
    package: str | None,
    import_map: dict[str, str],
    method_index: dict[str, dict[str, Any]],
    class_index: dict[str, dict[str, Any]],
) -> str | None:
    """
    推断调用表达式中接收者的类型。

    receiver: 调用表达式中的接收者 (如 userDao, UserDao, this, super)
    返回: 全限定类名, 或 None 表示无法确定
    """
    # this → 当前类
    if receiver == "this":
        for cls_start, cls_end, cls_full_name in class_info:
            if cls_start < line_idx < cls_end:
                return cls_full_name
        return None

    # super → 父类
    if receiver == "super":
        for cls_start, cls_end, cls_full_name in class_info:
            if cls_start < line_idx < cls_end:
                parent = class_index.get(cls_full_name, {}).get("extends")
                if parent:
                    if "." not in parent and package:
                        return f"{package}.{parent}"
                    return parent
        return None

    # 首字母大写 → 疑似类名 (静态调用)
    if receiver[0].isupper():
        # 查 import 映射
        if receiver in import_map:
            return import_map[receiver]
        # 查 class_index
        for cls_name in class_index:
            if cls_name.rsplit(".", 1)[-1] == receiver:
                return cls_name
        # 尝试用当前包名构造
        if package:
            full = f"{package}.{receiver}"
            if full in class_index:
                return full
        return None

    # 首字母小写 → 疑似变量名, 需要找声明
    # 1. 在方法参数列表中查找
    caller_method = _find_containing_method(line_idx, methods)
    if caller_method:
        decl_type = _find_variable_in_method_params(
            receiver, caller_method, lines, import_map, class_index, package
        )
        if decl_type:
            return decl_type

    # 2. 在类体中查找字段声明
    for cls_start, cls_end, cls_full_name in class_info:
        if cls_start < line_idx < cls_end:
            decl_type = _find_field_declaration(
                receiver, cls_start, cls_end, lines, import_map, class_index, package, depths=None
            )
            if decl_type:
                return decl_type
            break

    # 3. 在方法体内向上搜索局部变量声明
    if caller_method:
        decl_type = _find_local_variable(
            receiver, caller_method["start_line"], line_idx, lines, import_map, class_index, package
        )
        if decl_type:
            return decl_type

    return None


def _find_containing_method(
    line_idx: int,
    methods: list[dict[str, Any]],
) -> dict[str, Any] | None:
    """找到包含指定行的方法。"""
    for m in methods:
        if m["start_line"] <= line_idx <= m["end_line"]:
            return m
    return None


def _find_variable_in_method_params(
    var_name: str,
    method: dict[str, Any],
    lines: list[str],
    import_map: dict[str, str],
    class_index: dict[str, dict[str, Any]],
    package: str | None,
) -> str | None:
    """在方法参数列表中查找变量声明, 返回类型全限定名。"""
    line = method.get("_match_line", lines[method["start_line"]])
    m_match = re.search(r"(\w+)\s*\(([^)]*)\)\s*(\{|;)", line)
    if not m_match:
        return None

    params_str = m_match.group(2)
    if not params_str.strip():
        return None

    # 按逗号分割参数 (简化, 不处理泛型中的逗号)
    for param in _split_params_safe(params_str):
        param = param.strip()
        # 去掉注解和 final
        param = re.sub(r"@\w+(?:\([^)]*\))?\s*", "", param).strip()
        param = re.sub(r"\bfinal\s+", "", param).strip()

        tokens = param.rsplit(None, 1)
        if len(tokens) == 2:
            param_type = tokens[0].replace("...", "").strip()
            param_name = tokens[1].strip()
            if param_name == var_name:
                return _resolve_type_name(param_type, import_map, class_index, package)

    return None


def _find_field_declaration(
    var_name: str,
    cls_start: int,
    cls_end: int,
    lines: list[str],
    import_map: dict[str, str],
    class_index: dict[str, dict[str, Any]],
    package: str | None,
    depths: list[int] | None,
) -> str | None:
    """在类体中查找字段声明, 返回类型全限定名。"""
    # 字段声明模式: [modifiers] Type name [= value];
    # 只在类体级别查找 (depth=1), 跳过方法体内
    for i in range(cls_start + 1, cls_end):
        line = lines[i].strip()
        if not line or line.startswith("//") or line.startswith("/*"):
            continue
        # 跳过方法声明行
        if "(" in line and ")" in line and ("{" in line or ";" in line):
            continue
        # 匹配字段声明
        m = re.match(r"(?:public|protected|private|static|final|transient|volatile|\s)*"
                     r"([\w.<>?\[\]]+)\s+(\w+)\s*(?:=[^;]*)?;", line)
        if m:
            field_type = m.group(1).strip()
            field_name = m.group(2).strip()
            if field_name == var_name:
                return _resolve_type_name(field_type, import_map, class_index, package)

    return None


def _find_local_variable(
    var_name: str,
    method_start: int,
    current_line: int,
    lines: list[str],
    import_map: dict[str, str],
    class_index: dict[str, dict[str, Any]],
    package: str | None,
) -> str | None:
    """在方法体内向上搜索局部变量声明, 返回类型全限定名。"""
    for i in range(current_line - 1, method_start, -1):
        line = lines[i].strip()
        if not line:
            continue
        # 匹配: Type name = ...; 或 Type name;
        m = re.match(r"([\w.<>?\[\]]+)\s+(\w+)\s*(?:=[^;]*)?;", line)
        if m:
            var_type = m.group(1).strip()
            var_name_found = m.group(2).strip()
            if var_name_found == var_name:
                return _resolve_type_name(var_type, import_map, class_index, package)

    return None


def _resolve_type_name(
    type_str: str,
    import_map: dict[str, str],
    class_index: dict[str, dict[str, Any]],
    package: str | None,
) -> str | None:
    """将类型名解析为全限定名。"""
    # 去掉泛型部分
    type_str = type_str.split("<")[0].strip()

    # 已经是全限定名
    if "." in type_str:
        return type_str

    # 查 import 映射
    if type_str in import_map:
        return import_map[type_str]

    # 查 class_index
    for cls_name in class_index:
        if cls_name.rsplit(".", 1)[-1] == type_str:
            return cls_name

    # 尝试用当前包名
    if package:
        full = f"{package}.{type_str}"
        if full in class_index:
            return full

    # Java 内置类型 (String, int, boolean 等) — 不是我们要找的类
    return None


def _split_params_safe(params_str: str) -> list[str]:
    """安全分割参数列表, 处理泛型中的逗号。"""
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


def _is_matching_receiver(
    receiver_type: str | None,
    target_method_keys: set[str],
    class_index: dict[str, dict[str, Any]],
) -> bool:
    """
    检查接收者类型是否匹配目标方法集合。

    如果 receiver_type 为 None (无法确定), 返回 True (宽松匹配)。
    """
    if receiver_type is None:
        return True  # 无法确定类型, 宽松匹配

    # 检查 receiver_type 本身是否在目标集合的类中
    for key in target_method_keys:
        # key 格式: "com.example.ClassName.methodName"
        target_class = key.rsplit(".", 1)[0] if "." in key else key
        if receiver_type == target_class:
            return True
        # 检查继承关系: receiver_type 是否是 target_class 的子类
        receiver_info = class_index.get(receiver_type)
        if receiver_info:
            if target_class in receiver_info.get("all_parents", []):
                return True
        # 反向: target_class 是否是 receiver_type 的子类
        target_info = class_index.get(target_class)
        if target_info:
            if receiver_type in target_info.get("all_parents", []):
                return True

    return False


# ---------------------------------------------------------------------------
# MCP Tool
# ---------------------------------------------------------------------------

@mcp_tool(
    name="find_callers_by_method_name",
    description=(
        "Find all call sites of a Java method by its fully qualified name. "
        "Returns caller method, file path, line number, and call expression. "
        "Supports inherited callers via parent classes/interfaces."
    ),
)
async def find_callers_by_method_name(
    method_full_name: str,
    repository_path: str,
    parameter_types: list[str] | None = None,
    include_test_code: bool = False,
    include_inherited_callers: bool = True,
    max_results: int = 200,
    language: str = "java",
) -> dict:
    """
    Find all callers of a method.

    Args:
        method_full_name: Fully qualified method name, e.g. "com.example.UserDao.findById"
        repository_path: Absolute path to the repository root
        parameter_types: Parameter types for overload disambiguation
        include_test_code: If false (default), skip test files
        include_inherited_callers: If true (default), include calls through parent classes/interfaces
        max_results: Maximum results (default 200, max 1000)
        language: Programming language (default: java)
    """
    # --- 参数校验 ---
    if not method_full_name:
        return {"error": "method_full_name is required"}

    if not repository_path or not os.path.isdir(repository_path):
        return {"error": "Invalid repository_path"}

    max_results = min(max(max_results, 1), _MAX_RESULTS_LIMIT)

    # --- 解析方法全限定名 ---
    package, class_name, method_name = _parse_method_full_name(method_full_name)

    if not method_name:
        return {"error": "Could not parse method name"}

    logger.info(
        "find_callers: method=%s, repo=%s",
        method_full_name, repository_path,
    )

    # --- Step 1: 构建索引 ---
    method_index, class_index = _build_method_index(repository_path)

    # --- 构建目标方法集合 ---
    target_class = f"{package}.{class_name}" if package else class_name
    target_method_keys: set[str] = set()

    # 主目标方法
    main_key = f"{target_class}.{method_name}"
    if main_key in method_index:
        # 如果提供了 parameter_types, 检查参数类型是否匹配
        if parameter_types:
            method_info = method_index[main_key]
            if method_info.get("param_types") == parameter_types:
                target_method_keys.add(main_key)
        else:
            target_method_keys.add(main_key)

    # include_inherited_callers: 扩展到父类/接口的同名方法
    if include_inherited_callers:
        target_info = class_index.get(target_class)
        if target_info:
            for parent in target_info.get("all_parents", []):
                parent_key = f"{parent}.{method_name}"
                if parent_key in method_index:
                    if parameter_types:
                        method_info = method_index[parent_key]
                        if method_info.get("param_types") == parameter_types:
                            target_method_keys.add(parent_key)
                    else:
                        target_method_keys.add(parent_key)

        # 也扩展到子类: 查找继承了目标类的所有子类的同名方法
        for cls_name, cls_info in class_index.items():
            if target_class in cls_info.get("all_parents", []):
                child_key = f"{cls_name}.{method_name}"
                if child_key in method_index:
                    if parameter_types:
                        method_info = method_index[child_key]
                        if method_info.get("param_types") == parameter_types:
                            target_method_keys.add(child_key)
                    else:
                        target_method_keys.add(child_key)

    if not target_method_keys:
        return {
            "target_method": method_full_name,
            "total_callers": 0,
            "callers": [],
            "note": "Target method not found in repository",
        }

    # --- Step 2 + 3: 遍历文件, 提取调用点 + 类型解析 ---
    results: list[dict[str, Any]] = []

    for filepath in _find_java_files(repository_path):
        if len(results) >= max_results:
            break
        _find_call_sites(
            filepath, repository_path, method_name,
            target_method_keys, include_test_code, max_results,
            results, method_index, class_index,
        )

    logger.info(
        "find_callers: method=%s, found=%d callers",
        method_full_name, len(results),
    )

    return {
        "target_method": method_full_name,
        "total_callers": len(results),
        "callers": results,
    }
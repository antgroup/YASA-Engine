"""
MCP Tool: search_code_by_signature_pattern

用正则模式匹配代码元素(方法/类/字段)的**签名**, 例如:
- 所有形参含 ``HttpServletRequest`` 的 public 方法
- 所有继承 ``Abstract*Filter`` 的类
- 所有以 ``query``、``select``、``load`` 开头的方法

与 search_code_by_keyword 不同, 本工具只在代码元素的**签名行**上做匹配,
天然跳过注释、字符串字面量和方法体内的噪声。

实现方式: 纯 Python 正则解析 Java 源文件, 提取方法/类/字段的签名行,
再对签名行应用用户提供的 pattern 做 re.search。
"""

from __future__ import annotations

import os
import re
import logging
from bisect import bisect_left, bisect_right
from typing import Any

from yasa_mcp.registry import mcp_tool

logger = logging.getLogger("yasa_mcp.tools.search_code_by_signature_pattern")

# ---------------------------------------------------------------------------
# 常量
# ---------------------------------------------------------------------------

# 默认排除的目录
_EXCLUDED_DIRS = frozenset({
    ".git", "node_modules", "target", "build", "dist",
    "__pycache__", ".venv", "venv", ".idea", ".vscode",
})

# 二进制检测: 读取前 8192 字节, 含 \x00 则判定为二进制
_BINARY_CHECK_SIZE = 8192

# max_results 上限
_MAX_RESULTS_LIMIT = 1000


# ---------------------------------------------------------------------------
# Java 签名正则
# ---------------------------------------------------------------------------

# --- 类 / 接口签名 ---
#
# 逐行匹配: 在每一行中查找 class/interface 关键字后跟类名和 {
# 不使用跨行正则, 避免回溯灾难
_CLASS_PATTERN = re.compile(
    r"\b(?:(?:public|protected|private|static|abstract|final|strictfp|sealed|non-sealed)\s+)*"
    r"(class|interface|enum|record)\s+([A-Za-z_$][\w$]*)",
)

# --- 方法签名 ---
#
# 逐行匹配: 在每一行中查找 方法名(params) 后跟 { 或 ;
# 然后从行中提取修饰符、返回类型、方法名、参数
_METHOD_LINE_PATTERN = re.compile(
    r"(\w+)\s*\(([^)]*)\)\s*(?:throws\s+[\w.,\s]+)?\s*(\{|;)",
)

# 控制流关键字黑名单, 方法名不能是这些
_CONTROL_FLOW_KEYWORDS = frozenset({
    "if", "for", "while", "switch", "catch", "return", "throw",
    "new", "synchronized", "try", "do", "else", "assert",
    "break", "continue", "case", "default", "finally",
})

# Java 修饰符
_MODIFIERS = frozenset({
    "public", "protected", "private", "static", "final",
    "synchronized", "default", "native", "abstract",
    "transient", "volatile", "strictfp",
})

# --- 字段签名 ---
#
# 逐行匹配: 在每一行中查找 Type name [= value]; 的模式
# 然后排除方法声明、return 语句等
_FIELD_LINE_PATTERN = re.compile(
    r"(\w[\w.<>?\[\]]*(?:\s*<[^()]*>)?)\s+(\w+)\s*(?:=[^;]*)?;",
)


# ---------------------------------------------------------------------------
# 注释过滤
# ---------------------------------------------------------------------------

_JAVA_REGION_PATTERN = re.compile(
    r"(?P<line_comment>//[^\r\n]*)"
    r"|(?P<block_comment>/\*.*?(?:\*/|\Z))"
    r'|(?P<text_block>"""(?:(?:\\[\s\S])|(?:(?!""")[\s\S]))*(?:"""|\Z))'
    r'|(?P<string>"(?:\\.|[^"\\\r\n])*(?:"|$))'
    r"|(?P<char>'(?:\\.|[^'\\\r\n])*(?:'|$))",
    re.DOTALL | re.MULTILINE,
)
_NON_NEWLINE_PATTERN = re.compile(r"[^\r\n]")

def _mask_java_regions(
    content: str,
    *,
    mask_comments: bool,
    mask_literals: bool,
) -> str:
    """Mask Java comments and/or literals without changing offsets."""
    return _mask_java_region_variants(
        content,
        ((mask_comments, mask_literals),),
    )[0]


def _mask_java_region_variants(
    content: str,
    variants: tuple[tuple[bool, bool], ...],
) -> list[str]:
    """Build multiple comment/literal masks in one lexical pass."""
    outputs: list[list[str]] = [[] for _ in variants]
    cursor = 0

    for match in _JAVA_REGION_PATTERN.finditer(content):
        start, end = match.span()
        segment = match.group(0)
        is_comment = match.lastgroup in {"line_comment", "block_comment"}
        masked_segment: str | None = None

        for output, (mask_comments, mask_literals) in zip(outputs, variants):
            output.append(content[cursor:start])
            should_mask = mask_comments if is_comment else mask_literals
            if should_mask:
                if masked_segment is None:
                    masked_segment = _NON_NEWLINE_PATTERN.sub(" ", segment)
                output.append(masked_segment)
            else:
                output.append(segment)
        cursor = end

    remainder = content[cursor:]
    for output in outputs:
        output.append(remainder)
    return ["".join(output) for output in outputs]


def _prepare_java_source(content: str) -> tuple[str, str]:
    """Return comment-masked and structural source in one lexical pass."""
    without_comments, structural = _mask_java_region_variants(
        content,
        ((True, False), (True, True)),
    )
    return without_comments, structural


def _strip_comments(content: str) -> str:
    """Mask comments while preserving literals, offsets, and line numbers."""
    return _mask_java_regions(content, mask_comments=True, mask_literals=False)


def _mask_literals(content: str) -> str:
    """Mask string, character, and text-block literals."""
    return _mask_java_regions(content, mask_comments=False, mask_literals=True)


# ---------------------------------------------------------------------------
# 辅助函数
# ---------------------------------------------------------------------------

def _is_binary(filepath: str) -> bool:
    """检测文件是否为二进制文件"""
    try:
        with open(filepath, "rb") as f:
            chunk = f.read(_BINARY_CHECK_SIZE)
        return b"\x00" in chunk
    except (OSError, IOError):
        return True


def _find_java_files(repo_path: str) -> list[str]:
    """遍历仓库, 返回所有 Java 文件的绝对路径"""
    result: list[str] = []
    for dirpath, dirnames, filenames in os.walk(repo_path):
        dirnames[:] = [d for d in dirnames if d not in _EXCLUDED_DIRS]
        for f in filenames:
            if f.endswith(".java"):
                result.append(os.path.join(dirpath, f))
    return result


def _line_number_of(content: str, pos: int) -> int:
    """返回 pos 在 content 中对应的行号 (1-based)"""
    return content[:pos].count("\n") + 1


def _extract_package(content: str) -> str | None:
    """提取 Java 文件的 package 声明"""
    m = re.search(r"^\s*package\s+([\w.]+)\s*;", content, re.MULTILINE)
    return m.group(1) if m else None


# ---------------------------------------------------------------------------
# 签名提取器
# ---------------------------------------------------------------------------

def _extract_class_signatures(
    content: str,
    stripped: str,
    rel_path: str,
    package: str | None,
) -> list[dict[str, Any]]:
    """
    提取所有类/接口的签名。逐行扫描, 避免正则回溯灾难。
    """
    results: list[dict[str, Any]] = []
    lines = stripped.split("\n")

    for i, line in enumerate(lines):
        m = _CLASS_PATTERN.search(line)
        if not m:
            continue

        keyword = m.group(1)  # class 或 interface
        class_name = m.group(2)

        full_name = f"{package}.{class_name}" if package else class_name
        line_number = i + 1

        # 签名: 从 stripped 行取 (注释已被移除), 去掉末尾的 {
        sig_line = lines[i].strip()
        if sig_line.endswith("{"):
            sig_line = sig_line[:-1].strip()
        matched_signature = re.sub(r"\s+", " ", sig_line).strip()

        results.append({
            "file_path": rel_path,
            "line_number": line_number,
            "matched_signature": matched_signature,
            "containing_class": full_name,
            "element_kind": "class",
        })

    return results


def _extract_method_signatures(
    content: str,
    stripped: str,
    rel_path: str,
    package: str | None,
    depths: list[int],
) -> list[dict[str, Any]]:
    """
    提取所有方法的签名。逐行扫描, 利用预计算的 depth 数组确定所属类。
    """
    results: list[dict[str, Any]] = []
    lines = stripped.split("\n")

    # 利用预计算的 depth 数组确定类范围
    class_info = _build_class_ranges_by_depth(lines, depths, package)

    for i, line in enumerate(lines):
        m = _METHOD_LINE_PATTERN.search(line)
        if not m:
            continue

        method_name = m.group(1)
        params = m.group(2)
        ending = m.group(3)

        # 跳过控制流关键字
        if method_name in _CONTROL_FLOW_KEYWORDS:
            continue

        # 从行中提取返回类型
        name_pos = m.start(1)
        prefix = line[:name_pos].strip()
        tokens = prefix.split()
        non_anno_tokens = [t for t in tokens if not t.startswith("@")]

        ret_type_tokens = []
        for t in non_anno_tokens:
            if t not in _MODIFIERS:
                ret_type_tokens.append(t)

        ret_type = " ".join(ret_type_tokens) if ret_type_tokens else ""

        # 跳过返回类型以控制流关键字开头的情况
        if ret_type and ret_type.split()[0] in _CONTROL_FLOW_KEYWORDS:
            continue

        # 查找所属类 (利用预计算的 class_info)
        containing_class = ""
        for cls_start_line, cls_end_line, cls_full_name in class_info:
            if cls_start_line < i < cls_end_line:
                containing_class = cls_full_name
                break

        # 签名: 从 stripped 行取 (注释已被移除)
        sig_line = lines[i].strip()
        if sig_line.endswith("{") or sig_line.endswith(";"):
            sig_line = sig_line[:-1].rstrip()
        matched_signature = re.sub(r"\s+", " ", sig_line).strip()

        results.append({
            "file_path": rel_path,
            "line_number": i + 1,
            "matched_signature": matched_signature,
            "containing_class": containing_class,
            "element_kind": "method",
        })

    return results


def _extract_field_signatures(
    content: str,
    stripped: str,
    rel_path: str,
    package: str | None,
    depths: list[int],
) -> list[dict[str, Any]]:
    """
    提取所有字段的签名。利用预计算的 depth 数组, 只在类体级别 (depth=1 或
    外层类体对应深度) 提取字段, 排除方法体内局部变量 (depth>=2)。

    depth=0: 文件顶级 (package, import)
    depth=1: 类体级别 (字段、方法定义)
    depth>=2: 方法体内 (局部变量)
    但对于嵌套类, depth=2 可能仍是类体级别。
    我们通过检查该行是否在某方法体内来判断。
    """
    results: list[dict[str, Any]] = []
    lines = stripped.split("\n")

    # 利用预计算的 depth 数组确定类范围
    class_info = _build_class_ranges_by_depth(lines, depths, package)

    # 确定每行是否在方法体内:
    # 方法定义行 (含 methodName(...) {) 之后到方法体 } 之间的行
    # 方法定义行 depths[i] == 外层类体深度, 方法体内 depths[i] >= 外层+1
    method_body_lines: set[int] = set()
    for i, line in enumerate(lines):
        m = _METHOD_LINE_PATTERN.search(line)
        if not m:
            continue
        method_name = m.group(1)
        if method_name in _CONTROL_FLOW_KEYWORDS:
            continue
        if m.group(3) != "{":
            continue  # 抽象方法/接口声明, 无方法体

        # 方法定义行 depth = 类体深度
        method_depth = depths[i]
        # 方法体内行: depth > method_depth
        for j in range(i + 1, len(lines)):
            if depths[j] <= method_depth:
                break
            method_body_lines.add(j)

    for i, line in enumerate(lines):
        # 必须在某个类体内
        in_class = False
        current_class = ""
        for cls_start, cls_end, cls_full in class_info:
            if cls_start < i < cls_end:
                in_class = True
                current_class = cls_full
                break
        if not in_class:
            continue

        # 不能在方法体内
        if i in method_body_lines:
            continue

        m = _FIELD_LINE_PATTERN.search(line)
        if not m:
            continue

        field_type = m.group(1)
        field_name = m.group(2)

        # 排除控制流关键字作为类型
        if field_type in _CONTROL_FLOW_KEYWORDS:
            continue

        # 排除方法声明行 (含括号的行不是字段)
        if "(" in line:
            continue

        # 签名: 从 stripped 行取 (注释已被移除)
        sig_line = lines[i].strip()
        if sig_line.endswith(";"):
            sig_line = sig_line[:-1].rstrip()
        matched_signature = re.sub(r"\s+", " ", sig_line).strip()

        results.append({
            "file_path": rel_path,
            "line_number": i + 1,
            "matched_signature": matched_signature,
            "containing_class": current_class,
            "element_kind": "field",
        })

    return results


def _find_matching_brace_line(lines: list[str], start_line: int) -> int:
    """
    从 start_line 开始, 找到第一个 { 对应的 }, 返回 } 所在的行号。
    如果找不到, 返回 len(lines) - 1。
    """
    depth = 0
    found_open = False
    for i in range(start_line, len(lines)):
        line = lines[i]
        for ch in line:
            if ch == "{":
                depth += 1
                found_open = True
            elif ch == "}":
                depth -= 1
                if found_open and depth == 0:
                    return i
    return len(lines) - 1


def _compute_line_depths(lines: list[str]) -> list[int]:
    """
    一次遍历所有行, 计算每行的花括号深度。

    深度定义: 该行**开始之前**的花括号嵌套层级。
    - depth=0: 文件顶级 (package, import 等)
    - depth=1: 类体级别 (字段、方法定义所在)
    - depth>=2: 方法体内 (局部变量所在)

    状态机跟踪:
    - in_string: 双引号字符串
    - in_char: 单引号字符
    - in_line_comment: // 行注释
    - in_block_comment: /* */ 块注释
    这些状态下的 { } 不计入深度。

    时间复杂度: O(文件总字符数), 每个文件只调用一次。
    """
    depths: list[int] = []
    depth = 0
    in_string = False
    in_char = False
    in_line_comment = False
    in_block_comment = False

    for line in lines:
        # 记录该行开始前的深度
        depths.append(depth)

        # 重置行注释状态 (每行开始时)
        in_line_comment = False

        i = 0
        while i < len(line):
            ch = line[i]

            # --- 注释状态处理 ---
            if in_line_comment:
                break  # 行注释: 剩余字符跳过

            if in_block_comment:
                if ch == "*" and i + 1 < len(line) and line[i + 1] == "/":
                    in_block_comment = False
                    i += 2
                    continue
                i += 1
                continue

            if in_string:
                if ch == "\\":
                    i += 2  # 转义字符
                    continue
                if ch == '"':
                    in_string = False
                i += 1
                continue

            if in_char:
                if ch == "\\":
                    i += 2
                    continue
                if ch == "'":
                    in_char = False
                i += 1
                continue

            # --- 检测注释/字符串开始 ---
            if ch == "/" and i + 1 < len(line):
                next_ch = line[i + 1]
                if next_ch == "/":
                    in_line_comment = True
                    break  # 行注释, 剩余跳过
                if next_ch == "*":
                    in_block_comment = True
                    i += 2
                    continue

            if ch == '"':
                in_string = True
                i += 1
                continue

            if ch == "'":
                in_char = True
                i += 1
                continue

            # --- 花括号计数 ---
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth < 0:
                    depth = 0  # 防御性

            i += 1

    return depths


def _compute_brace_metadata(
    content: str,
) -> tuple[dict[int, int], dict[int, int], dict[int, int]]:
    """Return brace pairs, opening-brace depths, and header starts in O(n)."""
    stack: list[int] = []
    pairs: dict[int, int] = {}
    open_depths: dict[int, int] = {}
    header_starts: dict[int, int] = {}
    last_boundary: dict[int, int] = {0: -1}

    for i, ch in enumerate(content):
        depth = len(stack)
        if ch == "{":
            open_depths[i] = depth
            header_starts[i] = last_boundary.get(depth, -1) + 1
            stack.append(i)
            last_boundary[depth + 1] = i
        elif ch == "}":
            if stack:
                opening = stack.pop()
                pairs[opening] = i
            last_boundary[len(stack)] = i
        elif ch == ";":
            last_boundary[depth] = i

    return pairs, open_depths, header_starts


def _build_class_ranges_by_depth(
    lines: list[str],
    depths: list[int],
    package: str | None,
    structural_content: str | None = None,
    brace_metadata: tuple[dict[int, int], dict[int, int], dict[int, int]] | None = None,
    line_starts: list[int] | None = None,
) -> list[tuple[int, int, str]]:
    """
    利用预计算的 depth 数组, 快速确定每个类的行范围。
    类定义行 depth=0 或 depth=外层类体级别, 类体 { 后 depth+1,
    类体结束 } 时 depth 回落到类定义时的 depth。

    返回: [(start_line, end_line, full_name), ...]
    """
    if structural_content is None:
        structural = _mask_literals("\n".join(lines))
    else:
        structural = structural_content
    structural_lines = structural.split("\n")
    if brace_metadata is None:
        pairs, open_depths, _ = _compute_brace_metadata(structural)
    else:
        pairs, open_depths, _ = brace_metadata
    opening_positions = sorted(open_depths)
    if line_starts is None:
        line_starts = [0]
        for match in re.finditer("\n", structural):
            line_starts.append(match.end())

    accepted: list[dict[str, Any]] = []
    for i, line in enumerate(structural_lines):
        m = _CLASS_PATTERN.search(line)
        if not m:
            continue
        class_name = m.group(2)
        class_depth = depths[i]  # 该行开始前的深度
        declaration_pos = line_starts[i] + m.start()

        opening = None
        for pos in opening_positions[bisect_left(opening_positions, declaration_pos):]:
            if open_depths[pos] == class_depth:
                opening = pos
                break
        if opening is None or opening not in pairs:
            continue

        closing = pairs[opening]
        parent = None
        for candidate in accepted:
            if (
                candidate["opening"] < opening < candidate["closing"]
                and class_depth == candidate["depth"] + 1
            ):
                if parent is None or candidate["depth"] > parent["depth"]:
                    parent = candidate

        if class_depth > 0 and parent is None:
            # Local classes are inside methods, not at a class-body level.
            continue

        if parent is not None:
            full_name = f"{parent['full_name']}.{class_name}"
        else:
            full_name = f"{package}.{class_name}" if package else class_name

        accepted.append({
            "start_line": i,
            "end_line": bisect_right(line_starts, closing) - 1,
            "full_name": full_name,
            "depth": class_depth,
            "opening": opening,
            "closing": closing,
        })

    return [
        (item["start_line"], item["end_line"], item["full_name"])
        for item in accepted
    ]


def _find_matching_brace(content: str, brace_pos: int) -> int:
    """
    找到 brace_pos 处 { 对应的 }, 返回其位置。
    如果找不到, 返回 content 长度。
    """
    if brace_pos >= len(content) or content[brace_pos] != "{":
        return len(content)

    depth = 0
    i = brace_pos
    # 跳过字符串和字符字面量
    in_string = False
    in_char = False
    in_line_comment = False
    in_block_comment = False

    while i < len(content):
        ch = content[i]

        if in_line_comment:
            if ch == "\n":
                in_line_comment = False
            i += 1
            continue
        if in_block_comment:
            if ch == "*" and i + 1 < len(content) and content[i + 1] == "/":
                in_block_comment = False
                i += 2
                continue
            i += 1
            continue
        if in_string:
            if ch == "\\":
                i += 2
                continue
            if ch == '"':
                in_string = False
            i += 1
            continue
        if in_char:
            if ch == "\\":
                i += 2
                continue
            if ch == "'":
                in_char = False
            i += 1
            continue

        if ch == "/" and i + 1 < len(content):
            if content[i + 1] == "/":
                in_line_comment = True
                i += 2
                continue
            if content[i + 1] == "*":
                in_block_comment = True
                i += 2
                continue

        if ch == '"':
            in_string = True
            i += 1
            continue
        if ch == "'":
            in_char = True
            i += 1
            continue

        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return i

        i += 1

    return len(content)


# ---------------------------------------------------------------------------
# 核心搜索逻辑
# ---------------------------------------------------------------------------

def _parse_java_file(
    filepath: str,
    repo_root: str,
    element_kind: str,
) -> list[dict[str, Any]]:
    """
    解析 Java 文件, 根据元素类型提取签名。

    性能优化: depth 数组只计算一次, 传给各提取函数复用。
    """
    try:
        with open(filepath, "r", encoding="utf-8", errors="replace") as f:
            content = f.read()
    except (OSError, IOError):
        return []

    # 移除注释 (保持行号不变)
    stripped = _strip_comments(content)

    rel_path = os.path.relpath(filepath, repo_root)
    package = _extract_package(stripped)

    # 一次遍历计算花括号深度 (O(n), 处理字符串/注释中的花括号)
    lines = stripped.split("\n")
    depths = _compute_line_depths(lines)

    signatures: list[dict[str, Any]] = []

    if element_kind in ("class", "any"):
        signatures.extend(
            _extract_class_signatures(content, stripped, rel_path, package)
        )

    if element_kind in ("method", "any"):
        signatures.extend(
            _extract_method_signatures(content, stripped, rel_path, package, depths)
        )

    if element_kind in ("field", "any"):
        signatures.extend(
            _extract_field_signatures(content, stripped, rel_path, package, depths)
        )

    return signatures


# ---------------------------------------------------------------------------
# MCP Tool
# ---------------------------------------------------------------------------

@mcp_tool(
    name="search_code_by_signature_pattern",
    description=(
        "Search code elements (methods, classes, fields) by matching a regex "
        "pattern against their **signatures** in a Java repository. Unlike plain "
        "keyword search, this tool only matches declaration lines of code "
        "elements, naturally skipping comments, string literals, and method "
        "bodies. Supports method, class, field, or any element kind."
    ),
)
async def search_code_by_signature_pattern(
    pattern: str,
    element_kind: str,
    repository_path: str,
    language: str = "java",
    max_results: int = 100,
) -> dict:
    """
    Search code by signature pattern in a local repository.

    Matches a regex pattern against the signature lines of code elements
    (methods, classes, fields) in the specified repository.

    Args:
        pattern: Regex pattern to match against signatures,
                 e.g. ``public\\s+\\w+\\s+\\w+\\s*\\([^)]*HttpServletRequest``
        element_kind: Type of code element to match: method, class, field, or any
        repository_path: Absolute path to the repository root
        language: Programming language (default: java)
        max_results: Maximum number of results to return (default 100, max 1000)
    """
    # --- 参数校验 ---
    if not pattern:
        return {
            "pattern": "",
            "element_kind": element_kind,
            "total_matches": 0,
            "results": [],
        }

    if not repository_path or not os.path.isdir(repository_path):
        return {
            "pattern": pattern,
            "element_kind": element_kind,
            "total_matches": 0,
            "results": [],
        }

    if element_kind not in ("method", "class", "field", "any"):
        return {
            "pattern": pattern,
            "element_kind": element_kind,
            "total_matches": 0,
            "results": [],
            "error": f"Invalid element_kind: {element_kind}. Must be one of: method, class, field, any",
        }

    # 限制 max_results
    max_results = min(max(max_results, 1), _MAX_RESULTS_LIMIT)

    # --- 编译用户 pattern ---
    try:
        user_pattern = re.compile(pattern)
    except re.error as e:
        return {
            "pattern": pattern,
            "element_kind": element_kind,
            "total_matches": 0,
            "results": [],
            "error": f"Invalid regex pattern: {e}",
        }

    # --- 遍历 Java 文件 ---
    results: list[dict[str, Any]] = []

    for filepath in _find_java_files(repository_path):
        if len(results) >= max_results:
            break

        if _is_binary(filepath):
            continue

        signatures = _parse_java_file(filepath, repository_path, element_kind)

        for sig in signatures:
            if len(results) >= max_results:
                break

            # 对签名行做正则匹配
            if user_pattern.search(sig["matched_signature"]):
                results.append({
                    "file_path": sig["file_path"],
                    "line_number": sig["line_number"],
                    "matched_signature": sig["matched_signature"],
                    "containing_class": sig["containing_class"],
                })

    logger.info(
        "search_code_by_signature_pattern: pattern=%r, kind=%s, repo=%s, matches=%d",
        pattern, element_kind, repository_path, len(results),
    )

    return {
        "pattern": pattern,
        "element_kind": element_kind,
        "total_matches": len(results),
        "results": results,
    }

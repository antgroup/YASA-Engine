"""实时调用图分析服务 (Realtime Callgraph Analysis Service)

提供三个核心接口：
  1. get_call_graph          — 给定函数，递归展开其调用的所有 callee（支持 CHA 多态展开）
  2. get_function_by_call    — 给定调用表达式字符串，定位调用点并解析被调方法定义
  3. get_reference_by_function — 给定函数，反向查找所有引用/调用该函数的位置

技术架构：
  - ripgrep 做文本预筛（快速缩小候选文件范围）
  - ast-grep (tree-sitter) 做 AST 精确解析（提取函数定义、调用表达式、类型信息等）
  - 多级缓存（L1: 函数名→候选、L3: import 解析、resolved_cache: 父类查找等）

消歧策略（_resolve_callee_definition）：
  当项目中存在多个同名方法时，依次尝试以下启发式规则：
  1. 参数数量过滤    — 调用参数数 vs 形参数，支持可变参数
  2. 构造函数识别    — new Foo() → 直接匹配类名
  3. 静态/类名调用   — ClassName.method() → 按类名匹配
  4. this/super 调用  — 同文件优先
  5. 变量类型推断    — 通过声明行推断 receiver 类型 → FQCN 匹配
  6. import 消歧      — 精确导入 / 通配符导入(import com.xxx.*)
  7. 继承链回溯      — 沿父类链查找方法定义（最多 3 层）
  8. 兜底策略        — 同文件优先 → 第一个候选
"""

from __future__ import annotations

import logging
import re
import time
from contextvars import ContextVar
from dataclasses import dataclass, field
from pathlib import Path
from typing import Set

from yasa_mcp.service.models import (
    CallSite,
    Callee,
    Caller,
    GetCallGraphOutput,
    GetFunctionDefByFunctionCallOutput,
    GetFunctionReferenceOutput,
    Location as ServiceLocation,
)
from yasa_mcp.tools.ast_grep.ast.ast_grep_module import ClassInfo, FuncInfo, Location
from yasa_mcp.tools.ast_grep.ast.ast_parser import (
    find_child_by_kind,
    node_text,
    parse_cache_info,
    parse_file,
)
from yasa_mcp.tools.ast_grep.util.realtime_common import (
    LANGUAGE_EXTENSIONS,
    LANGUAGE_RG_TYPES,
    TEST_DIR_NAMES,
    ast_location_to_service_location,
    find_nearest_function,
    get_ast_client,
    get_ripgrep_tool,
    is_test_path,
    ripgrep_search_files,
)
from yasa_mcp.util import file_util
from yasa_mcp.util.params_validator_util import ParamsValidator
from yasa_mcp.util.timer_util import timed

logger = logging.getLogger(__name__)


@dataclass
class _CallGraphContext:
    """单次调用图分析的上下文缓存，用于避免重复 I/O 和计算。

    生命周期：一次 realtime_get_call_graph 调用期间创建，调用结束后丢弃。

    缓存层级：
      - L1 (name_candidates_cache): 按函数名缓存 ripgrep + AST 搜索结果，
        避免对同一个 callee 名称重复执行 ripgrep 搜索 + AST 解析。
      - L3 (java_imports_cache): 按文件路径缓存 Java import 解析结果，
        避免对同一个文件重复读取和解析 import 语句。
      - resolved_cache: 通用缓存，用于存放继承链查找等杂项查询结果。
    """

    # L1: func_name -> list[FuncInfo] — 消除重复 ripgrep 搜索
    name_candidates_cache: dict[str, list[FuncInfo]] = field(default_factory=dict)
    # L3: Path -> dict[str, str] — 消除重复 import 解析
    java_imports_cache: dict[Path, dict[str, str]] = field(default_factory=dict)
    # L3: Path -> dict[str, Path] — 消除重复 JS/TS 相对 import/require 解析
    javascript_imports_cache: dict[Path, dict[str, Path]] = field(default_factory=dict)
    # L3: Path -> dict[str, str] — 记录外部 npm/core module 导入，供未定义 callee 命名使用
    javascript_external_imports_cache: dict[Path, dict[str, str]] = field(default_factory=dict)
    # L3: Path -> dict[str, str] — 记录外部 npm/core module 导入，供未定义 callee 命名使用
    javascript_external_imports_cache: dict[Path, dict[str, str]] = field(default_factory=dict)
    # 通用缓存：存放父类查找等杂项结果，key 格式如 "_parent_classes:MyClass"
    resolved_cache: dict[str, object] = field(default_factory=dict)
    # L2: Path -> list[FuncInfo] — 消除同一文件重复 AST 提取
    func_defs_cache: dict[Path, list[FuncInfo]] = field(default_factory=dict)


# 请求级缓存上下文：通过 contextvars 自动传递，无需显式传参
_current_ctx: ContextVar[_CallGraphContext | None] = ContextVar(
    "realtime_callgraph_ctx", default=None
)


# ─── 基础工具函数 ──────────────────────────────────────────────────────────


def _rel_path(p: Path, base: Path) -> Path:
    """将绝对路径转换为相对于项目根目录的相对路径。

    若路径不在项目根目录下（relative_to 失败），则原样返回。
    """
    if p.is_absolute():
        try:
            return p.relative_to(base)
        except ValueError:
            return p
    return p


def _walk_source_files(project_path: Path, language: str) -> list[Path]:
    """Walk project directory for source files of given language."""
    extensions = LANGUAGE_EXTENSIONS.get(language, ())
    files: list[Path] = []
    for ext in extensions:
        files.extend(project_path.rglob(f"*{ext}"))
    return files


def _parser_language_for_file(file_path: Path, language: str) -> str:
    """返回 ast-grep 解析语言，JS 对 .ts 使用 TypeScript grammar。"""
    if language == "javascript" and file_path.suffix == ".ts":
        return "typescript"
    return language


def _parse_callee_name(function_call: str) -> str:
    """从调用表达式字符串中提取被调方法名。

    解析规则：
      1. 取 "(" 之前的部分（即调用前缀）
      2. 如果包含 "."，取最后一个 "." 之后的部分（去掉 receiver）
      3. 否则直接使用整个前缀

    示例：
      "service.process(data)" → "process"
      "process(data)"         → "process"
      "a.b.c()"               → "c"
      "process"               → "process"

    Returns:
        被调方法名，空字符串表示无法解析。
    """
    paren_idx = function_call.find("(")
    if paren_idx > 0:
        call_prefix = function_call[:paren_idx].strip()
    else:
        call_prefix = function_call.strip()

    if not call_prefix:
        return ""

    # 剥离 await/new 前缀：await foo() → foo，new Foo() → Foo。
    for prefix in ("await ", "new "):
        if call_prefix.startswith(prefix):
            call_prefix = call_prefix[len(prefix):].strip()

    # 剥离 await/new 前缀：await foo() → foo，new Foo() → Foo。
    for prefix in ("await ", "new "):
        if call_prefix.startswith(prefix):
            call_prefix = call_prefix[len(prefix):].strip()

    # 剥离泛型参数：f1<T> → f1, List<String> → List
    angle_idx = call_prefix.find("<")
    if angle_idx > 0:
        call_prefix = call_prefix[:angle_idx].strip()

    if "." in call_prefix:
        return call_prefix.rsplit(".", 1)[1]
    return call_prefix



def _ripgrep_search_with_line(
    project_path: Path, keyword: str, language: str, fuzzy_match: bool = False
) -> list[tuple[Path, int, str]]:
    """使用 ripgrep 执行带行号的搜索。

    Args:
        keyword: 搜索关键词（原始字符串，不需要转义）。
        fuzzy_match: False → fixed-string 精确搜索（-F）；True → 大小写不敏感搜索（-i）。

    结果过滤：
      - 通过 ripgrep --glob 预过滤目标语言的文件后缀
      - 排除测试目录下的文件

    Returns:
        list of (文件路径, 行号, 匹配行内容)
    """
    rg_tool = get_ripgrep_tool()
    if rg_tool is None:
        return []

    extensions = LANGUAGE_EXTENSIONS.get(language, ())
    include_globs = [f"*{ext}" for ext in extensions] if extensions else None
    try:
        hits = rg_tool.search_keyword_with_line(
            project_path, keyword,
            fuzzy_match=fuzzy_match,
            timeout=30,
            include_globs=include_globs,
        )
        matches = []
        for hit in hits:
            if is_test_path(hit.file_path, project_path):
                continue
            matches.append((hit.file_path, hit.line, hit.content))
        return matches
    except Exception:
        return []


def _find_function_at_line(
    file_path: Path, line: int, language: str, project_path: Path,
) -> FuncInfo | None:
    """查找包含指定行号的最内层函数定义。

    当多个函数嵌套时（如 Java 内部类的方法），选择最小的包含区间（最内层函数）。
    用于从调用点行号定位到 caller 函数。
    """
    ctx = _current_ctx.get()
    search = get_ast_client().get_search(language)
    if search is None:
        return None
    if ctx is not None and file_path in ctx.func_defs_cache:
        funcs = ctx.func_defs_cache[file_path]
    else:
        funcs = search.extract_function_defs(file_path, project_path)
        if ctx is not None:
            ctx.func_defs_cache[file_path] = funcs
    best: FuncInfo | None = None
    for func in funcs:
        if func.location.start_line <= line <= func.location.end_line:
            if best is None or (
                func.location.start_line >= best.location.start_line
                and func.location.end_line <= best.location.end_line
            ):
                best = func
    return best


def _find_function_by_name_in_project(
    project_path: Path, language: str, func_name: str,
) -> list[FuncInfo]:
    """在整个项目中按函数名搜索所有匹配的函数定义。

    搜索流程：
      1. 先用 ripgrep 文本搜索缩小候选文件范围（Java: \\bname\\s*\\(，Python: def\\s+name\\s*\\(）
      2. 对每个候选文件用 AST 精确提取函数定义（filter 掉调用、变量名等误匹配）
      3. 如果 ripgrep 没有命中任何文件，fallback 到遍历所有源文件

    结果通过 L1 cache 缓存，避免同一次调用图分析中对同一函数名重复搜索。
    """
    # L1 cache: avoid redundant ripgrep + AST parsing for the same func_name
    ctx = _current_ctx.get()
    if ctx is not None and func_name in ctx.name_candidates_cache:
        return ctx.name_candidates_cache[func_name]

    if language == "python":
        rg_pattern = rf"def\s+{re.escape(func_name)}\s*\("
    elif language == "javascript":
        escaped = re.escape(func_name)
        rg_pattern = (
            rf"(function\s+{escaped}\s*\(|"
            rf"async\s+function\s+{escaped}\s*\(|"
            rf"(const|let|var)\s+{escaped}\s*=|"
            rf"exports\.{escaped}\s*=|"
            rf"module\.exports\.{escaped}\s*=|"
            rf"\b{escaped}\s*\()"
        )
    else:  # java
        rg_pattern = rf"\b{re.escape(func_name)}\s*\("

    files = ripgrep_search_files(project_path, rg_pattern, language)
    if not files:
        # Fallback to file walk
        files = _walk_source_files(project_path, language)

    results: list[FuncInfo] = []
    search = get_ast_client().get_search(language)
    if search is None:
        return results

    for fp in files:
        funcs = search.find_functions_by_name(fp, func_name, project_path)
        results.extend(funcs)

    if ctx is not None:
        ctx.name_candidates_cache[func_name] = results

    return results


def _prefetch_candidates_batch(
    project_path: Path, language: str,
    func_names: list[str],
) -> None:
    """批量预取多个函数名的候选定义，合并为一次 ripgrep 调用。

    优化原理：
      展开一个函数的调用图时，会产生 N 个 callee 名称，如果逐个 ripgrep 搜索，
      每次都要扫描整个项目文件系统。批量预取将 N 个名称合并为一个正则交替模式
      \\b(name1|name2|...)\\s*\\( 执行一次 ripgrep，大幅减少 I/O 次数。

    结果写入 ctx.name_candidates_cache，后续 _find_function_by_name_in_project 会命中缓存。
    """
    ctx = _current_ctx.get()
    if ctx is None:
        return
    uncached = [n for n in func_names if n not in ctx.name_candidates_cache]
    if not uncached:
        return

    # Build alternation pattern: \b(name1|name2|...)\s*\(
    escaped = [re.escape(n) for n in uncached]
    names_alt = "|".join(escaped)
    if language == "python":
        rg_pattern = rf"def\s+({names_alt})\s*\("
    elif language == "javascript":
        rg_pattern = (
            rf"(function\s+({names_alt})\s*\(|"
            rf"async\s+function\s+({names_alt})\s*\(|"
            rf"(const|let|var)\s+({names_alt})\s*=|"
            rf"exports\.({names_alt})\s*=|"
            rf"module\.exports\.({names_alt})\s*=|"
            rf"\b({names_alt})\s*\()"
        )
    else:
        rg_pattern = rf"\b({names_alt})\s*\("

    files = ripgrep_search_files(project_path, rg_pattern, language)

    if files:
        search = get_ast_client().get_search(language)
        if search is not None:
            for name in uncached:
                results: list[FuncInfo] = []
                for fp in files:
                    funcs = search.find_functions_by_name(fp, name, project_path)
                    results.extend(funcs)
                ctx.name_candidates_cache[name] = results
    else:
        # Fallback: mark uncached names as empty to avoid individual ripgrep calls
        all_files = _walk_source_files(project_path, language)
        search = get_ast_client().get_search(language)
        if search is not None:
            for name in uncached:
                results = []
                for fp in all_files:
                    funcs = search.find_functions_by_name(fp, name, project_path)
                    results.extend(funcs)
                ctx.name_candidates_cache[name] = results


def _extract_call_expressions_from_func(
    file_path: Path, func_info: FuncInfo, language: str,
) -> list[tuple[str, int, str, str | None, int]]:
    """从一个函数体内提取所有调用表达式（call expressions）。

    工作流程：
      1. 用 tree-sitter 解析源文件为 AST
      2. 用 ast-grep 规则匹配所有 method_call / call_expression 节点
      3. Java 额外匹配 constructor_call（new Foo()）
      4. 按行号过滤，只保留在 func_info 范围内（start_line ~ end_line）的调用
      5. 对每个调用节点提取：方法名、receiver、参数数量

    Returns:
        list of 5-元组 (callee_name, line, call_text, receiver, arg_count):
          - callee_name: 被调方法名，如 "process"
          - line: 调用所在行号（1-based）
          - call_text: 完整调用表达式文本
          - receiver: 调用对象，如 "service" / "this" / None（无 receiver 的直接调用）
          - arg_count: 实参数量，-1 表示无法确定
    """
    sg_root = parse_file(file_path, _parser_language_for_file(file_path, language))
    if sg_root is None:
        return []

    root = sg_root.root()
    search = get_ast_client().get_search(language)
    if search is None:
        return []

    rule_name = "method_call" if language == "java" else "call_expression"
    if not search.rule_engine.has_rule(rule_name):
        return []

    rule = search.rule_engine.get_rule(rule_name)
    all_calls = list(root.find_all(config=rule))

    # Java: 额外捕获构造函数调用 new Foo()
    if language == "java" and search.rule_engine.has_rule("constructor_call"):
        ctor_rule = search.rule_engine.get_rule("constructor_call")
        ctor_calls = root.find_all(config=ctor_rule)
        all_calls.extend(ctor_calls)

    # JavaScript/TypeScript: new Foo() 在 tree-sitter 中是 new_expression，
    # 不放入 rule 文件，避免影响普通 call_expression 的稳定性。
    if language == "javascript":
        all_calls.extend(root.find_all(config={"rule": {"kind": "new_expression"}}))

    func_start = func_info.location.start_line
    func_end = func_info.location.end_line

    calls: list[tuple[str, int, str, str | None, int]] = []
    for call_node in all_calls:
        call_range = call_node.range()
        call_line = call_range.start.line + 1  # 0-based to 1-based
        if func_start <= call_line <= func_end:
            callee_name = _extract_callee_name(call_node, language)
            if callee_name:
                receiver = _extract_receiver(call_node, language)
                arg_count = _extract_arg_count(call_node, language)
                calls.append((callee_name, call_line, node_text(call_node), receiver, arg_count))

    return calls


def _javascript_member_parts(node) -> list[str]:
    """提取 JS member_expression / identifier 中的点分名称片段。"""
    kind = node.kind()
    if kind in ("identifier", "property_identifier", "private_property_identifier", "type_identifier", "super", "this"):
        return [node.text()]
    if kind == "member_expression":
        parts: list[str] = []
        for child in node.children():
            if child.kind() in (".", "?."):
                continue
            child_parts = _javascript_member_parts(child)
            if child_parts:
                parts.extend(child_parts)
        return parts
    return []


def _javascript_callee_node(call_node):
    """从 JS call_expression/new_expression 中取被调用表达式节点。"""
    if call_node.kind() == "new_expression":
        for child in call_node.children():
            if child.kind() in ("identifier", "type_identifier", "member_expression"):
                return child
        return None
    func_node = call_node.field("function")
    if func_node is not None:
        return func_node
    for child in call_node.children():
        if child.kind() in ("identifier", "member_expression", "call_expression"):
            return child
    return None


def _last_javascript_member_name(node) -> str:
    """返回 JS callee/receiver 链路中的最后一个业务名称。"""
    parts = _javascript_member_parts(node)
    return parts[-1] if parts else ""


def _javascript_receiver_from_call(call_node) -> str | None:
    """从 JS 调用节点提取 receiver 文本。"""
    callee = _javascript_callee_node(call_node)
    if callee is None or callee.kind() != "member_expression":
        return None
    parts = _javascript_member_parts(callee)
    if len(parts) < 2:
        return None
    return ".".join(parts[:-1])


def _extract_callee_name(call_node, language: str) -> str:
    """从调用表达式的 AST 节点中提取被调方法名。

    Python 处理：
      - 属性调用 obj.method() → 从 attribute 节点取最后一个 identifier
      - 直接调用 func() → 取 identifier 子节点

    Java 处理（关键逻辑）：
      - 构造函数 new Foo() → object_creation_expression → 提取 type_identifier
      - 普通方法调用 obj.method() → method_invocation → 用 field("name") 精确提取方法名
        注意：不能用 find_child_by_kind("identifier")，因为第一个 identifier
        是 receiver（如 "obj"），而非方法名（如 "method"）。
        field("name") 利用 tree-sitter 的字段标注精确定位方法名子节点。
      - 其他形式 → fallback 到 find_child_by_kind("identifier")
    """
    if language == "python":
        func_child = find_child_by_kind(call_node, "attribute")
        if func_child:
            children = list(func_child.children())
            for child in reversed(children):
                if child.kind() == "identifier":
                    return child.text()
            ident = find_child_by_kind(func_child, "identifier")
            return ident.text() if ident else ""
        func_child = find_child_by_kind(call_node, "identifier")
        if func_child:
            return func_child.text()
        return ""

    if language == "javascript":
        callee = _javascript_callee_node(call_node)
        if callee is None:
            return ""
        if callee.kind() == "new_expression":
            callee = _javascript_callee_node(callee)
            if callee is None:
                return ""
        return _last_javascript_member_name(callee)

    # java
    node_kind = call_node.kind()

    # 构造函数调用：new Foo() → 提取类名
    if node_kind == "object_creation_expression":
        type_id = find_child_by_kind(call_node, "type_identifier")
        if type_id:
            return type_id.text()
        return ""

    # 普通方法调用：method_invocation → 用 field('name') 精确提取方法名
    if node_kind == "method_invocation":
        name_node = call_node.field("name")
        if name_node:
            return name_node.text()
        return ""

    # 其他调用形式 fallback
    ident = find_child_by_kind(call_node, "identifier")
    if ident:
        return ident.text()
    return ""


def _extract_receiver(call_node, language: str) -> str | None:
    """从方法调用 AST 节点中提取调用对象（receiver）。

    仅处理 Java 的 method_invocation 节点，使用 tree-sitter 的 field("object") 精确提取。
    其他语言或非方法调用返回 None。

    示例：
      bar.process(1)             → "bar"       （变量调用）
      this.process(1)            → "this"      （当前实例调用）
      Utils.process(1)           → "Utils"     （静态/类名调用）
      a.getService().process(1)  → "a.getService()" （链式调用，receiver 是整个子表达式）
      process(1)                 → None        （无 receiver 的直接调用）

    返回值用于后续消歧：
      - receiver 首字母大写 → 可能是静态调用，按类名匹配候选
      - receiver 是 "this"/"super" → 同文件优先
      - receiver 是小写变量名 → 触发变量类型推断
    """
    if language == "javascript":
        return _javascript_receiver_from_call(call_node)

    if language != "java":
        return None

    if call_node.kind() != "method_invocation":
        return None

    obj_node = call_node.field("object")
    if obj_node is None:
        return None
    return obj_node.text()


def _extract_arg_count(call_node, language: str) -> int:
    """从调用表达式 AST 节点中提取实参数量。

    遍历 argument_list 子节点，排除括号和逗号等标点符号，计算实际参数数量。
    用于与候选函数的形参数量进行比对，辅助消歧（尤其是 Java 方法重载场景）。

    Returns:
        参数数量（>= 0），或 -1 表示无法确定（如 argument_list 不存在）。
    """
    arg_list = find_child_by_kind(call_node, "argument_list")
    if arg_list is None and language == "javascript":
        arg_list = find_child_by_kind(call_node, "arguments")
    if arg_list is None:
        return -1
    # argument_list/arguments children include parens and commas; count only non-punctuation
    args = [c for c in arg_list.children() if c.kind() not in ("(", ")", ",")]
    return len(args)


def _resolve_javascript_module_path(file_path: Path, specifier: str) -> Path | None:
    """解析 JS/TS 相对 import/require 到真实文件。"""
    if not specifier.startswith(('.', '..')):
        return None
    base = (file_path.parent / specifier).resolve()
    candidates = []
    if base.suffix in ('.js', '.ts'):
        candidates.append(base)
    else:
        candidates.extend([
            base.with_suffix('.js'),
            base.with_suffix('.ts'),
            base / 'index.js',
            base / 'index.ts',
        ])
    for candidate in candidates:
        if candidate.exists():
            return candidate
    return None


def _extract_javascript_imports(file_path: Path) -> dict[str, Path]:
    """解析 JS/TS 相对 import/require，返回 alias/name 到目标文件的映射。"""
    ctx = _current_ctx.get()
    if ctx is not None and file_path in ctx.javascript_imports_cache:
        return ctx.javascript_imports_cache[file_path]

    imports: dict[str, Path] = {}
    try:
        content = file_path.read_text(encoding='utf-8', errors='replace')
    except Exception:
        if ctx is not None:
            ctx.javascript_imports_cache[file_path] = imports
        return imports

    def add_mapping(name: str, spec: str) -> None:
        target = _resolve_javascript_module_path(file_path, spec)
        if target is not None and name:
            imports[name] = target

    # import { foo, bar as baz } from './util'
    for m in re.finditer(r"import\s+\{([^}]+)\}\s+from\s+['\"]([^'\"]+)['\"]", content):
        spec = m.group(2)
        for part in m.group(1).split(','):
            piece = part.strip()
            if not piece:
                continue
            if ' as ' in piece:
                name = piece.rsplit(' as ', 1)[1].strip()
            else:
                name = piece.split(':')[-1].strip()
            add_mapping(name, spec)

    # import foo from './util' / import * as util from './util'
    for m in re.finditer(r"import\s+([A-Za-z_$][\w$]*)\s+from\s+['\"]([^'\"]+)['\"]", content):
        add_mapping(m.group(1), m.group(2))
    for m in re.finditer(r"import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+['\"]([^'\"]+)['\"]", content):
        add_mapping(m.group(1), m.group(2))

    # const util = require('./util')
    for m in re.finditer(r"(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(['\"]([^'\"]+)['\"]\)", content):
        add_mapping(m.group(1), m.group(2))

    # const { foo, bar: baz } = require('./util')
    for m in re.finditer(r"(?:const|let|var)\s+\{([^}]+)\}\s*=\s*require\(['\"]([^'\"]+)['\"]\)", content):
        spec = m.group(2)
        for part in m.group(1).split(','):
            piece = part.strip()
            if not piece:
                continue
            name = piece.split(':')[-1].strip()
            add_mapping(name, spec)

    if ctx is not None:
        ctx.javascript_imports_cache[file_path] = imports
    return imports


def _extract_javascript_external_imports(file_path: Path) -> dict[str, str]:
    """解析 JS/TS 外部模块导入，返回本地名到 module.name 的映射。"""
    ctx = _current_ctx.get()
    if ctx is not None and file_path in ctx.javascript_external_imports_cache:
        return ctx.javascript_external_imports_cache[file_path]

    imports: dict[str, str] = {}
    try:
        content = file_path.read_text(encoding="utf-8", errors="replace")
    except Exception:
        if ctx is not None:
            ctx.javascript_external_imports_cache[file_path] = imports
        return imports

    for m in re.finditer(r"(?:const|let|var)\s+\{([^}]+)\}\s*=\s*require\(['\"]([^'\"]+)['\"]\)", content):
        module_name = m.group(2)
        if module_name.startswith((".", "..")):
            continue
        for part in m.group(1).split(","):
            piece = part.strip()
            if not piece:
                continue
            if ":" in piece:
                original, alias = [p.strip() for p in piece.split(":", 1)]
            else:
                original = alias = piece
            imports[alias] = f"{module_name}.{original}"

    for m in re.finditer(r"(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(['\"]([^'\"]+)['\"]\)", content):
        alias = m.group(1)
        module_name = m.group(2)
        if not module_name.startswith((".", "..")):
            imports[alias] = module_name

    if ctx is not None:
        ctx.javascript_external_imports_cache[file_path] = imports
    return imports


def _external_javascript_fqn(file_path: Path, callee_name: str, receiver: str | None = None) -> str | None:
    """根据外部导入把未解析 JS 调用命名为 module.name。"""
    imports = _extract_javascript_external_imports(file_path)
    if receiver:
        receiver_root = receiver.split(".")[0]
        module_name = imports.get(receiver_root)
        if module_name:
            return f"{module_name}.{callee_name}"
    return imports.get(callee_name)


def _extract_javascript_external_imports(file_path: Path) -> dict[str, str]:
    """解析 JS/TS 外部模块导入，返回本地名到 module.name 的映射。"""
    ctx = _current_ctx.get()
    if ctx is not None and file_path in ctx.javascript_external_imports_cache:
        return ctx.javascript_external_imports_cache[file_path]

    imports: dict[str, str] = {}
    try:
        content = file_path.read_text(encoding="utf-8", errors="replace")
    except Exception:
        if ctx is not None:
            ctx.javascript_external_imports_cache[file_path] = imports
        return imports

    for m in re.finditer(r"(?:const|let|var)\s+\{([^}]+)\}\s*=\s*require\(['\"]([^'\"]+)['\"]\)", content):
        module_name = m.group(2)
        if module_name.startswith((".", "..")):
            continue
        for part in m.group(1).split(","):
            piece = part.strip()
            if not piece:
                continue
            if ":" in piece:
                original, alias = [p.strip() for p in piece.split(":", 1)]
            else:
                original = alias = piece
            imports[alias] = f"{module_name}.{original}"

    for m in re.finditer(r"(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(['\"]([^'\"]+)['\"]\)", content):
        alias = m.group(1)
        module_name = m.group(2)
        if not module_name.startswith((".", "..")):
            imports[alias] = module_name

    if ctx is not None:
        ctx.javascript_external_imports_cache[file_path] = imports
    return imports


def _external_javascript_fqn(file_path: Path, callee_name: str, receiver: str | None = None) -> str | None:
    """根据外部导入把未解析 JS 调用命名为 module.name。"""
    imports = _extract_javascript_external_imports(file_path)
    if receiver:
        receiver_root = receiver.split(".")[0]
        module_name = imports.get(receiver_root)
        if module_name:
            return f"{module_name}.{callee_name}"
    return imports.get(callee_name)


def _is_javascript_decorated_method_line(file_path: Path, line: int, name: str) -> bool:
    """判断 JS method 定义是否带装饰器；带装饰器时视为 decorator 应用引用。"""
    try:
        lines = file_path.read_text(encoding="utf-8", errors="replace").split("\n")
    except Exception:
        return False
    if line <= 0 or line > len(lines):
        return False
    if not re.search(rf"\b{re.escape(name)}\s*\(", lines[line - 1]):
        return False
    idx = line - 2
    while idx >= 0 and not lines[idx].strip():
        idx -= 1
    return idx >= 0 and lines[idx].strip().startswith("@")


def _extract_javascript_variable_class(file_path: Path, variable_name: str, call_line: int) -> str | None:
    """从 JS/TS 调用点上方识别 `const x = new ClassName()` 这类轻量变量类型。"""
    try:
        content = file_path.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return None

    lines = content.split("\n")
    upper = min(call_line - 1, len(lines)) if call_line > 0 else len(lines)
    pattern = rf"\b(?:const|let|var)\s+{re.escape(variable_name)}\s*=\s*new\s+([A-Za-z_$][\w$]*)\b"
    for idx in range(upper - 1, -1, -1):
        match = re.search(pattern, lines[idx])
        if match:
            return match.group(1)
    return None



def _extract_java_imports(
    file_path: Path,
) -> dict[str, str]:
    """解析 Java 文件的 import 语句，构建类名→全限定名的映射表。

    支持三种 import 形式：
      1. 精确导入: import com.example.Foo;
         → {"Foo": "com.example.Foo"}
      2. 通配符导入: import com.example.*;
         → {"*:com.example": "com.example"}  （key 用 "*:" 前缀标识通配符）
      3. 静态导入: import static com.example.Foo.bar;
         → {"bar": "com.example.Foo"}  （方法名直接映射到所属类的 FQCN）
         注：import static com.example.Foo.* 被忽略（范围太广，消歧意义不大）

    解析策略：
      - 从文件头开始逐行扫描
      - 遇到非 package/import/空行 时停止（Java 的 import 必须在类声明之前）

    结果通过 L3 cache 缓存，同一文件在一次分析中只解析一次。
    """
    # L3 cache: avoid re-parsing imports for the same file
    ctx = _current_ctx.get()
    if ctx is not None and file_path in ctx.java_imports_cache:
        return ctx.java_imports_cache[file_path]

    imports: dict[str, str] = {}
    try:
        content = file_path.read_text(encoding="utf-8", errors="replace")
        for line in content.split("\n"):
            line = line.strip()
            if line.startswith("import ") and line.endswith(";"):
                fqcn = line[7:-1].strip()
                if fqcn.startswith("static "):
                    # import static com.example.Foo.bar;
                    static_fqcn = fqcn[7:].strip()
                    if ".*" in static_fqcn:
                        # import static com.example.Foo.* → skip (too broad)
                        continue
                    simple_name = static_fqcn.rsplit(".", 1)[-1]
                    class_fqcn = static_fqcn.rsplit(".", 1)[0] if "." in static_fqcn else ""
                    if class_fqcn:
                        imports[simple_name] = class_fqcn
                    continue
                if fqcn.endswith(".*"):
                    # import com.example.*; → wildcard
                    package_prefix = fqcn[:-2]
                    imports[f"*:{package_prefix}"] = package_prefix
                else:
                    simple_name = fqcn.rsplit(".", 1)[-1]
                    imports[simple_name] = fqcn
            elif not line.startswith("package ") and not line.startswith("import ") and not line == "":
                break
    except Exception:
        pass

    if ctx is not None:
        ctx.java_imports_cache[file_path] = imports

    return imports


def _extract_variable_type_from_java_file(
    file_path: Path, variable_name: str, call_line: int,
) -> tuple[str | None, str | None]:
    """从 Java 源文件中推断指定变量的声明类型。

    这是消歧中的关键环节：当调用形如 service.process() 时，需要知道 service 的类型
    才能确定 process() 属于哪个类。

    搜索顺序（从调用行向上回溯）：
      1. 局部变量声明: MyService service = ...;  或  MyService service;
      2. 泛型变量声明: List<String> items = ...;
      3. 方法参数:      public void foo(MyService service, ...)
      4. 类字段声明:    private MyService service;

    类型解析为 FQCN：
      - 先查精确 import（如 import com.example.MyService → FQCN=com.example.MyService）
      - 再查通配符 import（如 import com.example.* → 假定 FQCN=com.example.MyService）

    Returns:
        (simple_type, fqcn)：如 ("MyService", "com.example.MyService")
        找不到时返回 (None, None)
    """
    ctx = _current_ctx.get()
    try:
        content = file_path.read_text(encoding="utf-8", errors="replace")
        lines = content.split("\n")

        simple_type = None
        for i in range(min(call_line - 1, len(lines) - 1), -1, -1):
            line = lines[i].strip()

            # Type var = ...
            pattern = rf"\b(\w+)\s+{re.escape(variable_name)}\s*="
            match = re.search(pattern, line)
            if match:
                simple_type = match.group(1)
                break

            # Type var;
            pattern = rf"\b(\w+)\s+{re.escape(variable_name)}\s*;"
            match = re.search(pattern, line)
            if match:
                simple_type = match.group(1)
                break

            # Type<Generic> var = ... (handle generics)
            pattern = rf"\b(\w+)<[^>]*>\s+{re.escape(variable_name)}\s*[;=]"
            match = re.search(pattern, line)
            if match:
                simple_type = match.group(1)
                break

            # Method parameter: (Type var, ...)  or  (Type<G> var, ...)
            param_pattern = rf"\b(\w+)(?:<[^>]*>)?\s+{re.escape(variable_name)}\s*[,)]"
            match = re.search(param_pattern, line)
            if match and "(" in line:
                simple_type = match.group(1)
                break

            if line.startswith("public ") or line.startswith("private ") or line.startswith("protected "):
                if "{" in line and variable_name not in line:
                    break

        if simple_type is None:
            # 搜索类字段声明（private/protected/public Type fieldName;/=）
            field_pattern = rf"(?:private|protected|public)\s+(\w+)(?:<[^>]*>)?\s+{re.escape(variable_name)}\s*[;=]"
            for i in range(len(lines)):
                match = re.search(field_pattern, lines[i].strip())
                if match:
                    simple_type = match.group(1)
                    break

        if simple_type is None:
            return None, None

        imports = _extract_java_imports(file_path)
        fqcn = imports.get(simple_type)

        # If not in explicit imports, check wildcard imports
        if fqcn is None:
            for k, v in imports.items():
                if k.startswith("*:"):
                    # wildcard: assume the type is in this package
                    fqcn = f"{v}.{simple_type}"
                    break

        return simple_type, fqcn
    except Exception:
        return None, None


def _find_parent_class_names(
    project_path: Path,
    class_name: str,
) -> list[str]:
    """查找 Java 类的父类和接口名称（继承链回溯的基础）。

    工作流程：
      1. 用 ripgrep 搜索 class/interface ClassName 找到类定义文件
      2. 用正则提取 extends ParentClass 和 implements IFoo, IBar
      3. 返回父类/接口的简单名称列表（extends 在前，implements 在后）

    用途：
      当变量类型推断确定了 receiver 的类型为 MyServiceImpl，但项目中没有
      MyServiceImpl.process() 的定义（方法定义在父类 AbstractService 中），
      则需要沿继承链向上查找：MyServiceImpl → AbstractService → ...

    结果通过 resolved_cache 缓存，key 格式: "_parent_classes:ClassName"
    """
    ctx = _current_ctx.get()
    cache_key = f"_parent_classes:{class_name}"
    if ctx is not None and cache_key in ctx.resolved_cache:
        return ctx.resolved_cache[cache_key]

    rg_pattern = rf"\b(class|interface)\s+{re.escape(class_name)}\b"
    files = ripgrep_search_files(project_path, rg_pattern, "java", exclude_tests=False)

    parents: list[str] = []
    for fp in files[:3]:  # limit file reads
        try:
            content = file_util.read_file(fp)
        except Exception:
            continue
        # Match: class MyClass extends ParentClass implements IFoo, IBar
        pattern = (
            rf"\b(?:class|interface)\s+{re.escape(class_name)}"
            r"(?:<[^>]*>)?"  # optional generics
            r"\s+extends\s+(\w+)"
        )
        m = re.search(pattern, content)
        if m:
            parents.append(m.group(1))

        # Also extract implements
        impl_pattern = (
            rf"\b(?:class|interface)\s+{re.escape(class_name)}"
            r"(?:<[^>]*>)?"
            r"(?:\s+extends\s+\w+(?:<[^>]*>)?)?"
            r"\s+implements\s+([\w\s,<>]+)"
        )
        m2 = re.search(impl_pattern, content)
        if m2:
            for iface in m2.group(1).split(","):
                iface_name = iface.strip().split("<")[0].strip()
                if iface_name and iface_name not in parents:
                    parents.append(iface_name)
        if parents:
            break

    if ctx is not None:
        ctx.resolved_cache[cache_key] = parents
    return parents


@timed(logger, "realtime_analysis", "_resolve_callee_definition")
def _resolve_callee_definition(
    project_path: Path,
    language: str,
    callee_name: str,
    exclude_fqns: Set[str],
    caller_file: Path | None = None,
    call_line: int = 0,
    call_expr: str = "",
    receiver: str | None = None,
    arg_count: int = -1,
) -> FuncInfo | None:
    """核心消歧函数：将被调方法名解析为唯一的函数定义。

    这是调用图分析中最关键的函数。当项目中存在多个同名方法时（Java 重载、
    不同类中的同名方法等），需要通过多层启发式规则确定调用的到底是哪一个。

    参数说明：
      - callee_name: 被调方法名，如 "process"
      - exclude_fqns: 已访问的 FQN 集合，用于防止循环引用
      - caller_file: 调用方所在文件路径，用于同文件优先等启发式
      - call_line: 调用行号，用于变量类型推断时定位声明位置
      - call_expr: 完整调用表达式文本，用于 receiver 未传入时的回退解析
      - receiver: 调用对象文本（由 _extract_receiver 从 AST 提取），
        None 表示未提取（如从 get_function_by_call 路径调用时）
      - arg_count: 实参数量（由 _extract_arg_count 从 AST 提取），
        -1 表示未知

    消歧层级（按优先级从高到低）：
      ┌─ 阶段 0: 全局预处理 ─────────────────────────────────────────┐
      │  - 搜索项目中所有同名函数 → 候选列表                          │
      │  - 排除已访问的 FQN（循环检测）                               │
      │  - 参数数量过滤（Java，arg_count >= 0 时生效）               │
      └─────────────────────────────────────────────────────────────┘
      ┌─ 阶段 1: 构造函数识别 ──────────────────────────────────────┐
      │  new Foo() → 直接按类名匹配，FQN 修正为 _CTOR_ 后缀         │
      └─────────────────────────────────────────────────────────────┘
      ┌─ 阶段 2: 静态/类名调用 ─────────────────────────────────────┐
      │  ClassName.method() → receiver 首字母大写 → 按类名匹配候选   │
      │  注：receiver 为 None 时，从 call_expr 解析（兼容旧路径）    │
      └─────────────────────────────────────────────────────────────┘
      ┌─ 阶段 3: this/super/直接调用 → 同文件优先 ─────────────────┐
      │  receiver 是 "this"/"super" 或无 receiver → 同文件中的候选   │
      └─────────────────────────────────────────────────────────────┘
      ┌─ 阶段 4: 变量类型推断 ──────────────────────────────────────┐
      │  receiver 是小写变量名 → 推断声明类型 → 按 FQCN/类名匹配    │
      └─────────────────────────────────────────────────────────────┘
      ┌─ 阶段 5: import 辅助消歧 ──────────────────────────────────┐
      │  caller 文件的 import 语句包含某个候选的包 → 优先选择        │
      │  先试精确导入，再试通配符导入（import com.xxx.*）            │
      └─────────────────────────────────────────────────────────────┘
      ┌─ 阶段 6: 继承链回溯 ───────────────────────────────────────┐
      │  当类型推断命中但候选中无该类的方法时，沿父类链查找           │
      │  最多回溯 3 层（extends + implements）                       │
      └─────────────────────────────────────────────────────────────┘
      ┌─ 阶段 7: 兜底策略 ─────────────────────────────────────────┐
      │  同文件的候选优先 → 否则返回第一个候选                       │
      └─────────────────────────────────────────────────────────────┘
    """
    # ── 阶段 0: 全局预处理 ──────────────────────────────────────────────
    # 检测是否为构造函数调用（Java new Foo()）
    is_constructor = (
        language == "java"
        and callee_name
        and callee_name[0].isupper()
        and call_expr.strip().startswith("new ")
    )

    # 在整个项目中搜索所有同名函数定义 → 候选列表。
    # JS 构造函数调用 new Foo() 的真实定义名通常是 constructor，
    # 因此需要额外搜索 constructor 再按类名/FQN 过滤。
    candidates = _find_function_by_name_in_project(project_path, language, callee_name)
    if language == "javascript" and call_expr.strip().startswith("new "):
        constructor_candidates = _find_function_by_name_in_project(project_path, language, "constructor")
        candidates.extend(constructor_candidates)

    # 排除已访问的 FQN，防止循环引用（A → B → A）
    candidates = [c for c in candidates if c.fqn not in exclude_fqns]

    if not candidates:
        return None

    # 参数数量预过滤：调用传了 2 个参数 → 只保留形参数为 2（或可变参数）的候选
    # 这在 Java 方法重载场景中非常有效，能过滤掉 ~80% 的歧义候选
    if language == "java" and arg_count >= 0 and len(candidates) > 1:
        candidates = _filter_candidates_by_arg_count(candidates, arg_count)
        if not candidates:
            return None

    if language == "javascript":
        # JS 参数数量只做弱排序，不作为强过滤，避免默认参数/rest 参数误杀。
        if arg_count >= 0 and len(candidates) > 1:
            candidates = sorted(
                candidates,
                key=lambda c: 0 if _count_formal_params(c) == arg_count else 1,
            )

        effective_receiver = receiver
        if effective_receiver is None and call_expr and "." in call_expr:
            expr_before_paren = call_expr.split("(")[0].strip() if "(" in call_expr else call_expr
            if expr_before_paren.startswith("new "):
                expr_before_paren = expr_before_paren[4:].strip()
            parts = expr_before_paren.split(".")
            if len(parts) >= 2:
                effective_receiver = ".".join(parts[:-1]).strip()

        is_constructor_js = bool(callee_name and call_expr.strip().startswith("new "))
        if is_constructor_js:
            ctor_candidates = [
                c for c in candidates
                if c.name == "constructor" and (
                    f".{callee_name}.constructor" in c.fqn
                    or c.fqn.endswith(f".{callee_name}.constructor")
                )
            ]
            if ctor_candidates:
                return ctor_candidates[0]

        if caller_file and len(candidates) > 1:
            imports = _extract_javascript_imports(caller_file)
            target_path = None
            receiver_class = None

            # sinkB.sink2(foo) 且上方存在 let sinkB = new SinkB();
            # 则先把 receiver 变量 sinkB 轻量映射到类名 SinkB。
            if effective_receiver and "." not in effective_receiver and "(" not in effective_receiver:
                receiver_class = _extract_javascript_variable_class(
                    caller_file, effective_receiver, call_line,
                )
                if receiver_class:
                    target_path = imports.get(receiver_class)

            if target_path is None and effective_receiver:
                target_path = imports.get(effective_receiver.split(".")[0])
            if target_path is None:
                target_path = imports.get(callee_name)
            if target_path is not None:
                imported = [c for c in candidates if c.location.file_path.resolve() == target_path.resolve()]
                if receiver_class:
                    class_imported = [
                        c for c in imported
                        if f".{receiver_class}.{callee_name}" in c.fqn
                        or c.fqn.startswith(f"{receiver_class}.")
                    ]
                    if class_imported:
                        return class_imported[0]
                if imported:
                    return imported[0]

            if receiver_class:
                class_matched = [
                    c for c in candidates
                    if f".{receiver_class}.{callee_name}" in c.fqn
                    or c.fqn.startswith(f"{receiver_class}.")
                ]
                if class_matched:
                    return class_matched[0]

        if effective_receiver and effective_receiver not in ("this", "super") and effective_receiver[0].isupper():
            class_matched = [
                c for c in candidates
                if f".{effective_receiver}.{callee_name}" in c.fqn
                or c.fqn.startswith(f"{effective_receiver}.")
            ]
            if class_matched:
                return class_matched[0]

        if caller_file:
            same_file = [c for c in candidates if c.location.file_path == caller_file]
            if effective_receiver in ("this", "super") and same_file:
                owner_prefix = None
                caller_func = _find_function_at_line(caller_file, call_line, language, project_path) if call_line > 0 else None
                if caller_func and "." in caller_func.fqn:
                    owner_prefix = caller_func.fqn.rsplit(".", 1)[0]
                if owner_prefix:
                    same_class = [c for c in same_file if c.fqn.startswith(owner_prefix + ".")]
                    if same_class:
                        return same_class[0]
                return same_file[0]
            if effective_receiver is None and same_file:
                return same_file[0]
            if same_file:
                return same_file[0]

        return candidates[0]

    # ── 阶段 1: 构造函数识别 ────────────────────────────────────────────
    # new Foo() → 匹配名为 Foo 的函数（Java 构造函数名 == 类名）
    # FQN 修正：com.example.Foo.Foo → com.example.Foo._CTOR_（便于后续去重）
    if is_constructor:
        from dataclasses import replace as dc_replace
        ctor_candidates = [c for c in candidates if c.name == callee_name]
        if ctor_candidates:
            chosen = ctor_candidates[0]
            if chosen.fqn.endswith(f".{callee_name}"):
                chosen = dc_replace(
                    chosen,
                    fqn=chosen.fqn.rsplit(".", 1)[0] + "._CTOR_",
                )
            return chosen

    # ── 阶段 2: 静态/类名调用 ──────────────────────────────────────────
    # 确定 effective_receiver：优先用 AST 提取的 receiver，未传入时从 call_expr 回退解析
    # 回退场景：get_function_by_call 路径不经过 AST 提取，receiver=None
    effective_receiver = receiver
    if effective_receiver is None and language == "java" and call_expr and "." in call_expr:
        # 回退解析：从 "service.process(data)" 提取 "service"
        expr_before_paren = call_expr.split("(")[0].strip() if "(" in call_expr else call_expr
        parts = expr_before_paren.split(".")
        if len(parts) >= 2:
            effective_receiver = parts[-2].strip()

    # 首字母大写 → 可能是 ClassName.staticMethod() 或 ClassName.method()
    # 在候选中查找 FQN 包含该类名的方法

    if language == "java" and effective_receiver and effective_receiver[0].isupper():
        class_matched = [
            c for c in candidates
            if f".{effective_receiver}.{callee_name}" in c.fqn
            or c.fqn.startswith(f"{effective_receiver}.")
        ]
        if class_matched:
            return class_matched[0]

    # ── 阶段 3: this/super/直接调用 → 同文件优先 ─────────────────────
    # 判断是否为"本类方法调用"：this.method() / super.method() / method()（无 receiver）
    # 两种判断路径：
    #   - receiver 已提取（来自 _expand_callees）：直接检查是否为 "this"/"super"
    #   - receiver 未提取（来自 get_function_by_call）：从 call_expr 解析判断
    if language == "java" and caller_file:
        if receiver is not None:
            is_this_call = receiver in ("this", "super")
        elif call_expr:
            # receiver not extracted (e.g. from get_function_by_call) → infer from call_expr
            expr_before_paren = call_expr.split("(")[0].strip() if "(" in call_expr else call_expr
            if expr_before_paren.startswith("this.") or expr_before_paren.startswith("super."):
                is_this_call = True
            elif "." not in expr_before_paren and not expr_before_paren.startswith("new "):
                is_this_call = True
            else:
                is_this_call = False
        else:
            is_this_call = False
        if is_this_call:
            same_file = [c for c in candidates if c.location.file_path == caller_file]
            if same_file:
                return same_file[0]

    # ── 阶段 4: 变量类型推断 ──────────────────────────────────────────
    # receiver 是小写变量名（如 "service"）→ 推断其声明类型 → 用类型匹配候选
    var_receiver = receiver if receiver is not None else effective_receiver
    if language == "java" and caller_file and call_line > 0 and var_receiver:
        # receiver 是变量名（小写开头）→ 推断类型
        var_name = var_receiver
        # 跳过链式调用结果（如 "a.getService()"），只处理简单变量名
        if "." not in var_name and "(" not in var_name:
            # 推断变量类型：在 caller 文件中从调用行向上搜索变量声明
            simple_type, fqcn = _extract_variable_type_from_java_file(
                caller_file, var_name, call_line,
            )

            # 优先用 FQCN（全限定类名）匹配：精度最高
            if fqcn:
                fqcn_matched = [
                    c for c in candidates
                    if c.fqn.startswith(f"{fqcn}.")
                ]
                if fqcn_matched:
                    return fqcn_matched[0]

            # FQCN 匹配失败，退而用简单类名匹配（如 MyService.process）
            if simple_type:
                type_matched = [
                    c for c in candidates
                    if f".{simple_type}.{callee_name}" in c.fqn or c.fqn.startswith(f"{simple_type}.")
                ]
                if type_matched:
                    return type_matched[0]

    # ── 阶段 5: import 辅助消歧 ──────────────────────────────────────
    # 逻辑：caller 文件 import 了某个候选所在的包 → 说明调用的就是这个候选
    if language == "java" and caller_file and len(candidates) > 1:
        imports = _extract_java_imports(caller_file)

        if imports:
            # 先尝试精确导入匹配：import com.example.MyClass → 候选 FQN 以此开头
            for c in candidates:
                # FQN 格式: com.example.MyClass.methodName → 类 FQN = com.example.MyClass
                class_fqn = c.fqn.rsplit(".", 1)[0] if "." in c.fqn else ""
                class_simple = class_fqn.rsplit(".", 1)[-1] if class_fqn else ""
                if class_simple and class_simple in imports:
                    imported_fqcn = imports[class_simple]
                    if class_fqn == imported_fqcn or c.fqn.startswith(imported_fqcn + "."):
                        return c

            # 再尝试通配符导入：import com.example.* → 候选包名以此为前缀
            wildcard_prefixes = [
                v for k, v in imports.items() if k.startswith("*:")
            ]
            if wildcard_prefixes:
                for c in candidates:
                    class_fqn = c.fqn.rsplit(".", 1)[0] if "." in c.fqn else ""
                    for prefix in wildcard_prefixes:
                        if class_fqn.startswith(prefix + ".") or class_fqn == prefix:
                            return c

    # ── 阶段 6: 继承链回溯 ────────────────────────────────────────────
    # 场景：变量类型为 MyServiceImpl，方法 process() 定义在父类 AbstractService 中
    # 此时候选列表中有 AbstractService.process() 但阶段 4 按 MyServiceImpl 匹配不上
    # 解法：查找 MyServiceImpl 的父类链，在候选中匹配父类名称
    inherit_receiver = receiver if receiver is not None else effective_receiver
    if language == "java" and inherit_receiver and len(candidates) > 1:
        # 确定起始类型名：首字母大写直接用，小写则推断变量类型
        resolved_type: str | None = None
        if inherit_receiver[0].isupper():
            resolved_type = inherit_receiver
        elif caller_file and call_line > 0 and "." not in inherit_receiver and "(" not in inherit_receiver:
            resolved_type, _ = _extract_variable_type_from_java_file(
                caller_file, inherit_receiver, call_line,
            )

        if resolved_type:
            # BFS 遍历继承链：当前类 → 父类/接口 → 祖父类/接口 → ...
            visited_classes: set[str] = {resolved_type}
            parents_to_check = _find_parent_class_names(project_path, resolved_type)
            depth = 0
            while parents_to_check and depth < 3:  # 最多回溯 3 层
                depth += 1
                next_parents: list[str] = []
                for parent_name in parents_to_check:
                    if parent_name in visited_classes:
                        continue
                    visited_classes.add(parent_name)
                    # 在候选中查找 FQN 包含父类名称的方法
                    parent_matched = [
                        c for c in candidates
                        if f".{parent_name}.{callee_name}" in c.fqn
                        or c.fqn.startswith(f"{parent_name}.")
                    ]
                    if parent_matched:
                        return parent_matched[0]
                    # 当前层没匹配到，继续向上查找祖父类
                    next_parents.extend(
                        _find_parent_class_names(project_path, parent_name)
                    )
                parents_to_check = next_parents

    # ── 阶段 7: 兜底策略 ──────────────────────────────────────────────
    # 所有启发式都未命中 → 同文件中的候选优先（最可能是同类方法）→ 否则返回第一个
    if caller_file:
        same_file = [c for c in candidates if c.location.file_path == caller_file]
        if same_file:
            return same_file[0]

    return candidates[0]


def _filter_candidates_by_arg_count(
    candidates: list[FuncInfo], arg_count: int,
) -> list[FuncInfo]:
    """按参数数量过滤候选函数，解决 Java 方法重载歧义。

    对比逻辑：
      - 精确匹配：调用传了 2 个参数 → 保留形参数为 2 的候选
      - 可变参数（varargs）：形参含 "..." → 实参数 >= 形参数-1 即可
      - 无法确定形参数（返回 -1）→ 保守保留

    安全策略：如果过滤后没有任何候选匹配，返回原始列表（避免全部丢失）。
    """
    matched = []
    for c in candidates:
        formal_count = _count_formal_params(c)
        if formal_count < 0:
            matched.append(c)  # can't determine → keep
        elif formal_count == arg_count:
            matched.append(c)
        elif _has_varargs(c):
            # varargs: formal count is minimum, actual can be >= formal-1
            if arg_count >= formal_count - 1:
                matched.append(c)
    return matched if matched else candidates


def _count_formal_params(func_info: FuncInfo) -> int:
    """从函数签名中计算形式参数数量。

    解析策略：
      - 从签名/内容中提取第一对括号 (...) 内的参数字符串
      - 按逗号分割计数，但忽略泛型 <> 内部的逗号（如 Map<K, V> 算一个参数）
      - 空参数列表 "()" → 返回 0

    Returns:
        形参数量（>= 0），或 -1 表示无法从签名中解析。
    """
    sig = func_info.signature or ""
    if not sig:
        sig = func_info.content or ""
    # Find first '(' ... ')' pair
    paren_start = sig.find("(")
    if paren_start < 0:
        return -1
    paren_end = sig.find(")", paren_start)
    if paren_end < 0:
        return -1
    params_str = sig[paren_start + 1:paren_end].strip()
    if not params_str:
        return 0
    # Count commas (handles generics by tracking angle brackets)
    count = 1
    angle_depth = 0
    for ch in params_str:
        if ch == '<':
            angle_depth += 1
        elif ch == '>':
            angle_depth -= 1
        elif ch == ',' and angle_depth == 0:
            count += 1
    return count


def _has_varargs(func_info: FuncInfo) -> bool:
    """检查函数是否包含可变参数（Java 的 "..." 语法）。

    示例：public void process(String... args) → True
    """
    sig = func_info.signature or func_info.content or ""
    paren_start = sig.find("(")
    paren_end = sig.find(")", paren_start) if paren_start >= 0 else -1
    if paren_start < 0 or paren_end < 0:
        return False
    return "..." in sig[paren_start:paren_end]


@timed(logger, "realtime_analysis", "_locate_target_function")
def _locate_target_function(
    project_path: Path,
    language: str,
    name: str,
    function_fqn: str = "",
    file_path: str = "",
    line: int = 0,
) -> FuncInfo | None:
    """定位调用图分析的目标函数（入口函数）。

    优先级策略：
      1. 如果提供了 file_path + line → 直接在该文件该行查找包含的函数
      2. 按函数名搜索整个项目 → 得到候选列表
      3. 按 FQN 精确匹配 / 后缀匹配 筛选
      4. 按文件路径后缀匹配 筛选
      5. 兜底：返回第一个候选
    """
    if file_path and line > 0:
        fp = Path(file_path)
        if not fp.is_absolute():
            fp = project_path / fp
        if fp.exists():
            func = _find_function_at_line(fp, line, language, project_path)
            if func:
                return func

    search_name = name
    if not search_name and function_fqn:
        search_name = function_fqn.rsplit(".", 1)[-1]

    if not search_name:
        return None

    candidates = _find_function_by_name_in_project(project_path, language, search_name)

    if not candidates:
        return None

    if function_fqn:
        fqn_matches = [c for c in candidates if c.fqn == function_fqn]
        if fqn_matches:
            return fqn_matches[0]
        fqn_matches = [c for c in candidates if c.fqn.endswith(function_fqn)]
        if fqn_matches:
            return fqn_matches[0]

    if file_path:
        fp = Path(file_path)
        file_matches = [
            c for c in candidates
            if str(c.location.file_path).endswith(str(fp))
        ]
        if file_matches:
            return file_matches[0]

    return candidates[0]


def _is_definition_line(content: str, name: str, language: str) -> bool:
    """判断 ripgrep 命中行是否为函数/类的定义行（而非调用点）。

    在 get_reference_by_function 中用于过滤掉定义行，只保留调用点。

    判断规则：
      Java:
        - 包含 class/interface/enum 关键字 + 目标名 → 是定义
        - 名字前有 Java 修饰符(public/private/...) + 名字后紧跟 "(" → 方法定义
        - 名字前是大写开头的类型名(返回类型) + 名字后紧跟 "(" → 方法定义
      Python:
        - 行首为 def/class/@ + 包含目标名 → 是定义
    """
    stripped = content.strip()

    if language == "java":
        # ── 规则 1: 类/接口/枚举 声明行 ──
        java_def_keywords = ("class ", "interface ", "enum ")
        for kw in java_def_keywords:
            if kw in stripped and name in stripped:
                return True

        # ── 规则 2/3: 方法定义行（通过修饰符或返回类型判断）──
        java_modifiers = ("public ", "private ", "protected ", "static ", "abstract ",
                          "final ", "synchronized ", "native ", "default ")
        name_idx = stripped.find(name)
        if name_idx > 0:
            before_name = stripped[:name_idx].strip()
            # 规则 2: 修饰符 + 方法名 + "(" → 方法定义
            if any(before_name.startswith(mod) or f" {mod.strip()} " in f" {before_name} "
                   for mod in java_modifiers):
                after_name = stripped[name_idx + len(name):]
                if after_name.lstrip().startswith("("):
                    return True

            # 规则 3: 返回类型(大写开头) + 方法名 + "(" → 方法定义
            # 例如: "List<String> process(" → before_name="List<String>", 匹配大写开头
            after_name = stripped[name_idx + len(name):]
            if after_name.lstrip().startswith("("):
                if re.match(r'^[A-Z]\w*(<.*>)?$', before_name):
                    return True
                if re.match(r'^[A-Z]\w*(<[^>]+>)?\s*$', before_name):
                    return True

    elif language == "python":
        # Python: def/class/装饰器 开头即为定义行
        if stripped.startswith("def ") and name in stripped:
            return True
        if stripped.startswith("class ") and name in stripped:
            return True
        if stripped.startswith("@") and name in stripped:
            return True

    elif language == "javascript":
        escaped = re.escape(name)
        definition_patterns = [
            rf"^(?:export\s+)?(?:async\s+)?function\s+{escaped}\s*\(",
            rf"^(?:export\s+)?(?:const|let|var)\s+{escaped}\s*=",
            rf"^(?:module\.)?exports\.{escaped}\s*=",
            rf"^(?:export\s+)?class\s+{escaped}\b",
            rf"^(?:async\s+|static\s+|static\s+async\s+)?{escaped}\s*\([^)]*\)\s*\{{",
        ]
        if any(re.search(pattern, stripped) for pattern in definition_patterns):
            return True

    return False


# ─── get_call_graph ──────────────────────────────────────────────────────────


def _extract_javascript_anonymous_functions_from_func(
    file_path: Path, func_info: FuncInfo, language: str,
) -> list[FuncInfo]:
    """提取 JS 函数体内的匿名函数/箭头函数，作为调用图合成 callee。"""
    if language != "javascript":
        return []

    sg_root = parse_file(file_path, _parser_language_for_file(file_path, language))
    if sg_root is None:
        return []

    root = sg_root.root()
    anonymous_kinds = ("function_expression", "arrow_function", "generator_function")
    nodes = []
    for kind in anonymous_kinds:
        nodes.extend(root.find_all(config={"rule": {"kind": kind}}))

    results: list[FuncInfo] = []
    seen: set[tuple[int, int, int, int]] = set()
    for node in nodes:
        node_range = node.range()
        start_line = node_range.start.line + 1
        end_line = node_range.end.line + 1
        start_col = node_range.start.column
        end_col = node_range.end.column

        if not (func_info.location.start_line <= start_line <= func_info.location.end_line):
            continue
        # 跳过当前函数自身，避免把入口函数重复当成匿名 callee。
        if (
            start_line == func_info.location.start_line
            and end_line == func_info.location.end_line
            and start_col == func_info.location.start_column
            and end_col == func_info.location.end_column
        ):
            continue

        key = (start_line, start_col, end_line, end_col)
        if key in seen:
            continue
        seen.add(key)

        # 缓存 callgraph 的 anonymousFunc FQN 使用 1-based column，
        # ast-grep range 的 column 是 0-based，因此 FQN 中列号需要 +1 对齐。
        fqn_start_col = start_col + 1
        fqn_end_col = end_col + 1
        fqn = f"{func_info.fqn}.<anonymousFunc_{start_line}_{fqn_start_col}_{end_line}_{fqn_end_col}>"
        results.append(FuncInfo(
            name=f"<anonymousFunc_{start_line}_{fqn_start_col}_{end_line}_{fqn_end_col}>",
            fqn=fqn,
            signature="",
            location=Location(
                file_path=file_path,
                start_line=start_line,
                start_column=start_col,
                end_line=end_line,
                end_column=end_col,
            ),
            content=node_text(node),
        ))

    results.sort(key=lambda item: (item.location.start_line, item.location.start_column))
    return results


def _expand_callees(
    project_path: Path,
    language: str,
    func_info: FuncInfo,
    depth: int,
    max_callees_per_node: int,
    exclude_undefined: bool,
    detail_level: str,
    visited: Set[str],
) -> list[Callee]:
    """递归展开函数的所有被调用者（callee），构建调用树。

    这是 get_call_graph 的核心递归函数，负责：
      1. 从目标函数体中提取所有调用表达式
      2. 批量预取候选（减少 ripgrep 调用次数）
      3. 逐个解析每个 callee 的定义位置
      4. 递归展开子 callee（受 depth 限制）
      5. 检测循环调用（visited 集合）

    流程：
    ┌─────────────────────────────────────────────────┐
    │  _extract_call_expressions_from_func(func_info)  │
    │  → [(callee_name, line, text, receiver, argc)]   │
    └───────────────────┬─────────────────────────────┘
                        │
    ┌───────────────────▼─────────────────────────────┐
    │  _prefetch_candidates_batch(unique_names)         │
    │  → 批量填充 ctx.name_candidates_cache             │
    └───────────────────┬─────────────────────────────┘
                        │
    ┌───────────────────▼─────────────────────────────┐
    │  for each call:                                   │
    │    _resolve_callee_definition(callee_name, ...)   │
    │    → FuncInfo | None                              │
    │    if depth > 1 and not cycle:                    │
    │      _expand_callees(callee_func, depth-1)        │
    └─────────────────────────────────────────────────┘

    Args:
        depth: 剩余递归深度，每层递减 1，到 0 停止
        max_callees_per_node: 每个节点最多展开的 callee 数量（0 = 无限）
        exclude_undefined: True 时跳过找不到定义的 callee
        detail_level: "full" 时在结果中包含函数体内容
        visited: 已访问的 FQN 集合，用于检测循环调用
    """
    if depth <= 0:
        return []

    # ── 步骤 1: 提取当前函数体内的所有调用表达式 ──
    file_path = func_info.location.file_path
    calls = _extract_call_expressions_from_func(file_path, func_info, language)

    # ── 步骤 2: 批量预取所有 callee 名的候选定义（减少 ripgrep 次数）──
    ctx = _current_ctx.get()
    if ctx is not None and calls:
        unique_names = list(dict.fromkeys(name for name, _, _, _, _ in calls))
        if max_callees_per_node > 0:
            unique_names = unique_names[:max_callees_per_node]
        _prefetch_candidates_batch(project_path, language, unique_names)

    # ── 步骤 3: 逐个解析 callee 定义并递归展开 ──
    callees: list[Callee] = []
    seen_callees: Set[str] = set()  # 去重：同一函数中对同名方法的多次调用只处理一次

    for callee_name, call_line, call_text, receiver, arg_count in calls:
        # 去重：同名 callee 只处理第一次出现
        if callee_name in seen_callees:
            continue
        seen_callees.add(callee_name)

        # 限流：达到 max_callees_per_node 后停止
        if max_callees_per_node > 0 and len(callees) >= max_callees_per_node:
            break

        # 解析 callee 的定义位置（经过多级消歧）
        callee_func = _resolve_callee_definition(
            project_path, language, callee_name, visited, caller_file=file_path,
            call_line=call_line, call_expr=call_text,
            receiver=receiver, arg_count=arg_count,
        )

        # 未找到定义：根据 exclude_undefined 决定是否保留占位 Callee
        if callee_func is None:
            if exclude_undefined:
                continue
            unresolved_fqn = callee_name
            if language == "javascript":
                unresolved_fqn = _external_javascript_fqn(file_path, callee_name, receiver) or callee_name
            callees.append(
                Callee(
                    call_site=CallSite(
                        file_path=_rel_path(file_path, project_path).as_posix(),
                        line=call_line,
                        content=call_text.strip(),
                    ),
                    function_fqn=unresolved_fqn,
                    function_signature="",
                    location=ServiceLocation.default(),
                    content="",
                    has_cycle=False,
                    callees=[],
                )
            )
            continue

        # 循环检测：callee 已在 visited 中 → 标记 has_cycle，不再递归
        has_cycle = callee_func.fqn in visited

        # detail_level="full" 时包含函数体全文
        content = ""
        if detail_level == "full":
            content = callee_func.content

        # 递归展开子 callee（仅在无循环且 depth > 1 时）
        sub_callees: list[Callee] = []
        if not has_cycle and depth > 1:
            visited.add(callee_func.fqn)
            sub_callees = _expand_callees(
                project_path=project_path,
                language=language,
                func_info=callee_func,
                depth=depth - 1,
                max_callees_per_node=max_callees_per_node,
                exclude_undefined=exclude_undefined,
                detail_level=detail_level,
                visited=visited,
            )

        callees.append(
            Callee(
                call_site=CallSite(
                    file_path=_rel_path(file_path, project_path).as_posix(),
                    line=call_line,
                    content=call_text.strip(),
                ),
                function_fqn=callee_func.fqn,
                function_signature=callee_func.signature,
                location=ServiceLocation(
                    file_path=_rel_path(callee_func.location.file_path, project_path),
                    start_line=callee_func.location.start_line,
                    start_column=callee_func.location.start_column,
                    end_line=callee_func.location.end_line,
                    end_column=callee_func.location.end_column,
                ),
                content=content,
                has_cycle=has_cycle,
                callees=sub_callees,
            )
        )

    if language == "javascript":
        for anonymous_func in _extract_javascript_anonymous_functions_from_func(file_path, func_info, language):
            if max_callees_per_node > 0 and len(callees) >= max_callees_per_node:
                break
            if anonymous_func.fqn in seen_callees:
                continue
            seen_callees.add(anonymous_func.fqn)

            has_cycle = anonymous_func.fqn in visited
            sub_callees = []
            if not has_cycle and depth > 1:
                visited.add(anonymous_func.fqn)
                sub_callees = _expand_callees(
                    project_path=project_path,
                    language=language,
                    func_info=anonymous_func,
                    depth=depth - 1,
                    max_callees_per_node=max_callees_per_node,
                    exclude_undefined=exclude_undefined,
                    detail_level=detail_level,
                    visited=visited,
                )

            callees.append(
                Callee(
                    call_site=CallSite(
                        file_path=_rel_path(file_path, project_path).as_posix(),
                        line=anonymous_func.location.start_line,
                        content=(anonymous_func.content or "").split("\n", 1)[0].strip(),
                    ),
                    function_fqn=anonymous_func.fqn,
                    function_signature=anonymous_func.signature,
                    location=ServiceLocation(
                        file_path=_rel_path(anonymous_func.location.file_path, project_path),
                        start_line=anonymous_func.location.start_line,
                        start_column=anonymous_func.location.start_column,
                        end_line=anonymous_func.location.end_line,
                        end_column=anonymous_func.location.end_column,
                    ),
                    content=anonymous_func.content if detail_level == "full" else "",
                    has_cycle=has_cycle,
                    callees=sub_callees,
                )
            )

    return callees


@timed(logger, "realtime_analysis", "realtime_get_call_graph")
def realtime_get_call_graph(
    project_path: Path,
    language: str,
    name: str,
    function_fqn: str = "",
    function_signature: str = "",
    file_path: str = "",
    line: int = 0,
    depth: int = 3,
    use_regex: bool = False,
    detail_level: str = "summary",
    max_callees_per_node: int = 3,
    exclude_undefined_function_call: bool = True,
) -> list[GetCallGraphOutput]:
    """实时调用图分析顶层接口：给定函数，递归展开其所有 callee。

    两阶段流程：
      阶段 1 — 定位目标函数（_locate_target_function）
        通过 name/fqn/file_path/line 组合定位唯一入口函数
      阶段 2 — 递归展开调用图（_expand_callees）
        从入口函数开始，逐层提取 + 解析调用，构建 Caller → [Callee] 树

    返回值为 list，始终包含 0 或 1 个 GetCallGraphOutput 元素。

    Args:
        name: 目标函数名（必填）
        function_fqn: 完全限定名，用于精确匹配
        file_path: 目标文件路径，缩小搜索范围
        line: 目标行号，配合 file_path 直接定位
        depth: 最大递归深度（默认 3 层）
        max_callees_per_node: 每节点最多展开 callee 数（0=无限）
        exclude_undefined_function_call: 是否排除未找到定义的 callee
    """
    # ── 阶段 1: 定位目标函数 ──
    stage_start = time.perf_counter()
    target_func = _locate_target_function(
        project_path, language, name, function_fqn, file_path, line,
    )
    if target_func is None:
        return []
    logger.info(
        "[realtime_get_call_graph] 阶段1(定位目标函数): found=%s, duration=%.1fms",
        target_func.fqn, (time.perf_counter() - stage_start) * 1000,
    )

    # ── 构建 Caller 信息（返回值的根节点）──
    caller = Caller(
        function_fqn=target_func.fqn,
        function_signature=target_func.signature,
        file_path=_rel_path(target_func.location.file_path, project_path).as_posix(),
        line=target_func.location.start_line,
    )

    # ── 阶段 2: 递归展开 callee 调用树 ──
    stage_start = time.perf_counter()
    visited: Set[str] = {target_func.fqn}  # 循环检测集合，初始包含目标函数自身
    ctx = _CallGraphContext()  # 创建本次调用图的缓存上下文
    token = _current_ctx.set(ctx)
    try:
        callees = _expand_callees(
            project_path=project_path,
            language=language,
            func_info=target_func,
            depth=depth,
            max_callees_per_node=max_callees_per_node,
            exclude_undefined=exclude_undefined_function_call,
            detail_level=detail_level,
            visited=visited,
        )
    finally:
        _current_ctx.reset(token)
    logger.info(
        "[realtime_get_call_graph] 阶段2(展开调用图): callees=%d, duration=%.1fms, "
        "L1_cache=%d, L3_cache=%d",
        len(callees), (time.perf_counter() - stage_start) * 1000,
        len(ctx.name_candidates_cache),
        len(ctx.java_imports_cache) + len(ctx.javascript_imports_cache),
    )

    output = GetCallGraphOutput(caller=caller, callees=callees)
    logger.info("[realtime_get_call_graph] 返回结果数量: 1")
    logger.info("[realtime_get_call_graph] parse_cache: %s", parse_cache_info())
    return [output]


# ─── get_function_by_call ────────────────────────────────────────────────────



@timed(logger, "realtime_analysis", "_locate_call_sites")
def _locate_call_sites(
    project_path: Path,
    language: str,
    function_call: str,
    file_path: str = "",
    line: int = 0,
    fuzzy_match: bool = False,
) -> list[tuple[Path, int, str]]:
    """在项目中定位函数调用发生的位置（供 get_function_by_call 使用）。

    查找策略：
      1. fixed-string 模式（-F）精确搜索完整 function_call
      2. 精确搜索无结果 → 截取调用前缀模糊搜索（-i）
         - 有 "." 的调用：保留到方法名（如 a.b.f(1,2) → a.b.f）
         - 无 "." 的调用：保留方法名+左括号（如 f1(1,2) → f1(）
      3. 两轮过滤：先过滤定义行+file_path，再按 line 精准命中过滤

    Returns:
        list of (file_path, line_number, content) 三元组
    """
    if not function_call.strip():
        return []

    # ── 阶段 1：ripgrep 搜索 ──
    # 精确搜索：fixed-string 模式（-F），直接匹配原始字符串 可能包含定义行的结果
    callee_name = _parse_callee_name(function_call)
    results = _ripgrep_search_with_line(project_path, function_call, language)

    # 提前过滤定义行，判断精确搜索是否有有效调用行
    if results and callee_name:
        results = [
            (p, l, c) for p, l, c in results
            if not _is_definition_line(c, callee_name, language)
        ]

    # 精确搜索无有效结果 → fallback 搜索（-i 正则模式，配合 re.escape 转义）
    if not results:
        # 构造 fallback keyword：截取调用前缀
        # 有 "." 的调用（如 a.b.f(1,2)）→ 保留 "a.b.f"
        # 无 "." 的调用（如 f1(1,2)）→ 保留 "f1("
        fallback_keyword = None
        paren_idx = function_call.find("(")
        if paren_idx > 0:
            prefix = function_call[:paren_idx]
            fallback_keyword = prefix if "." in prefix else prefix + "("
            fallback_keyword = re.escape(fallback_keyword)

        if fallback_keyword:
            results = _ripgrep_search_with_line(
                project_path, fallback_keyword, language, fuzzy_match=True
            )
            # fallback 结果也需要过滤定义行
            if results and callee_name:
                results = [
                    (p, l, c) for p, l, c in results
                    if not _is_definition_line(c, callee_name, language)
                ]

    if not results:
        return []

    # ── 阶段 2：两轮过滤 ──

    # 统一 query_path 为相对路径
    query_path = Path(file_path) if file_path else Path("")
    if query_path.is_absolute():
        try:
            query_path = query_path.relative_to(project_path)
        except ValueError:
            pass

    # 第 1 轮：file_path 过滤
    filtered = []
    for result_path, result_line, content in results:
        if file_path:
            try:
                rel_path = result_path.relative_to(project_path) if result_path.is_absolute() else result_path
            except ValueError:
                rel_path = result_path
            if not ParamsValidator._validate_file_path(query_path, rel_path, fuzzy_match):
                continue
        filtered.append((result_path, result_line, content))

    # 第 2 轮：line 过滤（有精准命中则只保留命中项，否则全部保留）
    if line > 0 and filtered:
        line_matched = [
            (rp, rl, c) for rp, rl, c in filtered
            if ParamsValidator._validate_line(line, rl, fuzzy_match)
        ]
        if line_matched:
            filtered = line_matched

    return filtered


@timed(logger, "realtime_analysis", "realtime_get_function_by_call")
def realtime_get_function_by_call(
    project_path: Path,
    language: str,
    function_call: str,
    file_path: str = "",
    line: int = 0,
    fuzzy_match: bool = False,
    max_results: int = 10,
) -> list[GetFunctionDefByFunctionCallOutput]:
    """实时函数调用解析顶层接口：给定调用表达式，解析被调函数定义。

    三步流程：
    ┌──────────────────────────────────────────────────────────┐
    │ 步骤 1: 定位调用点 → ripgrep 精确搜索 + 过滤定义行       │
    │   _locate_call_sites(project_path, ...)                   │
    │   → [(file, line, content), ...]                          │
    ├──────────────────────────────────────────────────────────┤
    │ 步骤 2: 对每个调用点，找到包含该调用的函数（caller）      │
    │   _find_function_at_line(site_file, site_line, ...)       │
    │   → FuncInfo (caller)                                     │
    ├──────────────────────────────────────────────────────────┤
    │ 步骤 3: 解析被调方法定义（callee definition）             │
    │   _resolve_callee_definition(callee_name, ...)            │
    │   → FuncInfo | None                                       │
    └──────────────────────────────────────────────────────────┘

    注意：此接口不传入 receiver/arg_count（因为调用字符串无法精确提取），
    _resolve_callee_definition 会通过 effective_receiver 回退逻辑从
    call_expr 字符串中解析 receiver。

    Args:
        function_call: 调用表达式字符串，如 "service.process(data)"
        file_path: 限定搜索的文件路径
        line: 已知调用行号（与 file_path 配合精确定位）
        fuzzy_match: 模糊匹配模式
        max_results: 最大返回结果数（0=无限）
    """
    _MAX_CALL_SITES = 100

    # ── 设置请求级缓存上下文 ──
    ctx = _CallGraphContext()
    token = _current_ctx.set(ctx)
    try:
        return _realtime_get_function_by_call_impl(
            project_path, language, function_call, file_path, line,
            fuzzy_match, max_results, _MAX_CALL_SITES,
        )
    finally:
        _current_ctx.reset(token)


def _realtime_get_function_by_call_impl(
    project_path: Path,
    language: str,
    function_call: str,
    file_path: str,
    line: int,
    fuzzy_match: bool,
    max_results: int,
    max_call_sites: int,
) -> list[GetFunctionDefByFunctionCallOutput]:
    """realtime_get_function_by_call 的内部实现（ctx 已通过 contextvars 设置）。"""
    # ── 步骤 1: 解析调用字符串，提取被调方法名 ──
    callee_name = _parse_callee_name(function_call)
    if not callee_name:
        return []

    # ── 步骤 2: 定位调用点（ripgrep 搜索）──
    stage_start = time.perf_counter()
    call_sites = _locate_call_sites(
        project_path, language, function_call, file_path, line, fuzzy_match
    )

    if not call_sites:
        return []
    logger.info(
        "[realtime_get_function_by_call] 阶段1(定位调用点): sites=%d, duration=%.1fms",
        len(call_sites), (time.perf_counter() - stage_start) * 1000,
    )

    # ── 调用点数量上限截断 ──
    if len(call_sites) > max_call_sites:
        logger.warning(
            "[realtime_get_function_by_call] call_sites=%d 超过上限 %d，截断处理",
            len(call_sites), max_call_sites,
        )

    # ── 步骤 3+4: 遍历调用点，找 caller 函数 + 解析 callee 定义 ──
    stage_start = time.perf_counter()
    results: list[GetFunctionDefByFunctionCallOutput] = []
    seen_callee_fqns: set[str] = set()  # 去重：同一 callee FQN 只返回一次
    total_sites = min(len(call_sites), max_call_sites)

    for idx, (site_file, site_line, site_content) in enumerate(call_sites[:max_call_sites]):
        iter_start = time.perf_counter()
        if max_results > 0 and len(results) >= max_results:
            break

        # 步骤 3: 找到包含该调用点的函数（caller）
        caller_func = _find_function_at_line(site_file, site_line, language, project_path)
        if caller_func is None:
            logger.info(
                "[realtime_get_function_by_call] iter=%d/%d site=%s:%d elapsed=%.3fs results=%d seen_callees=%d (skipped: no caller)",
                idx + 1, total_sites, site_file, site_line,
                time.perf_counter() - iter_start, len(results), len(seen_callee_fqns),
            )
            continue

        # 路径相对化工具
        def _rel(p: Path) -> Path:
            return _rel_path(p, project_path)

        caller_rel_path = _rel(caller_func.location.file_path)
        site_rel_path = _rel(Path(str(site_file)))

        caller = Caller(
            function_fqn=caller_func.fqn,
            function_signature=caller_func.signature,
            file_path=str(caller_rel_path),
            line=caller_func.location.start_line,
        )

        call_site = CallSite(
            file_path=str(site_rel_path),
            line=site_line,
            content=site_content.strip(),
        )

        # 步骤 4: 解析被调方法定义
        # 注意：不传 receiver/arg_count，依赖 effective_receiver 回退逻辑
        # ctx 通过 contextvars 自动传递给内部函数
        callee_func = _resolve_callee_definition(
            project_path, language, callee_name, set(), caller_file=site_file,
            call_line=site_line, call_expr=function_call,
        )

        if callee_func is None:
            results.append(
                GetFunctionDefByFunctionCallOutput(
                    caller=caller,
                    call_site=call_site,
                    function_fqn=callee_name,
                    function_signature="",
                    location=ServiceLocation.default(),
                    content="",
                )
            )
        else:
            if callee_func.fqn in seen_callee_fqns:
                logger.info(
                    "[realtime_get_function_by_call] iter=%d/%d site=%s:%d elapsed=%.3fs results=%d seen_callees=%d (skipped: dup fqn)",
                    idx + 1, total_sites, site_file, site_line,
                    time.perf_counter() - iter_start, len(results), len(seen_callee_fqns),
                )
                continue
            seen_callee_fqns.add(callee_func.fqn)

            callee_rel_path = _rel(callee_func.location.file_path)
            callee_location = ServiceLocation(
                file_path=callee_rel_path,
                start_line=callee_func.location.start_line,
                start_column=callee_func.location.start_column,
                end_line=callee_func.location.end_line,
                end_column=callee_func.location.end_column,
            )

            results.append(
                GetFunctionDefByFunctionCallOutput(
                    caller=caller,
                    call_site=call_site,
                    function_fqn=callee_func.fqn,
                    function_signature=callee_func.signature,
                    location=callee_location,
                    content=callee_func.content,
                )
            )

        logger.info(
            "[realtime_get_function_by_call] iter=%d/%d site=%s:%d elapsed=%.3fs results=%d seen_callees=%d",
            idx + 1, total_sites, site_file, site_line,
            time.perf_counter() - iter_start, len(results), len(seen_callee_fqns),
        )

    ctx = _current_ctx.get()
    logger.info(
        "[realtime_get_function_by_call] 阶段2(解析被调用方): results=%d, duration=%.1fms, "
        "L1_cache=%d, L2_cache=%d, L3_cache=%d",
        len(results), (time.perf_counter() - stage_start) * 1000,
        len(ctx.name_candidates_cache) if ctx else 0,
        len(ctx.func_defs_cache) if ctx else 0,
        (len(ctx.java_imports_cache) + len(ctx.javascript_imports_cache)) if ctx else 0,
    )
    logger.info("[realtime_get_function_by_call] 返回结果数量: %d", len(results))
    logger.info("[realtime_get_function_by_call] parse_cache: %s", parse_cache_info())
    return results


# ─── get_reference_by_function ───────────────────────────────────────────────


@timed(logger, "realtime_analysis", "realtime_get_reference_by_function")
def realtime_get_reference_by_function(
    project_path: Path,
    language: str,
    name: str,
    function_fqn: str = "",
    function_signature: str = "",
    file_path: str = "",
    line: int = 0,
    use_regex: bool = False,
    offset: int = 0,
    max_results: int = 10,
) -> list[GetFunctionReferenceOutput]:
    """实时引用搜索顶层接口：给定函数，反向查找所有调用/引用该函数的位置。

    三阶段流程：
    ┌──────────────────────────────────────────────────────────────┐
    │ 阶段 1: ripgrep 全文搜索（词边界匹配）                        │
    │   搜索模式: \\bfunction_name\\b                               │
    │   → 过滤语言后缀 + 排除测试目录                               │
    ├──────────────────────────────────────────────────────────────┤
    │ 阶段 2: 过滤定义行 + FQN 精确筛选                             │
    │   2a. _is_definition_line() 过滤掉函数/类定义行               │
    │   2b. Java: FQN 提供类名时，用 receiver 匹配 + 同名方法去重    │
    │   2c. Python: FQN 提供模块名时，按文件名过滤                   │
    ├──────────────────────────────────────────────────────────────┤
    │ 阶段 3: AST 定位包围函数                                      │
    │   对每个调用点，用 AST 提取其所在的 enclosing function         │
    │   → 构建 GetFunctionReferenceOutput                           │
    └──────────────────────────────────────────────────────────────┘

    Args:
        name: 目标函数名
        function_fqn: FQN（Java 用类名精确过滤，Python 用模块名过滤）
        file_path: 限定搜索范围的文件路径
        use_regex: 是否以正则模式搜索
        offset: 分页偏移量
        max_results: 最大返回数（0=无限）
    """
    # ── 预处理: 确定搜索名称 ──
    search_name = name
    if not search_name and function_fqn:
        search_name = function_fqn.rsplit(".", 1)[-1]

    if not search_name:
        return []

    extensions = LANGUAGE_EXTENSIONS.get(language)
    if not extensions:
        logger.warning(f"Unsupported language for realtime reference search: {language}")
        return []

    client = get_ast_client()

    # ══════════════════════════════════════════════════════════
    # 阶段 1: ripgrep 全文搜索（词边界匹配 + 语言过滤）
    # ══════════════════════════════════════════════════════════
    stage_start = time.perf_counter()
    rg_tool = get_ripgrep_tool()
    if rg_tool is None:
        logger.warning("Ripgrep tool not available for reference search")
        return []

    if use_regex:
        rg_pattern = search_name
    else:
        rg_pattern = r"\b" + re.escape(search_name) + r"\b"

    matches = rg_tool.search_keyword_with_line(
        project_path, rg_pattern, use_regex=True,
    )
    if not matches:
        return []

    # 过滤：仅保留目标语言后缀的文件，排除测试目录
    matches = [m for m in matches
               if any(str(m.file_path).endswith(ext) for ext in extensions)
               and not is_test_path(m.file_path, project_path)]
    if not matches:
        return []

    # 按 file_path 进一步缩小范围（如果用户指定了文件）
    if file_path:
        matches = [m for m in matches if str(m.file_path).endswith(file_path)
                   or file_path in str(m.file_path)]
    logger.info(
        "[realtime_get_reference_by_function] 阶段1(ripgrep搜索): matches=%d, duration=%.1fms",
        len(matches), (time.perf_counter() - stage_start) * 1000,
    )

    # ══════════════════════════════════════════════════════════
    # 阶段 2: 过滤定义行，只保留调用点
    # ══════════════════════════════════════════════════════════
    stage_start = time.perf_counter()
    call_site_matches = []
    for m in matches:
        # 2a. 过滤掉函数/类定义行（只保留调用行）。
        # JS decorated method 的定义行本身代表 decorator 应用关系，需要保留为引用。
        if _is_definition_line(m.content, search_name, language):
            if not (
                language == "javascript"
                and _is_javascript_decorated_method_line(m.file_path, m.line, search_name)
            ):
                continue
        call_site_matches.append(m)

    if not call_site_matches:
        return []

    # ── 阶段 2.5: Java FQN 精确过滤 ──
    # 当提供了 function_fqn（如 "com.foo.Service.process"）时，
    # 提取类名 "Service"，只保留调用行中包含类名引用的条目，
    # 避免将其他类的同名方法误报为引用。
    if function_fqn and "." in function_fqn and language == "java":
        fqn_parts = function_fqn.rsplit(".", 1)
        target_class_fqn = fqn_parts[0]  # 如 "com.foo.Service"
        target_class_name = target_class_fqn.rsplit(".", 1)[-1]  # 如 "Service"
        target_class_path = target_class_fqn.replace(".", "/") + ".java"  # 如 "com/foo/Service.java"

        # 构建目标类的引用标识符集合：类名 + 常见变量名(驼峰首字母小写)
        target_var_name = target_class_name[0].lower() + target_class_name[1:]
        target_indicators = {target_class_name, target_var_name}

        # 收集所有不同的 receiver 名（如 "service", "handler" 等）
        distinct_callers: set[str] = set()
        for m in call_site_matches:
            match = re.search(r'(\w+)\s*\.\s*' + re.escape(search_name) + r'\s*\(', m.content)
            if match:
                distinct_callers.add(match.group(1))

        # 查找项目中哪些文件有同名方法定义（用于判断是否为自身方法调用）
        def_pattern = (
            r"\b(public|private|protected|static|abstract|final|synchronized|default)\b.*\b"
            + re.escape(search_name) + r"\s*\("
        )
        def_hits = rg_tool.search_keyword_with_line(project_path, def_pattern, use_regex=True)
        files_with_own_def: set[str] = set()
        for dh in def_hits:
            files_with_own_def.add(str(dh.file_path))

        # 多 receiver 场景：只保留包含目标类引用的调用
        # 多 receiver 场景：只保留包含目标类引用的调用
        if len(distinct_callers) > 1:
            filtered = []
            for m in call_site_matches:
                content = m.content
                has_target_ref = any(indicator in content for indicator in target_indicators)
                # 包含目标类引用 或 在目标类文件中 → 保留
                if has_target_ref or str(m.file_path).endswith(target_class_path):
                    filtered.append(m)
            call_site_matches = filtered
        else:
            # 单 receiver 场景：排除有自身同名方法定义的文件（除非调用行明确引用了目标类）
            filtered = []
            for m in call_site_matches:
                file_str = str(m.file_path)
                content = m.content
                # 调用行包含目标类引用 → 直接保留
                has_target_ref = any(indicator in content for indicator in target_indicators)
                if has_target_ref:
                    filtered.append(m)
                elif file_str in files_with_own_def and not file_str.endswith(target_class_path):
                    # 文件有自己的同名方法定义 且 不是目标类文件 → 跳过（可能是自身调用）
                    continue
                else:
                    filtered.append(m)
            call_site_matches = filtered

        if not call_site_matches:
            return []

    # ── 阶段 2.6: Python FQN 文件过滤 ──
    # Python 的 FQN 格式为 "module_name.ClassName.method"，
    # 用模块名（文件名去掉 .py）过滤，减少跨文件误报。
    if function_fqn and "." in function_fqn and language == "python":
        fqn_parts = function_fqn.split(".")
        module_name = fqn_parts[0]  # File name without .py
        target_filename = module_name + ".py"
        filtered = [m for m in call_site_matches
                    if str(m.file_path).endswith(target_filename)
                    or f"/{module_name}/" in str(m.file_path)]
        if filtered:  # Only apply if we still have results
            call_site_matches = filtered

    logger.info(
        "[realtime_get_reference_by_function] 阶段2(定义过滤): call_sites=%d, duration=%.1fms",
        len(call_site_matches), (time.perf_counter() - stage_start) * 1000,
    )

    # ── 按文件分组调用点，便于批量 AST 解析 ──
    limit = max_results if max_results > 0 else 0
    file_to_hits: dict[str, list[tuple[int, str]]] = {}
    for m in call_site_matches:
        file_key = str(m.file_path)
        file_to_hits.setdefault(file_key, []).append((m.line, m.content))

    # ══════════════════════════════════════════════════════════
    # 阶段 3: AST 定位每个调用点的包围函数（enclosing function）
    # ══════════════════════════════════════════════════════════
    stage_start = time.perf_counter()
    results: list[GetFunctionReferenceOutput] = []
    seen: set[tuple[str, int, int]] = set()  # (file, hit_line, enclosing_start) 去重
    skipped = 0  # offset 分页计数

    for file_path_str, hits in file_to_hits.items():
        if limit and len(results) >= limit:
            break

        abs_path = Path(file_path_str)
        if not abs_path.is_absolute():
            abs_path = (project_path / abs_path).resolve()

        # AST 提取文件中的所有函数定义
        try:
            funcs = client.extract_function_defs(language, abs_path, project_path)
        except Exception as e:
            logger.warning(f"Failed to extract functions from {abs_path}: {e}")
            continue

        # 如果文件中没有函数定义，仍然输出调用点（无 enclosing function）
        if not funcs:
            for hit_line, hit_content in sorted(hits, key=lambda x: x[0]):
                if limit and len(results) >= limit:
                    break

                key = (file_path_str, hit_line, 0)
                if key in seen:
                    continue
                seen.add(key)

                if skipped < offset:
                    skipped += 1
                    continue

                try:
                    rel_path = abs_path.relative_to(project_path)
                except ValueError:
                    rel_path = abs_path

                call_site = CallSite(
                    file_path=rel_path.as_posix(),
                    line=hit_line,
                    content=hit_content.strip(),
                )
                output = GetFunctionReferenceOutput(
                    call_site=call_site,
                    function_fqn="",
                    location=ServiceLocation(
                        file_path=rel_path,
                        start_line=hit_line,
                        start_column=0,
                        end_line=hit_line,
                        end_column=0,
                    ),
                    content=hit_content.strip(),
                )
                results.append(output)
            continue

        # 按行号排序函数列表，用于二分查找 enclosing function
        funcs_sorted = sorted(funcs, key=lambda fn: fn.location.start_line)
        start_lines = [fn.location.start_line for fn in funcs_sorted]

        for hit_line, hit_content in sorted(hits, key=lambda x: x[0]):
            if limit and len(results) >= limit:
                break

            # 查找包含 hit_line 的最外层函数（enclosing function）
            # 先精确查找(max_distance=0)，失败则模糊查找(max_distance=5)
            enclosing = find_nearest_function(funcs_sorted, start_lines, hit_line, max_distance=0, prefer_outermost=True)
            if enclosing is None:
                enclosing = find_nearest_function(funcs_sorted, start_lines, hit_line, max_distance=5, prefer_outermost=True)

            # 如果 enclosing function 就是目标函数自身的定义行，跳过（避免自引用）
            if enclosing and enclosing.name == name:
                if hit_line == enclosing.location.start_line:
                    continue

            # 去重 + 分页（offset 跳过）
            enclosing_start = enclosing.location.start_line if enclosing else 0
            key = (file_path_str, hit_line, enclosing_start)
            if key in seen:
                continue
            seen.add(key)

            if skipped < offset:
                skipped += 1
                continue

            try:
                rel_path = abs_path.relative_to(project_path)
            except ValueError:
                rel_path = abs_path

            call_site = CallSite(
                file_path=rel_path.as_posix(),
                line=hit_line,
                content=hit_content.strip(),
            )

            if enclosing:
                enc_path = enclosing.location.file_path
                if enc_path.is_absolute():
                    try:
                        enc_rel = enc_path.relative_to(project_path)
                    except ValueError:
                        enc_rel = enc_path
                else:
                    enc_rel = enc_path

                enc_location = ServiceLocation(
                    file_path=enc_rel,
                    start_line=enclosing.location.start_line,
                    start_column=enclosing.location.start_column,
                    end_line=enclosing.location.end_line,
                    end_column=enclosing.location.end_column,
                )

                enc_content = enclosing.content or file_util.get_file_content_by_location(
                    project_path, enc_location
                )

                output = GetFunctionReferenceOutput(
                    call_site=call_site,
                    function_fqn=enclosing.fqn,
                    location=enc_location,
                    content=enc_content,
                )
            else:
                output = GetFunctionReferenceOutput(
                    call_site=call_site,
                    function_fqn="",
                    location=ServiceLocation(
                        file_path=rel_path,
                        start_line=hit_line,
                        start_column=0,
                        end_line=hit_line,
                        end_column=0,
                    ),
                    content=hit_content.strip(),
                )

            results.append(output)

    logger.info(
        "[realtime_get_reference_by_function] 阶段3(AST函数定位): results=%d, duration=%.1fms",
        len(results), (time.perf_counter() - stage_start) * 1000,
    )
    logger.info("[realtime_get_reference_by_function] 返回结果数量: %d", len(results))
    return results


# ─── CHA (Class Hierarchy Analysis) ────────────────────────────────────────────
# CHA 类层次分析：用于 Java 多态调用的展开
# 当一个调用的目标是接口/抽象类方法时，CHA 会查找所有实现类中的具体方法，
# 将一个调用点展开为多个 Callee（每个实现类一个），从而提供更完整的调用图。


@dataclass
class _CHAContext:
    """CHA 专用缓存上下文。

    在同一次调用图分析中缓存：
      - subclass_cache: 父类名 → 直接子类列表（避免重复 ripgrep）
      - class_info_cache: 类名 → ClassInfo 列表（避免重复 AST 解析）
    """
    subclass_cache: dict[str, list[ClassInfo]] = field(default_factory=dict)
    class_info_cache: dict[str, list[ClassInfo]] = field(default_factory=dict)


def _find_subclasses_by_name(
    project_path: Path,
    parent_class_name: str,
    cha_ctx: _CHAContext,
) -> list[ClassInfo]:
    """查找指定类/接口的直接子类（一层）。

    实现方式：
      1. ripgrep 搜索 "(extends|implements).*parent_class_name" → 候选文件
      2. 对每个候选文件用 AST 精确提取子类信息
      3. 结果缓存到 cha_ctx.subclass_cache
    """
    if parent_class_name in cha_ctx.subclass_cache:
        return cha_ctx.subclass_cache[parent_class_name]

    rg_pattern = rf"(extends|implements)\s+.*\b{re.escape(parent_class_name)}\b"
    files = ripgrep_search_files(project_path, rg_pattern, "java", exclude_tests=False)

    client = get_ast_client()
    results: list[ClassInfo] = []
    for fp in files:
        subs = client.find_subclasses("java", fp, parent_class_name, project_path)
        results.extend(subs)

    cha_ctx.subclass_cache[parent_class_name] = results
    return results


def _find_all_subclasses(
    project_path: Path,
    parent_class_name: str,
    cha_ctx: _CHAContext,
    max_depth: int = 5,
) -> list[ClassInfo]:
    """BFS 递归展开完整继承树，收集所有子类（含间接子类）。

    展开策略：
      - 从 parent_class_name 开始，逐层查找直接子类
      - 如果子类本身也是 abstract/interface → 继续展开下一层
      - 如果子类是具体类 → 收集但不再展开
      - 最多展开 max_depth 层，防止循环引用死循环

    所有子类（包括抽象类）都会被收集，因为抽象类可能有具体方法实现。
    """
    queue = [parent_class_name]
    visited: set[str] = set()
    all_subs: list[ClassInfo] = []
    depth = 0

    while queue and depth < max_depth:
        next_queue: list[str] = []
        for name in queue:
            if name in visited:
                continue
            visited.add(name)
            subs = _find_subclasses_by_name(project_path, name, cha_ctx)
            for sub in subs:
                all_subs.append(sub)
                if sub.is_abstract or sub.is_interface:
                    next_queue.append(sub.name)
        queue = next_queue
        depth += 1

    return all_subs


def _get_class_info_by_name(
    project_path: Path,
    class_name: str,
    cha_ctx: _CHAContext,
) -> list[ClassInfo]:
    """按简单类名获取 ClassInfo（含 is_abstract / is_interface 元数据）。

    用于判断一个类是否为接口/抽象类，以决定是否需要 CHA 展开。
    结果缓存到 cha_ctx.class_info_cache。
    """
    if class_name in cha_ctx.class_info_cache:
        return cha_ctx.class_info_cache[class_name]

    rg_pattern = rf"\b(class|interface)\s+{re.escape(class_name)}\b"
    files = ripgrep_search_files(project_path, rg_pattern, "java", exclude_tests=False)

    client = get_ast_client()
    results: list[ClassInfo] = []
    for fp in files:
        infos = client.find_all_classes_by_name("java", fp, class_name, project_path)
        results.extend(infos)

    cha_ctx.class_info_cache[class_name] = results
    return results


def _find_method_in_class(
    project_path: Path,
    class_info: ClassInfo,
    method_name: str,
) -> FuncInfo | None:
    """在指定类中查找方法定义。

    查找策略：
      1. AST 提取该类文件中所有名为 method_name 的方法
      2. 优先返回 FQN 前缀匹配该类 FQN 的方法（精确匹配）
      3. 兜底返回第一个同名方法
    """
    client = get_ast_client()
    search = client.get_search("java")
    if search is None:
        return None

    funcs = search.find_functions_by_name(
        class_info.location.file_path, method_name, project_path,
    )
    fqn_prefix = class_info.fqn + "."
    for f in funcs:
        if f.fqn.startswith(fqn_prefix):
            return f
    return funcs[0] if funcs else None


def _extract_owner_class_name(func_info: FuncInfo) -> str:
    """从函数的 FQN 中提取所属类名。

    FQN 格式: "package.ClassName.methodName"
    提取 ClassName（倒数第二个部分）。

    示例: "main.Processor.process" → "Processor"
    """
    parts = func_info.fqn.rsplit(".", 2)
    if len(parts) >= 2:
        return parts[-2]
    return ""


def _resolve_callee_definition_cha(
    project_path: Path,
    language: str,
    callee_name: str,
    exclude_fqns: Set[str],
    caller_file: Path | None = None,
    call_line: int = 0,
    call_expr: str = "",
    cha_ctx: _CHAContext | None = None,
    receiver: str | None = None,
    arg_count: int = -1,
) -> list[FuncInfo]:
    """CHA 版 callee 定义解析：支持一个调用点返回多个 callee（多态展开）。

    流程：
      1. 先调用 _resolve_callee_definition() 获取 primary callee
      2. 检查是否需要 CHA 展开：
         - new Foo() → 不展开（构造函数是确定的）
         - ClassName.method() → 不展开（静态调用是确定的）
         - 普通调用 → 检查 primary 所属类是否为 interface/abstract
      3. 如果是接口/抽象类 → BFS 展开所有子类
      4. 在每个子类中查找同名方法 → 收集到结果列表

    Returns:
        list[FuncInfo] — 可能包含 0~N 个 callee
        （空列表 = 未找到定义，单元素 = 确定调用，多元素 = 多态展开）
    """
    # ── 步骤 1: 获取 primary callee（常规消歧）──
    primary = _resolve_callee_definition(
        project_path, language, callee_name, exclude_fqns,
        caller_file=caller_file, call_line=call_line,
        call_expr=call_expr,
        receiver=receiver, arg_count=arg_count,
    )
    if primary is None:
        return []

    # ── 步骤 2: 判断是否跳过 CHA 展开 ──
    # 构造函数调用（new Foo()）不做 CHA 展开
    if call_expr.strip().startswith("new "):
        return [primary]

    # 静态调用（ClassName.method()）不做 CHA 展开
    if receiver and receiver[0].isupper() and receiver not in ("this", "super"):
        return [primary]

    if cha_ctx is None:
        return [primary]

    # ── 步骤 3: 检查 primary 所属类是否为 interface/abstract ──
    owner_class = _extract_owner_class_name(primary)
    if not owner_class:
        return [primary]

    # 只有接口或抽象类才需要 CHA 展开
    class_infos = _get_class_info_by_name(project_path, owner_class, cha_ctx)
    if not any(ci.is_abstract or ci.is_interface for ci in class_infos):
        return [primary]

    # ── 步骤 4: BFS 展开所有子类，在每个子类中查找同名方法 ──
    all_subs = _find_all_subclasses(project_path, owner_class, cha_ctx)
    if not all_subs:
        return [primary]

    results = [primary]
    seen_fqns = {primary.fqn}
    for sub in all_subs:
        method = _find_method_in_class(project_path, sub, callee_name)
        if method and method.fqn not in seen_fqns and method.fqn not in exclude_fqns:
            results.append(method)
            seen_fqns.add(method.fqn)

    return results


def _expand_callees_cha(
    project_path: Path,
    language: str,
    func_info: FuncInfo,
    depth: int,
    max_callees_per_node: int,
    exclude_undefined: bool,
    detail_level: str,
    visited: Set[str],
    cha_ctx: _CHAContext | None = None,
) -> list[Callee]:
    """CHA 版 callee 递归展开：一个调用点可产生多个 Callee（多态展开）。

    与 _expand_callees 的区别：
      - 使用 _resolve_callee_definition_cha() 代替 _resolve_callee_definition()
      - 返回的 resolved_list 可能包含多个 FuncInfo（接口/抽象类方法的所有实现）
      - 去重 key 为 (callee_name, callee_fqn) 二元组（同一方法名不同实现类）

    流程与 _expand_callees 相同：提取调用 → 批量预取 → 逐个解析 → 递归展开
    """
    if depth <= 0:
        return []

    # ── 步骤 1: 提取调用表达式 ──
    file_path = func_info.location.file_path
    calls = _extract_call_expressions_from_func(file_path, func_info, language)

    # ── 步骤 2: 批量预取候选 ──
    ctx = _current_ctx.get()
    if ctx is not None and calls:
        unique_names = list(dict.fromkeys(name for name, _, _, _, _ in calls))
        if max_callees_per_node > 0:
            unique_names = unique_names[:max_callees_per_node]
        _prefetch_candidates_batch(project_path, language, unique_names)

    # ── 步骤 3: 逐个 CHA 解析 + 递归展开 ──
    callees: list[Callee] = []
    seen_callees: set[tuple[str, str]] = set()  # (callee_name, callee_fqn) 去重

    for callee_name, call_line, call_text, receiver, arg_count in calls:
        if max_callees_per_node > 0 and len(callees) >= max_callees_per_node:
            break

        # CHA 解析：可能返回多个 callee（接口/抽象类的所有实现）
        resolved_list = _resolve_callee_definition_cha(
            project_path, language, callee_name, visited,
            caller_file=file_path, call_line=call_line,
            call_expr=call_text, cha_ctx=cha_ctx,
            receiver=receiver, arg_count=arg_count,
        )

        # 未找到任何定义 → 根据 exclude_undefined 决定是否保留占位
        if not resolved_list:
            if (callee_name, callee_name) in seen_callees:
                continue
            seen_callees.add((callee_name, callee_name))
            if exclude_undefined:
                continue
            callees.append(
                Callee(
                    call_site=CallSite(
                        file_path=_rel_path(file_path, project_path).as_posix(),
                        line=call_line,
                        content=call_text.strip(),
                    ),
                    function_fqn=callee_name,
                    function_signature="",
                    location=ServiceLocation.default(),
                    content="",
                    has_cycle=False,
                    callees=[],
                )
            )
            continue

        call_site = CallSite(
            file_path=_rel_path(file_path, project_path).as_posix(),
            line=call_line,
            content=call_text.strip(),
        )

        for callee_func in resolved_list:
            dedup_key = (callee_name, callee_func.fqn)
            if dedup_key in seen_callees:
                continue
            seen_callees.add(dedup_key)

            if max_callees_per_node > 0 and len(callees) >= max_callees_per_node:
                break

            has_cycle = callee_func.fqn in visited

            content = ""
            if detail_level == "full":
                content = callee_func.content

            sub_callees: list[Callee] = []
            if not has_cycle and depth > 1:
                visited.add(callee_func.fqn)
                sub_callees = _expand_callees_cha(
                    project_path=project_path,
                    language=language,
                    func_info=callee_func,
                    depth=depth - 1,
                    max_callees_per_node=max_callees_per_node,
                    exclude_undefined=exclude_undefined,
                    detail_level=detail_level,
                    visited=visited,
                    cha_ctx=cha_ctx,
                )

            callees.append(
                Callee(
                    call_site=call_site,
                    function_fqn=callee_func.fqn,
                    function_signature=callee_func.signature,
                    location=ServiceLocation(
                        file_path=_rel_path(callee_func.location.file_path, project_path),
                        start_line=callee_func.location.start_line,
                        start_column=callee_func.location.start_column,
                        end_line=callee_func.location.end_line,
                        end_column=callee_func.location.end_column,
                    ),
                    content=content,
                    has_cycle=has_cycle,
                    callees=sub_callees,
                )
            )

    return callees


@timed(logger, "realtime_analysis", "realtime_get_call_graph_cha")
def realtime_get_call_graph_cha(
    project_path: Path,
    language: str,
    name: str,
    function_fqn: str = "",
    function_signature: str = "",
    file_path: str = "",
    line: int = 0,
    depth: int = 3,
    use_regex: bool = False,
    detail_level: str = "summary",
    max_callees_per_node: int = 3,
    exclude_undefined_function_call: bool = True,
) -> list[GetCallGraphOutput]:
    """CHA 版实时调用图分析顶层接口：支持 Java 多态调用展开。

    与 realtime_get_call_graph 的区别：
      - 使用 _expand_callees_cha() 代替 _expand_callees()
      - 接口/抽象类的方法调用会展开为所有实现类的具体方法
      - 额外维护 _CHAContext（subclass_cache + class_info_cache）

    非 Java 语言自动 fallback 到 realtime_get_call_graph（不做 CHA）。

    两阶段流程（同 realtime_get_call_graph）：
      阶段 1 — 定位目标函数
      阶段 2 — CHA 版递归展开调用图
    """
    # 非 Java 语言 → 直接 fallback 到基础版（无 CHA 展开）
    if language != "java":
        return realtime_get_call_graph(
            project_path=project_path,
            language=language,
            name=name,
            function_fqn=function_fqn,
            function_signature=function_signature,
            file_path=file_path,
            line=line,
            depth=depth,
            use_regex=use_regex,
            detail_level=detail_level,
            max_callees_per_node=max_callees_per_node,
            exclude_undefined_function_call=exclude_undefined_function_call,
        )

    # ── 阶段 1: 定位目标函数 ──
    stage_start = time.perf_counter()
    target_func = _locate_target_function(
        project_path, language, name, function_fqn, file_path, line,
    )
    if target_func is None:
        return []
    logger.info(
        "[realtime_get_call_graph_cha] 阶段1(定位目标函数): found=%s, duration=%.1fms",
        target_func.fqn, (time.perf_counter() - stage_start) * 1000,
    )

    # ── 构建 Caller 信息 ──
    caller = Caller(
        function_fqn=target_func.fqn,
        function_signature=target_func.signature,
        file_path=_rel_path(target_func.location.file_path, project_path).as_posix(),
        line=target_func.location.start_line,
    )

    # ── 阶段 2: CHA 版递归展开调用图 ──
    stage_start = time.perf_counter()
    visited: Set[str] = {target_func.fqn}
    ctx = _CallGraphContext()   # 常规缓存上下文
    cha_ctx = _CHAContext()     # CHA 专用缓存（子类 + 类信息）
    token = _current_ctx.set(ctx)
    try:
        callees = _expand_callees_cha(
            project_path=project_path,
            language=language,
            func_info=target_func,
            depth=depth,
            max_callees_per_node=max_callees_per_node,
            exclude_undefined=exclude_undefined_function_call,
            detail_level=detail_level,
            visited=visited,
            cha_ctx=cha_ctx,
        )
    finally:
        _current_ctx.reset(token)
    logger.info(
        "[realtime_get_call_graph_cha] 阶段2(CHA展开调用图): callees=%d, duration=%.1fms, "
        "L1_cache=%d, L3_cache=%d, subclass_cache=%d, class_info_cache=%d",
        len(callees), (time.perf_counter() - stage_start) * 1000,
        len(ctx.name_candidates_cache),
        len(ctx.java_imports_cache),
        len(cha_ctx.subclass_cache),
        len(cha_ctx.class_info_cache),
    )

    output = GetCallGraphOutput(caller=caller, callees=callees)
    logger.info("[realtime_get_call_graph_cha] 返回结果数量: 1")
    logger.info("[realtime_get_call_graph_cha] parse_cache: %s", parse_cache_info())
    return [output]

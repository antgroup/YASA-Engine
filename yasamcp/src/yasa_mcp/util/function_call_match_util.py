"""函数调用表达式的跨行正则构造工具。

将用户输入的函数调用字符串（如 `a.b.func(arg1, arg2)`）转换为
支持源码中跨行书写的 ripgrep 正则表达式。
"""

import re
from typing import Any

from yasa_mcp.util.params_validator_util import ParamsValidator


ANONYMOUS_FUNC_RE = re.compile(r"<anonymousFunc_[^>]+>")


def build_multiline_call_pattern(call_expr: str) -> str:
    """将完整函数调用表达式转换为支持跨行匹配的正则。

    处理规则（按顺序）：
      1. ``re.escape`` 转义特殊字符
      2. 连续转义空白 → ``\\s+``
      3. ``\\.`` 两侧插入 ``\\s*``（方法链跨行）
      4. ``\\(`` 前插入 ``\\s*``（方法名与括号间换行）
      5. ``,`` 后插入 ``\\s+``（参数间换行）

    示例::

        >>> build_multiline_call_pattern("a.b(x, y)")
        'a\\\\s*\\\\.\\\\s*b\\\\s*\\\\(\\\\s*x\\\\s*,\\\\s+y\\\\s*\\\\)'

    Args:
        call_expr: 用户输入的函数调用字符串。

    Returns:
        ripgrep 兼容的正则表达式字符串。
    """
    if not call_expr or not call_expr.strip():
        return ""

    escaped = re.escape(call_expr.strip())

    # 可选转义空白+逗号+可选转义空白 → \s*,\s+（参数间换行）— 必须在通用空白替换之前
    escaped = re.sub(r"(\\ )*,(\\ )*", r"\\s*,\\s+", escaped)

    # 连续转义空白 → \s+
    escaped = re.sub(r"(\\ )+", r"\\s+", escaped)

    # \. 两侧插入 \s*（方法链跨行）
    escaped = escaped.replace(r"\.", r"\s*\.\s*")

    # \( 前插入 \s*，( 后插入 \s*
    escaped = escaped.replace(r"\(", r"\s*\(\s*")

    # \) 前插入 \s*
    escaped = escaped.replace(r"\)", r"\s*\)")

    return escaped


def extract_call_name(function_call: str) -> str:
    """Extract invoked member name from a call expression."""
    if not function_call:
        return ""
    before_paren = function_call.split("(", 1)[0].strip()
    if not before_paren:
        return ""
    return before_paren.split(".")[-1].strip()


def display_function_def_for_call(function_def: Any, function_call: str) -> tuple[str, str]:
    """Replace anonymous callee display names with the query call name when possible."""
    fqn = function_def.function_fqn
    signature = function_def.function_signature
    if not ANONYMOUS_FUNC_RE.search(fqn) and not ANONYMOUS_FUNC_RE.search(signature):
        return fqn, signature

    call_name = extract_call_name(function_call)
    if not call_name:
        return fqn, signature

    display_fqn = ANONYMOUS_FUNC_RE.sub(call_name, fqn).lstrip("/").replace("/", ".")
    display_signature = ANONYMOUS_FUNC_RE.sub(call_name, signature)
    if display_signature == signature or not display_signature.strip():
        display_signature = f"{call_name}()"
    return display_fqn, display_signature


def callsite_content_matches(function_call: str, callsite_content: str) -> bool:
    """Return true when callsite content matches the query call expression."""
    if not function_call:
        return True
    compact_query = "".join(function_call.split())
    compact_content = "".join(callsite_content.split())
    if compact_query and compact_query in compact_content:
        return True
    return ParamsValidator._validate_string(function_call, callsite_content, True)  # noqa: SLF001


def build_multiline_prefix_pattern(call_expr: str) -> str:
    """提取函数调用前缀并构造支持跨行的正则。

    提取 ``(`` 前的部分作为前缀，再对其中的 ``.`` 插入 ``\\s*``
    以支持方法链跨行，并在末尾追加 ``\\s*\\(`` 匹配左括号。

    规则：
      - 有 ``.`` 的调用（``a.b.f(...)``）→ ``a\\s*\\.\\s*b\\s*\\.\\s*f\\s*\\(``
      - 无 ``.`` 的调用（``f(...)``）→ ``\\bf\\s*\\(``

    Args:
        call_expr: 用户输入的函数调用字符串。

    Returns:
        ripgrep 兼容的正则表达式字符串；无法解析时返回空字符串。
    """
    if not call_expr or not call_expr.strip():
        return ""

    call_expr = call_expr.strip()
    paren_idx = call_expr.find("(")
    if paren_idx <= 0:
        # 没有括号，整个字符串作为前缀
        prefix = call_expr
    else:
        prefix = call_expr[:paren_idx].strip()

    if not prefix:
        return ""

    escaped_prefix = re.escape(prefix)

    if "." in prefix:
        # 有 . 的前缀：在 \. 两侧插入 \s*
        pattern = escaped_prefix.replace(r"\.", r"\s*\.\s*")
        return pattern + r"\s*\("
    else:
        # 无 . 的前缀：用 \b 词边界
        return r"\b" + escaped_prefix + r"\s*\("

"""ToolResult → 人类可读文本 / JSON 输出格式化。

采用策略模式:
- ``ResultFormatter`` 是上下文,根据 ``json_output`` 选择顶层策略。
- ``JsonFormatStrategy`` / ``TextFormatStrategy`` 实现 ``FormatStrategy`` 接口。
- 文本策略内部再用 ``BaseRenderer`` 做类型级分派:
  每种结果类型对应一个 ``BaseRenderer`` 子类,通过注册表查找。
着色用 ``click.style``，非 TTY 时由 ``click.echo(color=...)`` 自动降级。
对外便捷入口 :func:`format_result` / :func:`print_result`。
"""

from __future__ import annotations

import json
import sys
from typing import Any, Protocol

import click
from pydantic import BaseModel

from yasa_mcp.service.models import (
    GetCallGraphOutput,
    GetClassDefOutput,
    GetFileContentByKeywordOutput,
    GetFunctionDefByFunctionCallOutput,
    GetFunctionDefOutput,
    GetFunctionReferenceOutput,
    QuerySymbolResult,
    RouterDef,
    YasaMcpResults,
)


# ── click.style 着色快捷方式 ───────────────────────────────────────────────


class Color:
    """基于 ``click.style`` 的着色快捷方式。

    只在 stdout 是 TTY 时输出颜色码,管道/重定向自动降级为纯文本。
    """

    _enabled: bool = sys.stdout.isatty()

    @classmethod
    def wrap(cls, text: str, **style: Any) -> str:
        if not cls._enabled or not style:
            return text
        return click.style(text, **style)

    @classmethod
    def kind(cls, text: str) -> str:
        """符号类型列:绿色,固定 12 字符宽。"""
        return cls.wrap(f"{text:<12}", fg="green")

    @classmethod
    def name(cls, text: str) -> str:
        """符号名:加粗白色。"""
        return cls.wrap(text, fg="white", bold=True)

    @classmethod
    def location(cls, text: str) -> str:
        """位置行:加粗黄色。"""
        return cls.wrap(text, fg="yellow", bold=True)

    @classmethod
    def detail(cls, text: str) -> str:
        """签名/预览等详情:灰色(dim)。"""
        return cls.wrap(text, dim=True)

    @classmethod
    def header(cls, text: str) -> str:
        """标题行:加粗。"""
        return cls.wrap(text, bold=True)

    @classmethod
    def warn(cls, text: str) -> str:
        """警告:黄色。"""
        return cls.wrap(text, fg="yellow")


# ── 共享工具 ───────────────────────────────────────────────────────────────


class ResultFormatUtils:
    """格式化过程中复用的静态工具方法。"""

    @staticmethod
    def extract(result: Any) -> Any:
        """从各种返回封装(BaseModel / FastMCP ToolResult / dict)中取出数据。"""
        if isinstance(result, BaseModel):
            return result.model_dump(mode="json")
        for attr in ("structured_content", "data"):
            value = getattr(result, attr, None)
            if value is not None:
                return value
        content = getattr(result, "content", None)
        if isinstance(content, list):
            texts = [getattr(b, "text", "") for b in content if getattr(b, "text", None)]
            if texts:
                joined = "\n".join(texts)
                try:
                    return json.loads(joined)
                except (json.JSONDecodeError, TypeError):
                    return joined
        if isinstance(result, dict):
            return result
        return None

    @staticmethod
    def unwrap(result: Any) -> YasaMcpResults | None:
        """从返回值中取出 ``YasaMcpResults``;无法识别时返回 None。"""
        if isinstance(result, YasaMcpResults):
            return result
        data = ResultFormatUtils.extract(result)
        if isinstance(data, dict) and "results" in data:
            try:
                return YasaMcpResults.model_validate(data)
            except Exception:
                return None
        return None

    @staticmethod
    def loc(file_path: str, line: int, col: int = 0) -> str:
        """``file:line:col`` 完整位置行(带缩进),加粗显示。"""
        if line and col:
            text = f"  {file_path}:{line}:{col}"
        elif line:
            text = f"  {file_path}:{line}"
        else:
            text = f"  {file_path}"
        return Color.location(text)

    @staticmethod
    def preview(content: str, width: int = 120) -> str:
        """取内容首行预览,截断到 width。"""
        return content.strip().split("\n")[0][:width] if content else ""

    @staticmethod
    def preview_line(content: str, width: int = 120) -> str:
        """预览行,灰色显示。"""
        text = ResultFormatUtils.preview(content, width)
        return Color.detail(f"  {text}") if text else ""

    @staticmethod
    def location(loc_obj: Any, file_path: str | None = None) -> str:
        """完整位置行 ``file:start_line:start_col-end_line:end_col``。

        开始行与结束行恒显示(即便两者相同也呈现),带缩进、加粗着色。
        """
        fp = file_path or str(getattr(loc_obj, "file_path", ""))
        sl = int(getattr(loc_obj, "start_line", 0) or 0)
        sc = int(getattr(loc_obj, "start_column", 0) or 0)
        el = int(getattr(loc_obj, "end_line", 0) or 0)
        ec = int(getattr(loc_obj, "end_column", 0) or 0)
        return Color.location(f"  {fp}:{sl}:{sc}-{el}:{ec}")

    @staticmethod
    def content_block(content: Any, indent: str = "  ") -> list[str]:
        """把 content 按行缩进渲染(灰色),保留完整内容不截断。"""
        if not content:
            return []
        return [Color.detail(f"{indent}{ln}") for ln in str(content).split("\n")]


# ── 顶层策略接口 ───────────────────────────────────────────────────────────


class FormatStrategy(Protocol):
    """顶层格式化策略接口:JSON 或文本。"""

    def format(self, result: Any) -> str: ...


# ── JSON 策略 ──────────────────────────────────────────────────────────────


class JsonFormatStrategy:
    """JSON 输出策略。"""

    def format(self, result: Any) -> str:
        data = ResultFormatUtils.extract(result)
        if data is None:
            data = str(result)
        try:
            return json.dumps(data, ensure_ascii=False, indent=2, default=str)
        except (TypeError, ValueError):
            return json.dumps(str(data), ensure_ascii=False, indent=2)


# ── 文本渲染器抽象基类 ─────────────────────────────────────────────────────


class BaseRenderer:
    """渲染器抽象基类:统一把一条结果转成文本行列表。"""

    def render(self, item: Any) -> list[str]:
        raise NotImplementedError


class SearchSymbolRenderer(BaseRenderer):
    """``QuerySymbolResult`` 渲染器。"""

    def render(self, item: QuerySymbolResult) -> list[str]:
        out = [f"{Color.kind(item.kind)}{Color.name(item.name)}"]
        if item.location:
            out.append(ResultFormatUtils.location(item.location))
        out.extend(ResultFormatUtils.content_block(item.content))
        out.append("")
        return out


class ClassDefRenderer(BaseRenderer):
    """``GetClassDefOutput`` 渲染器。"""

    def render(self, item: GetClassDefOutput) -> list[str]:
        out = [f"{Color.kind('class')}{Color.name(item.class_fqn)}"]
        if item.location:
            out.append(ResultFormatUtils.location(item.location))
        out.extend(ResultFormatUtils.content_block(item.content))
        for m in item.methods:
            out.append(Color.detail(f"  - {m.name}  {m.function_signature}  (line {m.line})"))
        out.append("")
        return out


class FunctionDefRenderer(BaseRenderer):
    """``GetFunctionDefOutput`` 渲染器。"""

    def render(self, item: GetFunctionDefOutput) -> list[str]:
        out = [f"{Color.kind('function')}{Color.name(item.function_fqn)}"]
        if item.location:
            out.append(ResultFormatUtils.location(item.location))
        if item.function_signature:
            out.append(Color.detail(f"  {item.function_signature}"))
        out.extend(ResultFormatUtils.content_block(item.content))
        out.append("")
        return out


class KeywordRenderer(BaseRenderer):
    """``GetFileContentByKeywordOutput`` 渲染器。"""

    def render(self, item: GetFileContentByKeywordOutput) -> list[str]:
        out = [f"{Color.kind('file')}{Color.name(item.file_path)}"]
        for m in item.matches:
            if m.line is not None:
                start = end = int(m.line)
                out.append(Color.location(f"  {item.file_path}:{start}-{end}"))
            out.extend(ResultFormatUtils.content_block(m.content, indent="    "))
        out.append("")
        return out


class ApiRenderer(BaseRenderer):
    """``RouterDef`` 渲染器。"""

    def render(self, item: RouterDef) -> list[str]:
        out = [f"{Color.kind('api')}{Color.name(item.api_name or item.full_name)}"]
        if item.location:
            out.append(ResultFormatUtils.location(item.location, item.filepath))
        if item.signature:
            out.append(Color.detail(f"  {item.signature}"))
        out.extend(ResultFormatUtils.content_block(item.content))
        out.append("")
        return out


class ReferenceRenderer(BaseRenderer):
    """``GetFunctionReferenceOutput`` 渲染器。"""

    def render(self, item: GetFunctionReferenceOutput) -> list[str]:
        out = [f"{Color.kind('reference')}{Color.name(item.function_fqn)}"]
        out.append(ResultFormatUtils.location(item.location))
        out.extend(ResultFormatUtils.content_block(item.content))
        # 调用点:谁在哪里调用了它
        cs = item.call_site
        out.append(Color.location(f"  <- {cs.file_path}:{cs.line}-{cs.line}"))
        out.extend(ResultFormatUtils.content_block(cs.content, indent="    "))
        out.append("")
        return out


class CalleeRenderer(BaseRenderer):
    """``GetFunctionDefByFunctionCallOutput`` 渲染器。"""

    def render(self, item: GetFunctionDefByFunctionCallOutput) -> list[str]:
        label = "callee(local)" if item.callType == "local" else "callee(remote)"
        out = [f"{Color.kind(label)}{Color.name(item.function_fqn)}"]
        out.append(ResultFormatUtils.location(item.location))
        if item.function_signature:
            out.append(Color.detail(f"  {item.function_signature}"))
        out.extend(ResultFormatUtils.content_block(item.content))
        out.append("")
        return out


class CallGraphRenderer(BaseRenderer):
    """``GetCallGraphOutput`` 渲染器,含调用树递归展开。

    结构上显式区分 ``caller``(根函数)与 ``callees``(被调用树),
    两段之间用分组标题分隔,避免混在一起。
    """

    def render(self, item: GetCallGraphOutput) -> list[str]:
        caller = item.caller
        out = ["", Color.header("caller")]
        out.append(f"  {Color.name(caller.function_fqn)}")
        out.append(Color.location(f"  {caller.file_path}:{caller.line}-{caller.line}"))
        if getattr(caller, "function_signature", ""):
            out.append(Color.detail(f"  {caller.function_signature}"))

        n = len(item.callees)
        out.append("")
        out.append(Color.header(f"callees ({n})"))
        if not item.callees:
            out.append(Color.detail("  (无被调用函数)"))
        for callee in item.callees:
            self.render_tree(callee, out, indent=1)
        out.append("")
        return out

    @staticmethod
    def render_tree(callee: Any, out: list[str], indent: int) -> None:
        prefix = "  " * indent
        # 节点名:→ 标记 + fqn
        out.append(f"{prefix}{Color.detail('→ ')}{Color.name(callee.function_fqn)}")
        # 完整位置 开始行:列-结束行:列
        loc = getattr(callee, "location", None)
        if loc:
            sl = int(getattr(loc, "start_line", 0) or 0)
            sc = int(getattr(loc, "start_column", 0) or 0)
            el = int(getattr(loc, "end_line", 0) or 0)
            ec = int(getattr(loc, "end_column", 0) or 0)
            out.append(f"{prefix}  {Color.location(f'{loc.file_path}:{sl}:{sc}-{el}:{ec}')}")
        # 签名
        if getattr(callee, "function_signature", ""):
            out.append(f"{prefix}  {Color.detail(callee.function_signature)}")
        # 完整函数体
        out.extend(ResultFormatUtils.content_block(getattr(callee, "content", ""), indent=f"{prefix}  "))
        if getattr(callee, "has_cycle", False):
            out.append(f"{prefix}  {Color.warn('(cycle detected)')}")
        # 递归展开下一层被调用(更深层缩进)
        for sub in getattr(callee, "callees", []) or []:
            CallGraphRenderer.render_tree(sub, out, indent + 1)


# ── 文本策略 ───────────────────────────────────────────────────────────────


class TextFormatStrategy:
    """人类可读文本输出策略。

    各结果类型对应一个 ``BaseRenderer`` 实例,通过注册表分派。
    新增类型只需继承 ``BaseRenderer`` 并在 ``RENDERERS`` 注册即可。
    """

    RENDERERS: dict[type, BaseRenderer] = {
        QuerySymbolResult: SearchSymbolRenderer(),
        GetClassDefOutput: ClassDefRenderer(),
        GetFunctionDefOutput: FunctionDefRenderer(),
        GetFileContentByKeywordOutput: KeywordRenderer(),
        RouterDef: ApiRenderer(),
        GetFunctionReferenceOutput: ReferenceRenderer(),
        GetFunctionDefByFunctionCallOutput: CalleeRenderer(),
        GetCallGraphOutput: CallGraphRenderer(),
    }

    fallback: FormatStrategy = JsonFormatStrategy()

    def format(self, result: Any) -> str:
        """渲染为带颜色码的纯文本(非 TTY 时为纯文本)。"""
        unwrapped = ResultFormatUtils.unwrap(result)
        if unwrapped is None:
            return self.fallback.format(result)

        items: list[Any] = unwrapped.results
        if not items:
            return "No results found."

        renderer = self.RENDERERS.get(type(items[0]))
        if renderer is None:
            return self.fallback.format(result)

        lines = [Color.header(f"\nSearch Results ({len(items)} found):\n")]
        for item in items:
            lines.extend(renderer.render(item))
        if unwrapped.truncated:
            lines.append(Color.detail(f"\n(results truncated, total={unwrapped.total_count})"))
        return "\n".join(lines)


# ── 上下文(对外入口) ──────────────────────────────────────────────────────


class ResultFormatter:
    """格式化上下文:根据 ``json_output`` 选择顶层策略。"""

    def __init__(self) -> None:
        self.json_strategy: FormatStrategy = JsonFormatStrategy()
        self.text_strategy: TextFormatStrategy = TextFormatStrategy()

    def format(self, result: Any, json_output: bool = False) -> str:
        strategy = self.json_strategy if json_output else self.text_strategy
        return strategy.format(result)


_formatter = ResultFormatter()


def format_result(result: Any, json_output: bool = False) -> str:
    """便捷函数:格式化工具返回值为字符串。"""
    return _formatter.format(result, json_output=json_output)


def print_result(result: Any, json_output: bool = False) -> None:
    """便捷函数:格式化并打印到 stdout。

    TTY 时 ```print`` 输出颜色码;非 TTY 时 :class:`Color` 自动禁用颜色,
    输出纯文本。
    """
    print(format_result(result, json_output))

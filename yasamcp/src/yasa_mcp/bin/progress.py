"""CLI init 进度渲染器。

✓/duration 行用 click.style 精确控制 ANSI 颜色（避免 rich markup 泄漏）；
"引擎并行分析中..." 用 rich Status spinner 原地转圈，纯文本无颜色冲突。
on_done 打印 ✓ 行前先 stop spinner，打印完再 restart，彻底隔离两种输出。
"""

from __future__ import annotations

import sys
import time

import click
from rich.console import Console
from rich.status import Status

from yasa_mcp.core.enums import Tool


class InitProgressPrinter:
    """init 进度渲染器。

    输出布局：
        ┌  Initializing yasamcp
        │
        ◆  Checking binary...
        │
        ◆  Checking cache...
        │
        ◆  Building analysis...
        │  ✓ yasa_scan  duration: 8.9s
        │  ✓ codegraph  duration: 23.4s
        │  ✓ yasa  duration: 47.6s
        │
        ●  Done (48.5s)
        └
    """

    _STAGE_LABELS = {
        "checking_binary": "Checking binary",
        "checking_cache": "Checking cache",
        "building_analysis": "Building analysis",
        "done": "Done",
    }
    _DEFAULT_TOTAL_BUILDERS = 3

    def __init__(self, *, enabled: bool | None = None, total_builders: int | None = None) -> None:
        force_terminal = None if enabled is None else bool(enabled)
        self.console = Console(
            file=sys.stdout,
            force_terminal=force_terminal,
            force_interactive=force_terminal,
        )
        self.total_builders = total_builders or self._DEFAULT_TOTAL_BUILDERS
        self._t0 = time.perf_counter()
        self._completed_builders = 0
        self._status: Status | None = None

    def _emit(self, text: str) -> None:
        click.echo(text)

    def _bar(self, content: str) -> str:
        return click.style("│  ", fg="cyan", bold=True) + content

    def _start_spinner(self, text: str) -> None:
        self._stop_spinner()
        self._status = Status(
            text,
            console=self.console,
            spinner="dots",
            spinner_style="cyan",
        )
        self._status.start()

    def _stop_spinner(self) -> None:
        if self._status is not None:
            self._status.stop()
            self._status = None

    def start(self) -> None:
        self._emit(click.style("┌  Initializing yasamcp", fg="cyan", bold=True))
        self._emit(click.style("│", fg="cyan", bold=True))
        self._start_spinner("加载分析引擎...")

    def on_stage(self, stage: str) -> None:
        label = self._STAGE_LABELS.get(stage, stage)
        if stage == "building_analysis":
            self._stop_spinner()
            self._completed_builders = 0
            self._emit(click.style("│", fg="cyan", bold=True))
            self._emit(click.style("◆  ", fg="cyan") + label + "...")
            self._start_spinner(f"引擎并行分析中...  0/{self.total_builders}")
        elif stage == "done":
            self._stop_spinner()
            self._emit(click.style("│", fg="cyan", bold=True))
            total_s = time.perf_counter() - self._t0
            if total_s >= 60:
                m, sec = divmod(total_s, 60)
                elapsed_str = f"{int(m)}m {sec:.1f}s"
            else:
                elapsed_str = f"{total_s:.1f}s"
            self._emit(click.style("●  ", fg="cyan", bold=True) + f"Done ({elapsed_str})")
            self._emit(click.style("└", fg="cyan", bold=True))
        else:
            self._stop_spinner()
            self._emit(click.style("◆  ", fg="cyan") + label + "...")
            self._emit(click.style("│", fg="cyan", bold=True))
            self._start_spinner("加载分析引擎...")

    def on_done(self, tool: Tool, ok: bool, elapsed_ms: float) -> None:
        self._completed_builders += 1
        check = click.style("✓", fg="green" if ok else "red", bold=True)
        name = click.style(tool.value, bold=True)
        parts = [check, name]
        if elapsed_ms and elapsed_ms > 0:
            parts.append(click.style(f"duration: {elapsed_ms / 1000:.1f}s", fg="white"))
        if not ok:
            parts.append(click.style("(failed)", fg="red"))
        self._stop_spinner()
        self._emit(self._bar("  ".join(parts)))
        self._start_spinner(
            f"引擎并行分析中...  {self._completed_builders}/{self.total_builders}"
        )

    def stop(self) -> None:
        self._stop_spinner()

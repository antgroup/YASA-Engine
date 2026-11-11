"""工具调用耗时收集与报告生成（供 CLI / MCP 测试共享）。"""

from __future__ import annotations

import statistics
import sys
from datetime import date
from pathlib import Path


class LatencyCollector:
    """收集工具调用耗时并在 session 结束时生成报告。"""

    def __init__(self, channel: str = "cli") -> None:
        self.channel = channel
        self.records: list[dict] = []

    def record(self, tool: str, case: str, ms: float, ok: bool, app: str = "", lang: str = "") -> None:
        self.records.append({"tool": tool, "case": case, "ms": ms, "ok": ok, "app": app, "lang": lang})

    def percentile(self, values: list[float], p: float) -> float:
        if not values:
            return 0.0
        s = sorted(values)
        k = (len(s) - 1) * p
        f = int(k)
        c = min(f + 1, len(s) - 1)
        return s[f] if f == c else s[f] + (s[c] - s[f]) * (k - f)

    def stats_line(self, name: str, vals: list[float]) -> str:
        return (
            f"  {name:<32s} n={len(vals)} avg={statistics.mean(vals):.0f}ms "
            f"min={min(vals):.0f}ms p50={self.percentile(vals, 0.5):.0f}ms "
            f"p90={self.percentile(vals, 0.9):.0f}ms max={max(vals):.0f}ms"
        )

    def build_report(self) -> list[str]:
        if not self.records:
            return []
        by_tool: dict[str, list[float]] = {}
        by_tool_app: dict[str, list[float]] = {}
        for r in self.records:
            by_tool.setdefault(r["tool"], []).append(r["ms"])
            key = f"{r['tool']}|{r['lang']}/{r['app']}"
            by_tool_app.setdefault(key, []).append(r["ms"])
        lines = [
            "",
            "=" * 90,
            f"{self.channel.upper()} 集成测试耗时报告（全仓库 × 全工具）",
            "=" * 90,
        ]
        total_ms = sum(r["ms"] for r in self.records)
        total_ok = sum(1 for r in self.records if r["ok"])
        lines.append(f"总用例: {len(self.records)}  通过: {total_ok}  总耗时: {total_ms:.0f}ms")
        lines.append("")
        lines.append("■ 按工具汇总（跨所有仓库）")
        lines.append("-" * 90)
        for tool in sorted(by_tool):
            lines.append(self.stats_line(tool, by_tool[tool]))
        lines.append("-" * 90)
        lines.append(self.stats_line("总体", [r["ms"] for r in self.records]))
        lines.append("")
        lines.append("■ 按工具 × 仓库明细")
        lines.append("-" * 90)
        for key in sorted(by_tool_app):
            vals = by_tool_app[key]
            tool, app = key.split("|", 1)
            lines.append(self.stats_line(f"{tool} [{app}]", vals))
        lines.append("=" * 90)
        return lines

    def write_report(self) -> None:
        lines = self.build_report()
        if not lines:
            return
        sys.stderr.write("\n".join(lines) + "\n")
        sys.stderr.flush()
        report_dir = Path(__file__).resolve().parent / "reports"
        report_dir.mkdir(parents=True, exist_ok=True)
        report_file = report_dir / f"latency_{self.channel}_{date.today().isoformat()}.txt"
        report_file.write_text("\n".join(lines) + "\n", encoding="utf-8")


# 模块级单例（CLI 和 MCP 各自创建自己的实例）
cli_collector = LatencyCollector("cli")
mcp_collector = LatencyCollector("mcp")

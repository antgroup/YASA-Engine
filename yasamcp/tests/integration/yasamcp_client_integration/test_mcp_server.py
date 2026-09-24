"""MCP server 端到端集成测试（脚本运行）。

测试流程:
1. 启动 yasamcp server (stdio)
2. 逐项目首次调用工具自动 fastload 上下文
3. 执行所有工具用例，对比 expected
4. 统计耗时（首次加载 vs 热请求）
5. 结束关闭 server，生成耗时报告

用法:
    YASAMCP_BINARY=dist/yasamcp/yasamcp \
    YASA_BIN_DIR=~/.yasamcp/darwin-aarch64 \
    python tests/integration/yasamcp_client_integration/test_mcp_server.py
"""

from __future__ import annotations

import asyncio
import collections
import json
import sys
import time
from pathlib import Path


def normalize_json(x) -> str:
    """对 JSON 可序列化结构排序后序列化，用于精确比较。"""
    return json.dumps(x, ensure_ascii=False, sort_keys=True, default=str)


async def run_tests():
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client

    from tests.integration.yasamcp_client_integration.cli_args import TOOL_MAP, McpArgBuilder
    from tests.integration.yasamcp_client_integration.config import IntegrationConfig
    from tests.integration.yasamcp_client_integration.latency import LatencyCollector

    # 脚本独立运行不走 pytest conftest，手动准备 xast dataset
    try:
        from tests.integration.yasamcp_client_integration import prepare_dataset
        prepare_dataset.ensure_datasets()
    except Exception as e:  # noqa: BLE001
        print(f"WARN: xast dataset 自动准备失败: {e}；缺失用例将按 skip 处理。")

    config = IntegrationConfig()
    if not config.yasamcp_binary.exists():
        print(f"ERROR: yasamcp 二进制不存在: {config.yasamcp_binary}")
        sys.exit(1)

    all_cases = [c for c in config.discover_cases() if c.tool != "init_project"]
    projects: dict[str, list] = collections.defaultdict(list)
    for c in all_cases:
        projects[str(c.project_path)].append(c)

    collector = LatencyCollector("mcp")

    passed = failed = skipped = 0
    errors: list[str] = []
    latencies: dict[str, list[float]] = collections.defaultdict(list)
    cold: list[float] = []
    first_per_project: dict[str, float] = {}

    params = StdioServerParameters(
        command=str(config.yasamcp_binary),
        args=["server", "-b", str(config.bin_dir)],
    )

    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            print("  MCP server 已连接\n")
            for pk in sorted(projects):
                pcs = projects[pk]
                ppath = Path(pk)
                lang_app = f"{pcs[0].lang}/{pcs[0].app}"
                print(f"=== {lang_app} ({len(pcs)} 用例) ===")
                first = True
                for c in pcs:
                    mcp = TOOL_MAP[c.tool]
                    args = McpArgBuilder.normalize(c.tool, c.arguments, ppath)
                    label = f"{lang_app}/{c.tool}/{c.case}"
                    try:
                        t0 = time.perf_counter()
                        result = await session.call_tool(mcp, args)
                        ms = (time.perf_counter() - t0) * 1000
                        actual = getattr(result, "structuredContent", None)
                        if first:
                            cold.append(ms)
                            first_per_project[lang_app] = ms
                            first = False
                        else:
                            latencies[c.tool].append(ms)

                        if not c.expected_file.exists():
                            print(f"  SKIP [{c.tool}/{c.case}] 无expected {ms:.0f}ms")
                            skipped += 1
                            continue

                        expected = json.loads(c.expected_file.read_text("utf-8").strip())

                        if normalize_json(actual) == normalize_json(expected):
                            passed += 1
                            collector.record(c.tool, c.case, ms, True, c.app, c.lang)
                            print(f"  PASS [{c.tool}/{c.case}] {ms:.0f}ms")
                        else:
                            failed += 1
                            errors.append(label)
                            collector.record(c.tool, c.case, ms, False, c.app, c.lang)
                            print(f"  FAIL [{c.tool}/{c.case}] {ms:.0f}ms")
                    except Exception as e:
                        failed += 1
                        errors.append(f"{label}: 异常 {e}")
                        print(f"  ERROR [{c.tool}/{c.case}] {e}")
                print()

    print("=" * 70)
    print(f"测试完成: {passed} passed, {failed} failed, {skipped} skipped")
    print("=" * 70)

    if cold:
        print(f"\n首次工具调用耗时 (含 fastload):")
        print(f"  count={len(cold)} avg={sum(cold)/len(cold):.0f}ms min={min(cold):.0f}ms max={max(cold):.0f}ms")
        for proj, ms in sorted(first_per_project.items(), key=lambda x: x[1], reverse=True):
            print(f"    {proj}: {ms:.0f}ms")

    print(f"\n热请求耗时 (按工具):")
    print(f"  {'tool':<35} {'count':>6} {'avg_ms':>8} {'min_ms':>8} {'max_ms':>8}")
    print(f"  {'-'*35} {'-'*6} {'-'*8} {'-'*8} {'-'*8}")
    all_warm: list[float] = []
    for t in sorted(latencies):
        vals = latencies[t]
        all_warm.extend(vals)
        print(f"  {t:<35} {len(vals):>6} {sum(vals)/len(vals):>8.0f} {min(vals):>8.0f} {max(vals):>8.0f}")
    if all_warm:
        avg = sum(all_warm) / len(all_warm)
        print(f"  {'(ALL WARM)':<35} {len(all_warm):>6} {avg:>8.0f} {min(all_warm):>8.0f} {max(all_warm):>8.0f}")
        under_100 = sum(1 for v in all_warm if v < 100)
        under_50 = sum(1 for v in all_warm if v < 50)
        print(f"\n  热请求 <  50ms: {under_50}/{len(all_warm)} ({under_50/len(all_warm)*100:.1f}%)")
        print(f"  热请求 < 100ms: {under_100}/{len(all_warm)} ({under_100/len(all_warm)*100:.1f}%)")

    if errors:
        print(f"\n失败详情 ({len(errors)}):")
        for e in errors[:20]:
            print(f"  - {e}")
        if len(errors) > 20:
            print(f"  ... 还有 {len(errors) - 20} 条")

    collector.write_report()


if __name__ == "__main__":
    # 脚本独立运行时把 repo root 加入 sys.path 以解析 tests.integration.* 导入
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent.parent))
    asyncio.run(run_tests())

"""yasamcp CLI 端到端集成测试。

通过 subprocess 调用 yasamcp CLI 二进制，对 test_cases 的每个 input.json
跑一遍并对比 expected.json，验证 CLI 端到端结果与基准一致。

用法:
    YASAMCP_BINARY=dist/yasamcp/yasamcp python -m pytest tests/integration/yasamcp_client_integration/test_cli_tools.py -q

    UPDATE_SNAPSHOTS=1 python -m pytest tests/integration/yasamcp_client_integration/test_cli_tools.py -q
"""

from __future__ import annotations

import json
import subprocess
import time
from pathlib import Path

import pytest

from tests.integration.yasamcp_client_integration.cli_args import CliArgBuilder
from tests.integration.yasamcp_client_integration.config import IntegrationCase, IntegrationConfig
from tests.integration.yasamcp_client_integration.latency import LatencyCollector


def run_binary(binary: Path, cli_args: list[str]) -> tuple[int, str]:
    proc = subprocess.run([str(binary)] + cli_args, capture_output=True, text=True, timeout=120)
    return proc.returncode, proc.stdout.strip()


def extract_json(output: str) -> dict | None:
    if not output:
        return None
    try:
        return json.loads(output)
    except (json.JSONDecodeError, TypeError):
        for i, ch in enumerate(output):
            if ch in "{[":
                try:
                    return json.loads(output[i:])
                except (json.JSONDecodeError, TypeError):
                    continue
        return None


def is_nonempty(result) -> bool:
    if result is None:
        return False
    if isinstance(result, dict):
        for k in ("results", "items", "data"):
            if result.get(k) is not None:
                return bool(result.get(k))
        return bool(result)
    return bool(result)


class TestCLITools:
    """CLI 端到端集成测试。"""

    @pytest.fixture(scope="class")
    def config(self) -> IntegrationConfig:
        c = IntegrationConfig()
        if not c.yasamcp_binary.exists():
            pytest.fail(f"yasamcp 二进制不存在: {c.yasamcp_binary}，请先执行 script/build_macos_arm64.sh")
        return c

    @pytest.fixture(scope="class")
    def collector(self) -> LatencyCollector:
        return LatencyCollector("cli")

    @pytest.fixture(scope="class")
    def all_cases(self, config: IntegrationConfig) -> list[IntegrationCase]:
        return config.discover_cases()

    @pytest.fixture(scope="class", autouse=True)
    def write_report(self, collector: LatencyCollector):
        yield
        collector.write_report()

    @pytest.fixture(scope="class")
    def init_done(self) -> set[str]:
        return set()

    def ensure_init(self, config: IntegrationConfig, project: Path, init_done: set[str]) -> None:
        key = str(project)
        if key in init_done:
            return
        cache = project / ".yasa"
        if (cache / "yasamcp" / ".codegraph" / "codegraph.db").exists() and (cache / "yasamcp" / "yasa.db").exists():
            init_done.add(key)
            return
        subprocess.run([str(config.yasamcp_binary), "init", str(project), "-b", str(config.bin_dir)],
                       check=False, capture_output=True, timeout=300)
        init_done.add(key)

    @pytest.mark.parametrize(
        "case",
        [c for c in IntegrationConfig().discover_cases()],
        ids=lambda c: c.id if isinstance(c, IntegrationCase) else str(c),
        scope="class",
    )
    def test_cli_tool(self, case: IntegrationCase, config: IntegrationConfig, collector: LatencyCollector, init_done: set[str]):
        if case.tool == "init_project":
            start = time.perf_counter()
            code, out = run_binary(config.yasamcp_binary, ["init", str(case.project_path), "-b", str(config.bin_dir)])
            ms = (time.perf_counter() - start) * 1000
            ok = code == 0 and "完成" in out
            collector.record("init_project", case.case, ms, ok, case.app, case.lang)
            assert ok, f"init 失败: exit={code} output={out[:500]}"
            return

        self.ensure_init(config, case.project_path, init_done)

        cli_args = CliArgBuilder.build(case.tool, case.arguments, case.project_path, config.bin_dir)
        start = time.perf_counter()
        code, out = run_binary(config.yasamcp_binary, cli_args)
        ms = (time.perf_counter() - start) * 1000

        result = extract_json(out) if code == 0 else None
        collector.record(case.tool, case.case, ms, result is not None, case.app, case.lang)

        assert code == 0, f"{case.id} CLI exit={code}, stderr:\n{out[:500]}"
        assert result is not None, f"{case.id} 无法解析 JSON: {out[:500]}"

        exp = case.expected_file

        if config.update_snapshots:
            exp.write_text(json.dumps(result, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
            return

        if exp.exists():
            expected = json.loads(exp.read_text("utf-8").strip())
            if not is_nonempty(expected):
                return  # expected 为空，接受空结果
            assert is_nonempty(result), f"{case.id} expected 非空但实际为空"
            def norm(x):
                if isinstance(x, dict) and "results" in x:
                    return sorted(x["results"], key=lambda r: json.dumps(r, ensure_ascii=False, sort_keys=True, default=str))
                return x
            assert norm(result) == norm(expected), (
                f"{case.id} 结果与 expected 不一致:\n"
                f"  expected n={len(norm(expected))} actual n={len(norm(result))}"
            )
        else:
            if is_nonempty(result):
                exp.write_text(json.dumps(result, ensure_ascii=False, indent=2, default=str), encoding="utf-8")

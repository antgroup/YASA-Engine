"""共享 pytest fixture：配置实例、耗时收集器、用例发现。"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

from tests.integration.yasamcp_client_integration.config import IntegrationConfig
from tests.integration.yasamcp_client_integration.latency import LatencyCollector


def pytest_configure(config):
    """收集前自动准备 xast dataset；失败不阻断，缺失用例按 skip 处理。"""
    from tests.integration.yasamcp_client_integration import prepare_dataset
    try:
        prepare_dataset.ensure_datasets()
    except Exception as e:  # noqa: BLE001
        import warnings
        warnings.warn(f"xast dataset 自动准备失败: {e}；缺失用例将按 skip 处理。")


@pytest.fixture(scope="session")
def config() -> IntegrationConfig:
    return IntegrationConfig()


@pytest.fixture(scope="session")
def collector(request) -> LatencyCollector:
    channel = getattr(request.session, "latency_channel", "cli")
    c = LatencyCollector(channel)
    return c


@pytest.fixture(autouse=True, scope="session")
def write_latency_report(request):
    """session 结束时输出耗时报告。"""
    yield
    c = getattr(request.session, "latency_collector", None)
    if c is not None:
        c.write_report()


class CacheManager:
    """管理项目缓存：首次遇到某项目时调用 CLI init。"""

    done: set[str] = set()

    @classmethod
    def ensure(cls, config: IntegrationConfig, project: Path) -> None:
        key = str(project)
        if key in cls.done:
            return
        cache = project / ".yasa"
        if (cache / "yasamcp" / ".codegraph" / "codegraph.db").exists() and (cache / "yasamcp" / "yasa.db").exists():
            cls.done.add(key)
            return
        subprocess.run(
            [str(config.yasamcp_binary), "init", str(project), "-b", str(config.bin_dir)],
            check=False, capture_output=True, timeout=300,
        )
        cls.done.add(key)


@pytest.fixture(scope="class")
def cache_manager():
    return CacheManager


def normalize_result(x):
    """对 JSON 结构排序后序列化，用于精确比较。"""
    if isinstance(x, dict) and "results" in x:
        return sorted(x["results"], key=lambda r: json.dumps(r, ensure_ascii=False, sort_keys=True, default=str))
    return x

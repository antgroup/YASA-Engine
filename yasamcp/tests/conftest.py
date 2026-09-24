"""pytest 公共 fixture。"""

from __future__ import annotations

import pytest


@pytest.fixture(scope="module")
def anyio_backend():
    """只使用 asyncio 后端，跳过 trio。"""
    return "asyncio"


def pytest_configure(config):
    config.addinivalue_line("markers", "integration: 依赖本机路径或外部环境的集成/基准测试")

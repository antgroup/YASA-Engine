"""@with_truncation 装饰器单元测试"""
import pytest

from yasa_mcp.service.models import YasaMcpResults
from yasa_mcp.util.truncation_util import (
    with_truncation,
    truncate_list_by_tokens,
    estimate_tokens,
)


# ── truncate_list_by_tokens 基础测试 ──


def test_no_limit():
    items = [{"a": "hello"}, {"b": "world"}]
    result, meta = truncate_list_by_tokens(items, 0)
    assert result == items
    assert meta.truncated is False
    assert meta.total_count == 2


def test_truncation_occurs():
    # 每个 item 约 14 chars = 3 tokens，设置极小限制触发截断
    items = [{"key": "value1"}, {"key": "value2"}, {"key": "value3"}]
    result, meta = truncate_list_by_tokens(items, 5)
    assert len(result) < len(items)
    assert meta.truncated is True
    assert meta.total_count == 3


def test_empty_list():
    result, meta = truncate_list_by_tokens([], 100)
    assert result == []
    assert meta.truncated is False
    assert meta.total_count == 0


def test_all_items_fit():
    items = [{"k": "v"}]
    result, meta = truncate_list_by_tokens(items, 10000)
    assert result == items
    assert meta.truncated is False
    assert meta.total_count == 1


def test_estimate_tokens():
    assert estimate_tokens("abcd") == 1
    assert estimate_tokens("abcdefgh") == 2
    assert estimate_tokens("") == 0


# ── @with_truncation async 装饰器测试 ──


@with_truncation
async def _mock_async_service(items, *, max_output_tokens=0):
    """模拟异步 service 函数"""
    return items


# ── @with_truncation sync 装饰器测试 ──


@with_truncation
def _mock_sync_service(items, *, max_output_tokens=0):
    """模拟同步 service 函数"""
    return items


@pytest.mark.anyio
async def test_async_decorator_no_truncation():
    items = [{"a": 1}, {"b": 2}]
    result = await _mock_async_service(items, max_output_tokens=0)
    assert isinstance(result, YasaMcpResults)
    assert len(result.results) == 2
    assert result.truncated is False
    assert result.total_count == 2


@pytest.mark.anyio
async def test_async_decorator_with_truncation():
    items = [{"key": f"value_{i}" * 50} for i in range(10)]
    result = await _mock_async_service(items, max_output_tokens=10)
    assert isinstance(result, YasaMcpResults)
    assert len(result.results) < 10
    assert result.truncated is True
    assert result.total_count == 10


@pytest.mark.anyio
async def test_async_decorator_empty_list():
    result = await _mock_async_service([], max_output_tokens=100)
    assert isinstance(result, YasaMcpResults)
    assert result.results == []
    assert result.truncated is False
    assert result.total_count == 0


@pytest.mark.anyio
async def test_async_decorator_max_output_tokens_not_passed_to_func():
    """验证装饰器从 kwargs 中移除了 max_output_tokens"""
    @with_truncation
    async def _service_that_checks_kwargs(**kwargs):
        assert "max_output_tokens" not in kwargs
        return [{"ok": True}]

    result = await _service_that_checks_kwargs(max_output_tokens=100)
    assert isinstance(result, YasaMcpResults)
    assert len(result.results) == 1


# ── @with_truncation sync 路径测试 ──


def test_sync_decorator_no_truncation():
    items = [{"a": 1}, {"b": 2}]
    result = _mock_sync_service(items, max_output_tokens=0)
    assert isinstance(result, YasaMcpResults)
    assert len(result.results) == 2
    assert result.truncated is False
    assert result.total_count == 2


def test_sync_decorator_with_truncation():
    items = [{"key": f"value_{i}" * 50} for i in range(10)]
    result = _mock_sync_service(items, max_output_tokens=10)
    assert isinstance(result, YasaMcpResults)
    assert len(result.results) < 10
    assert result.truncated is True
    assert result.total_count == 10


def test_sync_decorator_empty_list():
    result = _mock_sync_service([], max_output_tokens=100)
    assert isinstance(result, YasaMcpResults)
    assert result.results == []
    assert result.truncated is False
    assert result.total_count == 0


def test_sync_decorator_max_output_tokens_not_passed_to_func():
    """验证 sync 装饰器从 kwargs 中移除了 max_output_tokens"""
    @with_truncation
    def _service_that_checks_kwargs(**kwargs):
        assert "max_output_tokens" not in kwargs
        return [{"ok": True}]

    result = _service_that_checks_kwargs(max_output_tokens=100)
    assert isinstance(result, YasaMcpResults)
    assert len(result.results) == 1

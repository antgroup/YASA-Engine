import logging

from yasa_mcp.config import global_config
from yasa_mcp.util import timer_util
from yasa_mcp.util.timer_util import timed


logger = logging.getLogger("tests.timer_util")


class DummyContext:
    pass


def _mock_perf_counter_ns(monkeypatch, duration_ms: int):
    values = iter([0, duration_ms * 1_000_000])
    monkeypatch.setattr(timer_util.time, "perf_counter_ns", lambda: next(values))


def _last_message(caplog) -> str:
    return caplog.records[-1].getMessage()


def test_fast_service_entrypoint_logs_duration_without_args(monkeypatch, caplog):
    monkeypatch.setattr(global_config, "service_slow_request_log_threshold_ms", 10_000)
    _mock_perf_counter_ns(monkeypatch, 9_999)

    @timed(logger, "code_search_service", "get_function_by_call")
    def get_function_by_call(context, function_call, max_results=10):
        return []

    with caplog.at_level(logging.INFO, logger="tests.timer_util"):
        get_function_by_call(DummyContext(), "add(", max_results=5)

    msg = _last_message(caplog)
    assert "duration=9999 ms" in msg
    assert "args=" not in msg
    assert "function=" not in msg


def test_slow_service_entrypoint_logs_business_args_without_self_or_context(monkeypatch, caplog):
    monkeypatch.setattr(global_config, "service_slow_request_log_threshold_ms", 10_000)
    _mock_perf_counter_ns(monkeypatch, 10_000)

    @timed(logger, "callgraph_service", "get_function_by_call")
    def get_function_by_call(self, context, function_call, file_path="", line=0, max_results=10):
        return []

    with caplog.at_level(logging.INFO, logger="tests.timer_util"):
        get_function_by_call(object(), DummyContext(), "add(", file_path="src/A.java", line=12)

    msg = _last_message(caplog)
    assert "function=get_function_by_call" in msg
    assert '"function_call":"add("' in msg
    assert '"file_path":"src/A.java"' in msg
    assert '"line":12' in msg
    assert "self" not in msg
    assert "context" not in msg
    assert "DummyContext" not in msg


def test_zero_threshold_falls_back_to_default(monkeypatch, caplog):
    """threshold=0 回退到默认值，超过默认阈值仍会记录 args。"""
    monkeypatch.setattr(global_config, "service_slow_request_log_threshold_ms", 0)
    _mock_perf_counter_ns(monkeypatch, 9_999)

    @timed(logger, "code_search_service", "get_class_by_name")
    def get_class_by_name(name):
        return []

    with caplog.at_level(logging.INFO, logger="tests.timer_util"):
        get_class_by_name("Foo")

    msg = _last_message(caplog)
    assert "duration=9999 ms" in msg
    # threshold=0 回退到默认 3000ms，9999 > 3000，所以 args 会被记录
    assert "function=get_class_by_name" in msg


def test_service_level_logs_args_without_level2_whitelist(monkeypatch, caplog):
    monkeypatch.setattr(global_config, "service_slow_request_log_threshold_ms", 1)
    _mock_perf_counter_ns(monkeypatch, 20_000)

    @timed(logger, "realtime_analysis", "_locate_call_sites")
    def _locate_call_sites(function_call):
        return []

    with caplog.at_level(logging.INFO, logger="tests.timer_util"):
        _locate_call_sites("add(")

    msg = _last_message(caplog)
    assert "duration=20000 ms" in msg
    assert "function=_locate_call_sites" in msg
    assert '"function_call":"add("' in msg


def test_long_string_args_are_truncated(monkeypatch, caplog):
    monkeypatch.setattr(global_config, "service_slow_request_log_threshold_ms", 1)
    _mock_perf_counter_ns(monkeypatch, 2)

    @timed(logger, "code_search_service", "get_function_by_code")
    def get_function_by_code(code_snippet):
        return []

    with caplog.at_level(logging.INFO, logger="tests.timer_util"):
        get_function_by_code("x" * 600)

    msg = _last_message(caplog)
    assert "truncated, length=600" in msg
    assert "x" * 600 not in msg


def test_collection_args_are_not_item_limited(monkeypatch, caplog):
    monkeypatch.setattr(global_config, "service_slow_request_log_threshold_ms", 1)
    _mock_perf_counter_ns(monkeypatch, 2)

    @timed(logger, "code_search_service", "get_function_by_code")
    def get_function_by_code(values):
        return []

    with caplog.at_level(logging.INFO, logger="tests.timer_util"):
        get_function_by_code(list(range(25)))

    msg = _last_message(caplog)
    assert '"values":[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24]' in msg
    assert "__truncated__" not in msg

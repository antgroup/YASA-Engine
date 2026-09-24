from pathlib import Path
from unittest.mock import Mock, patch

import pytest

from yasa_mcp.core.cache_status import CacheStatusMask
from yasa_mcp.core.enums import Language
from yasa_mcp.service import callgraph_service as service


class _Result:
    def __init__(self, file_path: str, line: int, content: str):
        self.file_path = Path(file_path)
        self.line = line
        self.content = content


def _context(tool):
    context = Mock()
    context.get_tool.return_value = tool
    return context


def _stage2_accessor(rows=None):
    accessor = Mock()
    accessor.batch_get_edges_by_callsite_ranges.return_value = rows or []
    accessor.build_function_defs_from_cg_node_ids.return_value = {}
    return accessor


def _service_context():
    context = Mock()
    context.project_path = Path("/workspace/project")
    context.is_cache_ready.return_value = True
    context.get_main_languages.return_value = Language.PYTHON
    return context


def _unwrap_service(function):
    for _ in range(3):
        function = function.__wrapped__
    return function


def _service_impl():
    return _unwrap_service(service.get_function_by_call)


def _assert_log_fields(message: str, *, source: str):
    for field in (
        f"candidate_source={source}",
        "candidate_count=",
        "duration_ms=",
    ):
        assert field in message
    for field in (
        "stage=",
        "route=",
        "ripgrep_used=",
        "raw_candidate_count=",
        "file_path=",
        "line=",
    ):
        assert field not in message


@pytest.mark.parametrize(
    ("file_path", "expected"),
    [
        ("src/index.js", "src/index.js"),
        ("/workspace/project/src/index.js", "src/index.js"),
        ("/external/index.js", "/external/index.js"),
    ],
)
def test_locate_with_complete_position_normalizes_path_and_skips_ripgrep(
    file_path, expected
):
    context = Mock()

    with patch.object(service.log_util, "info") as info:
        result = service._locate_callsite_candidates(
            context, Path("/workspace/project"), "foo()", file_path, 42
        )

    assert result == [(expected, 42, "")]
    context.get_tool.assert_not_called()
    message = info.call_args.args[0]
    _assert_log_fields(message, source="user_input")
    assert "candidate_count=1" in message


def test_locate_helper_allows_exact_location_without_function_call():
    context = Mock()

    result = service._locate_callsite_candidates(
        context,
        Path("/workspace/project"),
        "",
        "/workspace/project/src/index.js",
        42,
    )

    assert result == [("src/index.js", 42, "")]
    context.get_tool.assert_not_called()


def test_locate_relative_file_limits_ripgrep_search_path():
    tool = Mock()
    tool.search_keyword_with_line.return_value = [
        _Result("/workspace/project/src/index.js", 42, "foo()")
    ]

    result = service._locate_callsite_candidates(
        _context(tool),
        Path("/workspace/project"),
        "foo()",
        "src/index.js",
        0,
    )

    assert result == [("src/index.js", 42, "foo()")]
    assert tool.search_keyword_with_line.call_count == 1
    assert tool.search_keyword_with_line.call_args.args[0] == Path(
        "/workspace/project/src"
    )
    assert tool.search_keyword_with_line.call_args.kwargs["include_globs"] == [
        "index.js"
    ]


def test_locate_line_only_soft_narrows_candidates():
    tool = Mock()
    tool.search_keyword_with_line.return_value = [
        _Result("/workspace/project/a.js", 7, "foo()"),
        _Result("/workspace/project/b.js", 9, "foo()"),
    ]

    result = service._locate_callsite_candidates(
        _context(tool), Path("/workspace/project"), "foo()", "", 9
    )

    assert result == [("b.js", 9, "foo()")]


def test_locate_line_only_miss_keeps_grep_candidates():
    tool = Mock()
    tool.search_keyword_with_line.return_value = [
        _Result("/workspace/project/a.js", 7, "foo()")
    ]

    result = service._locate_callsite_candidates(
        _context(tool), Path("/workspace/project"), "foo()", "", 99
    )

    assert result == [("a.js", 7, "foo()")]


def test_locate_without_position_uses_full_search_and_logs_fields():
    tool = Mock()
    tool.search_keyword_with_line.return_value = [
        _Result("/workspace/project/a.py", 7, "call(x)")
    ]

    with patch.object(service.log_util, "info") as info:
        result = service._locate_callsite_candidates(
            _context(tool), Path("/workspace/project"), "call(x)", "", 0
        )

    assert result == [("a.py", 7, "call(x)")]
    assert tool.search_keyword_with_line.call_count == 1
    _assert_log_fields(info.call_args.args[0], source="grep")


def test_locate_without_position_uses_prefix_and_logs_fields():
    tool = Mock()
    tool.search_keyword_with_line.side_effect = [
        [],
        [_Result("/workspace/project/a.py", 7, "call(")],
    ]

    with patch.object(service.log_util, "info") as info:
        result = service._locate_callsite_candidates(
            _context(tool), Path("/workspace/project"), "call(x)", "", 0
        )

    assert result == [("a.py", 7, "call(")]
    assert tool.search_keyword_with_line.call_count == 2
    assert all(
        call.args[0] == Path("/workspace/project")
        for call in tool.search_keyword_with_line.call_args_list
    )
    _assert_log_fields(info.call_args.args[0], source="grep")


def test_locate_file_prefix_fallback_keeps_file_search_path():
    tool = Mock()
    search_dir = Path("/workspace/project/src")
    tool.search_keyword_with_line.side_effect = [
        [],
        [_Result(str(search_dir / "a.py"), 7, "call(")],
    ]

    result = service._locate_callsite_candidates(
        _context(tool), Path("/workspace/project"), "call(x)", "src/a.py", 0
    )

    assert result == [("src/a.py", 7, "call(")]
    assert tool.search_keyword_with_line.call_count == 2
    assert all(
        call.args[0] == search_dir
        and call.kwargs["include_globs"] == ["a.py"]
        for call in tool.search_keyword_with_line.call_args_list
    )


def test_locate_logs_warning_when_full_grep_raises():
    tool = Mock()
    tool.search_keyword_with_line.side_effect = RuntimeError("rg failed")

    with patch.object(service.log_util, "warning") as warning:
        result = service._locate_callsite_candidates(
            _context(tool), Path("/workspace/project"), "foo()", "src/a.js", 0
        )

    assert result == []
    message = warning.call_args.args[0]
    _assert_log_fields(message, source="grep")
    assert "rg failed" in message


def test_locate_logs_warning_when_prefix_grep_raises():
    tool = Mock()
    tool.search_keyword_with_line.side_effect = [[], RuntimeError("prefix failed")]

    with patch.object(service.log_util, "warning") as warning:
        result = service._locate_callsite_candidates(
            _context(tool), Path("/workspace/project"), "foo()", "", 0
        )

    assert result == []
    message = warning.call_args.args[0]
    _assert_log_fields(message, source="grep")
    assert "prefix failed" in message


def test_locate_deduplicates_and_caps_sorted_candidates():
    tool = Mock()
    rows = [
        _Result(f"/workspace/project/f{i:02d}.js", i, "x")
        for i in range(12, 0, -1)
    ]
    rows.append(_Result("/workspace/project/f01.js", 1, "x"))
    tool.search_keyword_with_line.return_value = rows

    with patch.object(service.log_util, "info") as info:
        result = service._locate_callsite_candidates(
            _context(tool), Path("/workspace/project"), "x", "", 0
        )

    assert len(result) == service.MAX_CALLSITE_CANDIDATES
    assert result[0] == ("f01.js", 1, "x")
    assert result[-1] == ("f10.js", 10, "x")
    message = info.call_args.args[0]
    assert "candidate_count=10" in message
    _assert_log_fields(message, source="grep")


@pytest.mark.parametrize(
    ("file_path", "line"),
    [("", 0), ("src/index.js", 0), ("", 42)],
)
def test_service_requires_function_call_or_complete_location(file_path, line):
    context = _service_context()

    with (
        patch.object(service, "realtime_get_function_by_call") as realtime,
        patch.object(service, "get_callgraph_repository") as get_accessor,
        patch.object(service, "_locate_callsite_candidates") as locate,
    ):
        result = _service_impl()(context, "", file_path=file_path, line=line)

    assert result == []
    realtime.assert_not_called()
    get_accessor.assert_not_called()
    locate.assert_not_called()


def test_service_passes_exact_candidate_to_unchanged_stage2_contract():
    context = _service_context()
    accessor = _stage2_accessor()

    with (
        patch.object(service, "get_callgraph_repository", return_value=accessor),
        patch.object(
            service,
            "_locate_callsite_candidates",
            return_value=[("src/index.js", 42, "")],
        ) as locate,
    ):
        result = _service_impl()(
            context, "foo()", file_path="src/index.js", line=42
        )

    assert result == []
    locate.assert_called_once_with(
        context, Path("/workspace/project"), "foo()", "src/index.js", 42
    )
    assert accessor.batch_get_edges_by_callsite_ranges.call_args_list == [
        ((Language.PYTHON, [("src/index.js", 42, 42)]),),
        ((Language.PYTHON, [("src/index.js", 40, 44)]),),
    ]
    accessor.build_function_defs_from_cg_node_ids.assert_called_once_with(
        Language.PYTHON, []
    )


def _logged_messages(info: Mock) -> list[str]:
    return [call.args[0] for call in info.call_args_list]


def test_get_function_by_call_reuses_stage_timings_in_final_summary():
    context = _service_context()
    accessor = _stage2_accessor()
    perf_counter_values = iter(
        [0.000, 0.001, 0.003, 0.004, 0.007, 0.008, 0.012, 0.013, 0.018, 0.020]
    )

    with (
        patch.object(service, "get_callgraph_repository", return_value=accessor),
        patch.object(service, "_locate_callsite_candidates", return_value=[]),
        patch.object(service.time, "perf_counter", side_effect=perf_counter_values),
        patch.object(service.log_util, "info") as info,
    ):
        result = _service_impl()(context, "foo()")

    assert result == []
    messages = _logged_messages(info)
    for stage in range(1, 5):
        stage_message = next(message for message in messages if f"阶段{stage}" in message)
        assert "duration=" not in stage_message
    summary = next(message for message in messages if "get_function_by_call 完成:" in message)
    for field in (
        "stage1_duration=2.0ms",
        "stage2_duration=3.0ms",
        "stage3_duration=4.0ms",
        "stage4_duration=5.0ms",
        "total_duration=20.0ms",
    ):
        assert field in summary


def test_get_reference_by_function_logs_zero_for_skipped_stages():
    context = _service_context()
    accessor = Mock()
    accessor.query_function_node_ids.return_value = []
    perf_counter_values = iter([0.000, 0.001, 0.003, 0.010])

    with (
        patch.object(service, "get_callgraph_repository", return_value=accessor),
        patch.object(service.time, "perf_counter", side_effect=perf_counter_values),
        patch.object(service.log_util, "info") as info,
    ):
        result = _unwrap_service(service.get_reference_by_function)(context, "foo")

    assert result == []
    messages = _logged_messages(info)
    stage1_message = next(message for message in messages if "阶段1" in message)
    assert "duration=" not in stage1_message
    summary = next(
        message for message in messages if "get_reference_by_function 完成:" in message
    )
    for field in (
        "stage1_duration=2.0ms",
        "stage2_duration=0.0ms",
        "stage3_duration=0.0ms",
        "stage4_duration=0.0ms",
        "total_duration=10.0ms",
    ):
        assert field in summary


def test_get_call_graph_logs_zero_for_skipped_stage2():
    context = _service_context()
    accessor = Mock()
    accessor.query_function_node_ids.return_value = []
    perf_counter_values = iter([0.000, 0.001, 0.003, 0.010])

    with (
        patch.object(service, "get_callgraph_repository", return_value=accessor),
        patch.object(service.time, "perf_counter", side_effect=perf_counter_values),
        patch.object(service.log_util, "info") as info,
    ):
        result = _unwrap_service(service.get_call_graph)(context, "foo")

    assert result == []
    messages = _logged_messages(info)
    stage1_message = next(message for message in messages if "阶段1" in message)
    assert "duration=" not in stage1_message
    summary = next(message for message in messages if "执行完成get_call_graph:" in message)
    for field in (
        "stage1_duration=2.0ms",
        "stage2_duration=0.0ms",
        "total_duration=10.0ms",
    ):
        assert field in summary

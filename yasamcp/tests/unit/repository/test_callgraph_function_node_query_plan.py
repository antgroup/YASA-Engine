from __future__ import annotations

from pathlib import Path

import pytest

from yasa_mcp.core.enums import Language
from yasa_mcp.repository.callgraph_query import (
    CallgraphSqlAccessor,
    FunctionNodeQueryContext,
)


_FIELD_WHERE = {
    "file_path": "(func_def_sourcefile = ? OR regexp_matches(func_def_sourcefile, ?))",
    "line": (
        "(func_def_start_line IS NOT NULL AND "
        "func_def_end_line IS NOT NULL AND "
        "? BETWEEN func_def_start_line AND func_def_end_line)"
    ),
    "name": "func_name = ?",
    "function_fqn": "(full_name = ? OR regexp_matches(full_name, ?))",
}

_FIELD_PARAMS = {
    "file_path": ["src/app.js", r"(^|/)src/app\.js$"],
    "line": [42],
    "name": ["handler"],
    "function_fqn": ["pkg.Controller.handler", r"(^|\.)pkg\.Controller\.handler$"],
}


@pytest.fixture
def accessor() -> CallgraphSqlAccessor:
    return CallgraphSqlAccessor(cg=None, project_path=Path("."))  # type: ignore[arg-type]


def _ctx(
    *,
    has_file_path: bool,
    has_line: bool,
    has_name: bool,
    has_function_fqn: bool,
) -> FunctionNodeQueryContext:
    return FunctionNodeQueryContext(
        language=Language.JAVASCRIPT,
        name="handler" if has_name else "",
        function_fqn="pkg.Controller.handler" if has_function_fqn else "",
        file_path="src/app.js" if has_file_path else "",
        line=42 if has_line else 0,
        use_regex=False,
        need_definition=False,
    )


def _expected_where(fields: tuple[str, ...]) -> str:
    conditions = ["language = ?"]
    for field in fields:
        if field == "function_fqn" and "name" not in fields:
            conditions.append(_FIELD_WHERE["name"])
        conditions.append(_FIELD_WHERE[field])
    return " AND ".join(conditions)


def _expected_params(fields: tuple[str, ...]) -> list[object]:
    params: list[object] = [Language.JAVASCRIPT.value]
    for field in fields:
        if field == "function_fqn" and "name" not in fields:
            params.extend(["handler"])
        params.extend(_FIELD_PARAMS[field])
    return params


@pytest.mark.parametrize(
    (
        "has_file_path",
        "has_line",
        "has_name",
        "has_function_fqn",
        "expected_attempts",
    ),
    [
        (True, True, True, True, ["file_line", "file_name_fqn", "file_fqn", "name_fqn", "function_fqn", "name"]),
        (True, True, True, False, ["file_line", "name"]),
        (True, True, False, True, ["file_line", "file_fqn", "function_fqn"]),
        (True, True, False, False, ["file_line"]),
        (True, False, True, True, ["file_name_fqn", "file_fqn", "name_fqn", "function_fqn", "name"]),
        (True, False, True, False, ["name"]),
        (True, False, False, True, ["file_fqn", "function_fqn"]),
        (True, False, False, False, []),
        (False, True, True, True, ["name_fqn", "function_fqn", "name"]),
        (False, True, True, False, ["name"]),
        (False, True, False, True, ["function_fqn"]),
        (False, True, False, False, []),
        (False, False, True, True, ["name_fqn", "function_fqn", "name"]),
        (False, False, True, False, ["name"]),
        (False, False, False, True, ["function_fqn"]),
        (False, False, False, False, []),
    ],
)
def test_function_node_query_plan_16_cases_build_expected_where(
    accessor: CallgraphSqlAccessor,
    has_file_path: bool,
    has_line: bool,
    has_name: bool,
    has_function_fqn: bool,
    expected_attempts: list[str],
) -> None:
    """覆盖计划中 file_path/line/name/function_fqn 的 16 种降级组合。"""
    ctx = _ctx(
        has_file_path=has_file_path,
        has_line=has_line,
        has_name=has_name,
        has_function_fqn=has_function_fqn,
    )

    attempts = accessor._build_function_node_query_attempts(ctx)  # noqa: SLF001

    assert [attempt.strategy for attempt in attempts] == expected_attempts
    for attempt in attempts:
        where, params = accessor._build_function_node_where(attempt, ctx)  # noqa: SLF001
        assert where == _expected_where(attempt.fields)
        assert params == _expected_params(attempt.fields)


def test_function_node_query_where_appends_definition_filter(accessor: CallgraphSqlAccessor) -> None:
    """验证 need_definition=True 会在字段条件后追加真实定义过滤。"""
    ctx = FunctionNodeQueryContext(
        language=Language.JAVASCRIPT,
        name="handler",
        function_fqn="pkg.Controller.handler",
        file_path="src/app.js",
        line=42,
        need_definition=True,
    )
    attempt = accessor._build_function_node_query_attempts(ctx)[0]  # noqa: SLF001

    where, params = accessor._build_function_node_where(attempt, ctx)  # noqa: SLF001

    assert where == (
        "language = ? AND "
        "(func_def_sourcefile = ? OR regexp_matches(func_def_sourcefile, ?)) AND "
        "(func_def_start_line IS NOT NULL AND "
        "func_def_end_line IS NOT NULL AND "
        "? BETWEEN func_def_start_line AND func_def_end_line) AND "
        "is_external = FALSE AND "
        "func_def_sourcefile IS NOT NULL AND "
        "func_def_start_line IS NOT NULL AND "
        "func_def_end_line IS NOT NULL"
    )
    assert params == [Language.JAVASCRIPT.value, "src/app.js", r"(^|/)src/app\.js$", 42]


def test_function_node_query_line_uses_between_closed_range(accessor: CallgraphSqlAccessor) -> None:
    """锁定 line 语义：函数定义范围闭区间命中，而不是开始行精确命中。"""
    ctx = FunctionNodeQueryContext(
        language=Language.JAVASCRIPT,
        file_path="src/app.js",
        line=42,
    )
    attempt = accessor._build_function_node_query_attempts(ctx)[0]  # noqa: SLF001

    where, params = accessor._build_function_node_where(attempt, ctx)  # noqa: SLF001

    assert "? BETWEEN func_def_start_line AND func_def_end_line" in where
    assert "func_def_start_line IS NOT NULL" in where
    assert "func_def_end_line IS NOT NULL" in where
    assert "func_def_start_line = ?" not in where
    assert "COALESCE(func_def_end_line" not in where
    assert params == [Language.JAVASCRIPT.value, "src/app.js", r"(^|/)src/app\.js$", 42]

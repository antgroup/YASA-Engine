from __future__ import annotations

from yasa_mcp.repository.query.codegraph.authscan_function_processor import (
    AuthScanFunctionProcessor,
)


class RecordingRepository:
    def __init__(self, result_on_strategy: str = ""):
        self.result_on_strategy = result_on_strategy
        self.queries = []

    def execute_function_query(self, query, limit=0, offset=0):
        self.queries.append((query, limit, offset))
        if query.strategy == self.result_on_strategy:
            return [{"function_fqn": "matched", "short_name": "query"}]
        return []


def _conditions(query):
    return query.conditions_sql, query.condition_params


def test_fqcn_method_delegates_to_function_processor() -> None:
    repository = RecordingRepository("function_name_fqn_exact")

    rows = AuthScanFunctionProcessor(repository, "java").search(
        "com.demo.UserServiceImpl.query", limit=5
    )

    assert rows == [{"function_fqn": "matched", "short_name": "query"}]
    query, limit, offset = repository.queries[0]
    assert query.strategy == "function_name_fqn_exact"
    assert query.condition_params == ("query", "com.demo::UserServiceImpl::query")
    assert (limit, offset) == (5, 0)


def test_short_method_delegates_to_function_processor_suffix() -> None:
    repository = RecordingRepository("function_fqn_suffix")

    rows = AuthScanFunctionProcessor(repository, "java").search("UserService.query")

    assert rows == [{"function_fqn": "matched", "short_name": "query"}]
    query = repository.queries[0][0]
    assert query.strategy == "function_fqn_suffix"
    assert query.condition_params == (
        "query",
        r"(?:^|\.|::)UserService::query$",
    )


def test_explicit_regex_delegates_once_without_name_condition() -> None:
    repository = RecordingRepository()

    AuthScanFunctionProcessor(repository, "java").search(
        r"com\.demo\..*\.query", use_regex=True
    )

    assert [call[0].strategy for call in repository.queries] == [
        "function_fqn_regex"
    ]


def test_fqcn_class_keeps_owner_query() -> None:
    repository = RecordingRepository("authscan_function_fqcn_class")

    AuthScanFunctionProcessor(repository, "java").search("com.demo.DateTimeUtil")

    query = repository.queries[0][0]
    assert query.strategy == "authscan_function_fqcn_class"
    assert query.condition_params == (
        "java",
        r"^com\.demo::DateTimeUtil::[^:]+$",
    )


def test_short_class_keeps_owner_query() -> None:
    repository = RecordingRepository("authscan_function_short_class")

    AuthScanFunctionProcessor(repository, "java").search("DateTimeUtil")

    query = repository.queries[0][0]
    assert query.strategy == "authscan_function_short_class"
    assert query.condition_params == (
        "java",
        r"(?:^|\.|::)DateTimeUtil::[^:]+$",
    )






def test_http_path_and_unknown_shape_do_not_query() -> None:
    repository = RecordingRepository()
    processor = AuthScanFunctionProcessor(repository, "java")

    assert processor.search("/users/query") == []
    assert processor.search("query") == []
    assert repository.queries == []

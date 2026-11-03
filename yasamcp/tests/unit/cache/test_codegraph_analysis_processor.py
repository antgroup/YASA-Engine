from __future__ import annotations

from pathlib import Path

import pytest

from yasa_mcp.repository.query.codegraph.class_analysis_processor import ClassAnalysisProcessor
from yasa_mcp.repository.query.codegraph.function_analysis_processor import FunctionAnalysisProcessor
from yasa_mcp.repository.query.codegraph.query_models import (
    ClassRecord,
    FunctionRecord,
    FunctionInputKind,
    MethodRecord,
    PreparedNodeQuery,
)


class FakeRepository:
    """记录 PreparedNodeQuery，验证分类和条件编译发生在 repository 之前。"""

    def __init__(self, results: dict[str, list[ClassRecord | FunctionRecord]]):
        self.results = results
        self.calls: list[tuple[PreparedNodeQuery, int, int]] = []

    def execute_class_query(self, query: PreparedNodeQuery, limit: int = 0, offset: int = 0) -> list[ClassRecord]:
        self.calls.append((query, limit, offset))
        return [dict(row) for row in self.results.get(query.strategy, [])]

    def execute_function_query(self, query: PreparedNodeQuery, limit: int = 0, offset: int = 0) -> list[FunctionRecord]:
        self.calls.append((query, limit, offset))
        return [dict(row) for row in self.results.get(query.strategy, [])]

    def get_methods_by_owner_fqn(self, class_fqn: str) -> list[MethodRecord]:
        return []


def test_function_name_and_full_fqn_stops_after_first_exact_hit() -> None:
    repository = FakeRepository({"function_name_fqn_exact": [{"short_name": "run"}]})
    rows = FunctionAnalysisProcessor(repository, name="run", function_fqn="pkg.deep.Type.run").search(limit=4, offset=2)
    assert rows == [{"short_name": "run"}]
    query, limit, offset = repository.calls[0]
    assert (query.strategy, query.conditions_sql, query.condition_params, limit, offset) == (
        "function_name_fqn_exact", "name = ? AND qualified_name = ?", ("run", "pkg.deep::Type::run"), 4, 2
    )


def test_function_falls_back_from_combined_to_fqn_to_name() -> None:
    repository = FakeRepository({"function_name_exact": [{"short_name": "run"}]})
    FunctionAnalysisProcessor(repository, name="run", function_fqn="pkg::deep::Type::run").search()
    assert [call[0].strategy for call in repository.calls] == [
        "function_name_fqn_exact",
        "function_fqn_exact",
        "function_name_exact",
    ]


@pytest.mark.parametrize(
    ("value", "expected_kind"),
    [
        ("User.run", FunctionInputKind.OWNER_MEMBER_SUFFIX),
        ("pkg.User.run", FunctionInputKind.OWNER_MEMBER_SUFFIX),
        ("pkg.deep.User.run", FunctionInputKind.FULL_DOTTED_FQCN),
        ("pkg::deep::User::run", FunctionInputKind.FULL_STORED_FQCN),
    ],
)
def test_function_input_classification_uses_four_segment_boundary(
    value: str,
    expected_kind: FunctionInputKind,
) -> None:
    processor = FunctionAnalysisProcessor(FakeRepository({}), function_fqn=value)

    assert processor.classified_input.kind is expected_kind


def test_short_owner_member_routes_directly_to_boundary_suffix() -> None:
    repository = FakeRepository({"function_fqn_suffix": [{"short_name": "funcA"}]})
    FunctionAnalysisProcessor(repository, function_fqn="A.funcA").search()
    assert [(call[0].strategy, call[0].condition_params) for call in repository.calls] == [
        ("function_fqn_suffix", (r"(?:^|\.|::)A::funcA$",))
    ]


def test_tail_owner_member_routes_directly_to_boundary_suffix() -> None:
    repository = FakeRepository({"function_fqn_suffix": [{"short_name": "funcA"}]})
    FunctionAnalysisProcessor(repository, function_fqn="d.A.funcA").search()
    assert [(call[0].strategy, call[0].condition_params) for call in repository.calls] == [
        ("function_fqn_suffix", (r"(?:^|\.|::)d(?:\.|::)A::funcA$",))
    ]


def test_suffix_falls_back_to_derived_member_name_without_exact() -> None:
    repository = FakeRepository({"function_name_exact": [{"short_name": "run"}]})
    processor = FunctionAnalysisProcessor(repository, function_fqn="User.run")

    assert processor.classified_input.kind is FunctionInputKind.OWNER_MEMBER_SUFFIX
    assert processor.search() == [{"short_name": "run"}]
    assert [call[0].strategy for call in repository.calls] == [
        "function_fqn_suffix",
        "function_name_exact",
    ]
    assert repository.calls[1][0].condition_params == ("run",)


def test_regex_attempts_adapt_fqn_and_remain_isolated() -> None:
    repository = FakeRepository({"class_fqn_regex": [{"short_name": "Type"}]})
    rows = ClassAnalysisProcessor(repository, name="Type", class_fqn=r"pkg\.Type", use_regex=True).search()
    assert rows == [{"short_name": "Type"}]
    assert [call[0].strategy for call in repository.calls] == ["class_name_fqn_regex", "class_fqn_regex"]
    assert repository.calls[0][0].condition_params == ("Type", "pkg::Type")


def test_file_path_is_normalized_before_repository_query(tmp_path: Path) -> None:
    project = tmp_path / "project"
    repository = FakeRepository({"functions_by_file_exact": [{"short_name": "main"}]})
    rows = FunctionAnalysisProcessor.for_file(repository, project, str(project / "src" / "Main.java")).search_file()
    assert rows == [{"short_name": "main"}]
    assert repository.calls[0][0].condition_params == ("src/Main.java",)


def test_processor_instances_share_repository_without_sharing_request_state() -> None:
    repository = FakeRepository({})
    first = FunctionAnalysisProcessor(repository, function_fqn="pkg.deep.First.run")
    second = FunctionAnalysisProcessor(repository, function_fqn="pkg.deep.Second.run")
    assert first.repository is second.repository is repository
    assert first.classified_input.exact_candidates != second.classified_input.exact_candidates

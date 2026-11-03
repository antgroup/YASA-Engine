from __future__ import annotations

import sqlite3
from collections.abc import Iterator
from pathlib import Path

import pytest

from yasa_mcp.repository.codegraph_repo import CodeGraphAnalysisRepository
from yasa_mcp.repository.query.codegraph.interface_implementation_processor import (
    InterfaceImplementationProcessor,
    InterfaceResolutionStatus,
)
from yasa_mcp.repository.query.codegraph.query_models import InterfaceQueryKind
from yasa_mcp.repository.query.codegraph.query_models import InterfaceQueryKind


@pytest.fixture
def repository(tmp_path: Path) -> Iterator[CodeGraphAnalysisRepository]:
    db_path = tmp_path / "codegraph.db"
    connection = sqlite3.connect(db_path)
    connection.executescript(
        """
        CREATE TABLE nodes (
            id TEXT PRIMARY KEY,
            kind TEXT NOT NULL,
            name TEXT NOT NULL,
            qualified_name TEXT NOT NULL,
            signature TEXT,
            return_type TEXT,
            language TEXT NOT NULL,
            file_path TEXT NOT NULL,
            start_line INTEGER NOT NULL,
            start_column INTEGER NOT NULL,
            end_line INTEGER NOT NULL,
            end_column INTEGER NOT NULL
        );
        CREATE TABLE edges (
            id TEXT PRIMARY KEY,
            source TEXT NOT NULL,
            target TEXT NOT NULL,
            kind TEXT NOT NULL,
            metadata TEXT,
            provenance TEXT
        );
        CREATE INDEX idx_nodes_name ON nodes(name);
        CREATE INDEX idx_nodes_qualified_name ON nodes(qualified_name);
        CREATE INDEX idx_edges_target_kind ON edges(target, kind);
        """
    )
    connection.executemany(
        "INSERT INTO nodes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
            (
                "iface-user", "interface", "UserService", "com.demo::UserService",
                None, None, "java", "api/UserService.java", 3, 0, 8, 1,
            ),
            (
                "class-user", "class", "UserServiceImpl", "com.demo::UserServiceImpl",
                None, None, "java", "impl/UserServiceImpl.java", 5, 0, 30, 1,
            ),
            (
                "method-user-1", "method", "query", "com.demo::UserServiceImpl::query",
                "(String id)", "User", "java", "impl/UserServiceImpl.java", 10, 2, 13, 3,
            ),
            (
                "method-user-2", "method", "query", "com.demo::UserServiceImpl::query",
                "(long id)", "User", "java", "impl/UserServiceImpl.java", 15, 2, 18, 3,
            ),
            (
                "iface-other", "interface", "UserService", "other.demo::UserService",
                None, None, "java", "other/UserService.java", 3, 0, 8, 1,
            ),
            (
                "class-other", "class", "OtherUserServiceImpl", "other.demo::OtherUserServiceImpl",
                None, None, "java", "other/OtherUserServiceImpl.java", 5, 0, 20, 1,
            ),
            (
                "method-other", "method", "query", "other.demo::OtherUserServiceImpl::query",
                "()", "User", "java", "other/OtherUserServiceImpl.java", 9, 2, 11, 3,
            ),
            (
                "iface-python", "interface", "UserService", "python.demo::UserService",
                None, None, "python", "python/user.py", 1, 0, 4, 0,
            ),
            (
                "class-python", "class", "UserServiceImpl", "python.demo::UserServiceImpl",
                None, None, "python", "python/user_impl.py", 1, 0, 8, 0,
            ),
            (
                "method-python", "method", "query", "python.demo::UserServiceImpl::query",
                "(id)", None, "python", "python/user_impl.py", 3, 0, 5, 0,
            ),
        ],
    )
    connection.executemany(
        "INSERT INTO edges VALUES (?, ?, ?, 'implements', ?, ?)",
        [
            ("edge-user", "class-user", "iface-user", "{}", "extractor"),
            ("edge-other", "class-other", "iface-other", "{}", "extractor"),
            ("edge-python", "class-python", "iface-python", "{}", "extractor"),
        ],
    )
    connection.commit()
    connection.close()

    repo = CodeGraphAnalysisRepository(db_path)
    yield repo
    repo.close()


def test_fqcn_method_returns_all_overloads(
    repository: CodeGraphAnalysisRepository,
) -> None:
    resolution = InterfaceImplementationProcessor(repository, "java").resolve(
        "com.demo.UserService.query"
    )

    assert resolution.status is InterfaceResolutionStatus.MULTIPLE_METHODS_RESOLVED
    assert [row["function_signature"] for row in resolution.records] == [
        "User query(String id)",
        "User query(long id)",
    ]
    assert {row["interface_fqn"] for row in resolution.records} == {
        "com.demo::UserService"
    }


def test_short_interface_keeps_all_interfaces_and_implementations(
    repository: CodeGraphAnalysisRepository,
) -> None:
    resolution = InterfaceImplementationProcessor(repository, "java").resolve(
        "UserService.query"
    )

    assert resolution.status is InterfaceResolutionStatus.MULTIPLE_METHODS_RESOLVED
    assert [row["function_fqn"] for row in resolution.records] == [
        "com.demo::UserServiceImpl::query",
        "com.demo::UserServiceImpl::query",
        "other.demo::OtherUserServiceImpl::query",
    ]


def test_language_filter_excludes_other_languages(
    repository: CodeGraphAnalysisRepository,
) -> None:
    resolution = InterfaceImplementationProcessor(repository, "python").resolve(
        "UserService.query"
    )

    assert resolution.status is InterfaceResolutionStatus.METHOD_RESOLVED
    assert resolution.records[0]["function_fqn"] == "python.demo::UserServiceImpl::query"


def test_fqcn_interface_only_returns_implementation_methods(
    repository: CodeGraphAnalysisRepository,
) -> None:
    resolution = InterfaceImplementationProcessor(repository, "java").resolve(
        "com.demo.UserService"
    )

    assert resolution.status is InterfaceResolutionStatus.MULTIPLE_METHODS_RESOLVED
    assert [row["function_fqn"] for row in resolution.records] == [
        "com.demo::UserServiceImpl::query",
        "com.demo::UserServiceImpl::query",
    ]


def test_short_interface_only_keeps_all_matching_interfaces(
    repository: CodeGraphAnalysisRepository,
) -> None:
    resolution = InterfaceImplementationProcessor(repository, "java").resolve(
        "UserService"
    )

    assert resolution.status is InterfaceResolutionStatus.MULTIPLE_METHODS_RESOLVED
    assert [row["function_fqn"] for row in resolution.records] == [
        "com.demo::UserServiceImpl::query",
        "com.demo::UserServiceImpl::query",
        "other.demo::OtherUserServiceImpl::query",
    ]


def test_unmatched_input_reports_gap_without_querying_functions(
    repository: CodeGraphAnalysisRepository,
) -> None:
    processor = InterfaceImplementationProcessor(repository, "java")

    assert processor.resolve("com.demo.UserService.missing").status is InterfaceResolutionStatus.IMPLEMENTATION_METHOD_NOT_FOUND
    assert processor.resolve("UnknownService").status is InterfaceResolutionStatus.INTERFACE_IMPLEMENTATION_NOT_FOUND
    assert processor.resolve("/users/query").status is InterfaceResolutionStatus.INTERFACE_IMPLEMENTATION_NOT_FOUND


def test_interface_sql_matches_reviewed_contract(
    repository: CodeGraphAnalysisRepository,
) -> None:
    method_templates = (
        "interface_implement_by_fqcn",
        "interface_implement_by_short_name",
    )
    interface_only_templates = (
        "interface_only_implement_by_fqcn",
        "interface_only_implement_by_short_name",
    )
    for name in (*method_templates, *interface_only_templates):
        sql = repository._statements[name].lower()
        assert sql.count("join ") == 3
        assert "left join nodes m" in sql
        assert "m.qualified_name not like" not in sql
        assert "contains" not in sql
        assert "{conditions}" not in sql
    for name in method_templates:
        sql = repository._statements[name].lower()
        assert "m.qualified_name = c.qualified_name || '::' || ?" in sql
        assert "m.qualified_name like" not in sql
    for name in interface_only_templates:
        sql = repository._statements[name].lower()
        assert "m.qualified_name like c.qualified_name || '::%'" in sql


def test_interface_query_plans_use_expected_indexes(
    repository: CodeGraphAnalysisRepository,
) -> None:
    connection = repository._get_connection()
    cases = {
        "interface_implement_by_fqcn": (
            "query", "java", "java", "java", "com.demo::UserService"
        ),
        "interface_implement_by_short_name": (
            "query", "java", "java", "java", "UserService"
        ),
        "interface_only_implement_by_fqcn": (
            "java", "java", "java", "com.demo::UserService"
        ),
        "interface_only_implement_by_short_name": (
            "java", "java", "java", "UserService"
        ),
    }
    for name, params in cases.items():
        plan = connection.execute(
            f"EXPLAIN QUERY PLAN {repository._statements[name]}", params
        ).fetchall()
        details = "\n".join(str(row[3]) for row in plan)
        assert "idx_edges_target_kind" in details
        assert "sqlite_autoindex_nodes_1" in details
        assert "NOT LIKE" not in repository._statements[name].upper()


def test_repository_ignores_method_name_for_all_methods_query(
    repository: CodeGraphAnalysisRepository,
) -> None:
    rows = repository.find_interface_implementations(
        query_kind=InterfaceQueryKind.SHORT_NAME_ALL_METHODS,
        interface_name="UserService",
        method_name="unused",
        language="java",
    )

    assert len(rows) == 3


def test_repository_executes_method_query_with_query_kind(
    repository: CodeGraphAnalysisRepository,
) -> None:
    rows = repository.find_interface_implementations(
        query_kind=InterfaceQueryKind.FQCN_METHOD,
        interface_name="com.demo::UserService",
        method_name="query",
        language="java",
    )

    assert len(rows) == 2

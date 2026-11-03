from __future__ import annotations

import sqlite3
from collections.abc import Iterator
from pathlib import Path

import pytest

from yasa_mcp.repository.codegraph_repo import CodeGraphAnalysisRepository
from yasa_mcp.repository.query.codegraph.class_analysis_processor import ClassAnalysisProcessor
from yasa_mcp.repository.query.codegraph.function_analysis_processor import FunctionAnalysisProcessor
from yasa_mcp.repository.query.codegraph.query_models import (
    ConditionField,
    ConditionOperator,
    PreparedNodeQuery,
    PreparedNodeQueryBuilder,
    QueryCondition,
    QueryTemplate,
)


@pytest.fixture
def codegraph_db(tmp_path: Path) -> Path:
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
            file_path TEXT NOT NULL,
            start_line INTEGER NOT NULL,
            start_column INTEGER NOT NULL,
            end_line INTEGER NOT NULL,
            end_column INTEGER NOT NULL
        );
        CREATE INDEX idx_nodes_kind_name ON nodes(kind, name);
        CREATE INDEX idx_nodes_qualified_name ON nodes(qualified_name);
        CREATE INDEX idx_nodes_file_path ON nodes(file_path);
        """
    )
    connection.executemany(
        "INSERT INTO nodes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
            (
                "class-main", "class", "ModuleBootstrapApplication",
                "com.alipay.smartcampus::ModuleBootstrapApplication", None, None,
                "app/ModuleBootstrapApplication.java", 3, 0, 12, 1,
            ),
            (
                "method-main", "method", "main",
                "com.alipay.smartcampus::ModuleBootstrapApplication::main",
                "(String[] args)", "void", "app/ModuleBootstrapApplication.java", 5, 2, 7, 3,
            ),
            (
                "function-helper", "function", "helper", "pkg::helper",
                "()", "str", "src/helper.py", 1, 0, 2, 0,
            ),
            (
                "struct-user", "struct", "User", "pkg::User",
                None, None, "src/user.rs", 1, 0, 9, 0,
            ),
            (
                "method-run", "method", "run", "pkg::User::run",
                "()", None, "src/user.rs", 3, 0, 4, 0,
            ),
            (
                "function-user-helper", "function", "helper", "pkg::User::helper",
                "()", None, "src/user.rs", 5, 0, 6, 0,
            ),
            (
                "import-list", "import", "java.util.List", "java.util.List",
                None, None, "src/Example.java", 2, 0, 2, 22,
            ),
            (
                "import-helper", "import", "pkg.Helper", "pkg.Helper",
                None, None, "nested/src/Example.java", 3, 0, 3, 18,
            ),
        ],
    )
    connection.commit()
    connection.close()
    return db_path


@pytest.fixture
def repository(codegraph_db: Path) -> Iterator[CodeGraphAnalysisRepository]:
    repo = CodeGraphAnalysisRepository(codegraph_db)
    yield repo
    repo.close()


def test_function_query_maps_long_dot_fqn(repository: CodeGraphAnalysisRepository) -> None:
    rows = FunctionAnalysisProcessor(
        repository,
        function_fqn="com.alipay.smartcampus.ModuleBootstrapApplication.main",
    ).search(limit=3)

    assert rows[0]["function_fqn"] == "com.alipay.smartcampus::ModuleBootstrapApplication::main"
    assert rows[0]["function_signature"] == "void main(String[] args)"


def test_regex_fqn_is_adapted_to_stored_separator(repository: CodeGraphAnalysisRepository) -> None:
    rows = FunctionAnalysisProcessor(
        repository,
        function_fqn=r"com\.alipay\.smartcampus\.ModuleBootstrapApplication\.main",
        use_regex=True,
    ).search()

    assert [row["short_name"] for row in rows] == ["main"]


def test_class_query_includes_non_java_type_kinds(repository: CodeGraphAnalysisRepository) -> None:
    rows = ClassAnalysisProcessor(repository, name="User").search()

    assert rows[0]["class_fqn"] == "pkg::User"


def test_function_query_includes_free_function_kind(repository: CodeGraphAnalysisRepository) -> None:
    rows = FunctionAnalysisProcessor(repository, name="helper").search()

    assert "pkg::helper" in {row["function_fqn"] for row in rows}


def test_methods_by_owner_excludes_same_owner_free_functions(
    repository: CodeGraphAnalysisRepository,
) -> None:
    rows = repository.get_methods_by_owner_fqn("pkg::User")

    assert rows == [{"short_name": "run", "function_signature": "run()", "start_line": 3}]
    assert "helper" not in {row["short_name"] for row in rows}


def _prepared(template: QueryTemplate, field: ConditionField, value: str):
    return PreparedNodeQueryBuilder.build(
        "test", template, (QueryCondition(field, ConditionOperator.EQ, value),)
    )


def test_offset_without_limit_uses_valid_sqlite_syntax(repository: CodeGraphAnalysisRepository) -> None:
    query = PreparedNodeQueryBuilder.build("functions_all", QueryTemplate.FUNCTIONS_BY_FILE)
    rows = repository.execute_function_query(query, offset=1)
    assert len(rows) == 3
    assert rows[0]["short_name"] == "helper"


def test_named_sql_loader_has_expected_semantic_templates(repository: CodeGraphAnalysisRepository) -> None:
    generic_templates = {template.value for template in QueryTemplate}
    interface_templates = {
        "interface_implement_by_fqcn",
        "interface_implement_by_short_name",
        "interface_only_implement_by_fqcn",
        "interface_only_implement_by_short_name",
    }
    import_templates = {
        "import_nodes_by_file",
        "import_nodes_by_file_suffix",
    }
    assert set(repository._statements) == (
        generic_templates | interface_templates | import_templates
    )
    assert all(
        repository._statements[name].count("{conditions}") == 1
        for name in generic_templates
    )
    assert all(
        "{conditions}" not in repository._statements[name]
        for name in interface_templates | import_templates
    )


def test_import_nodes_query_uses_exact_or_suffix_file_path(
    repository: CodeGraphAnalysisRepository,
) -> None:
    exact = repository.find_import_nodes_by_file(
        "src/Example.java",
        fuzzy_match=False,
    )
    fuzzy = repository.find_import_nodes_by_file(
        "src/Example.java",
        fuzzy_match=True,
    )

    assert [row["name"] for row in exact] == ["java.util.List"]
    assert [row["name"] for row in fuzzy] == ["pkg.Helper", "java.util.List"]


def test_import_nodes_query_applies_bound_limit(
    repository: CodeGraphAnalysisRepository,
) -> None:
    rows = repository.find_import_nodes_by_file(
        "src/Example.java",
        fuzzy_match=True,
        limit=1,
    )

    assert len(rows) == 1


def test_repository_rejects_forged_prepared_conditions(
    repository: CodeGraphAnalysisRepository,
) -> None:
    forged = PreparedNodeQuery(
        "forged",
        QueryTemplate.FUNCTION_SEARCH,
        ("function", "method"),
        "name = ? OR 1 = 1",
        ("helper",),
    )

    with pytest.raises(ValueError, match="必须由 PreparedNodeQueryBuilder 构造"):
        repository.execute_function_query(forged)


def test_repository_consumes_prepared_query_only(repository: CodeGraphAnalysisRepository) -> None:
    query = _prepared(QueryTemplate.FUNCTION_SEARCH, ConditionField.NAME, "helper")
    rows = repository.execute_function_query(query)
    assert [row["short_name"] for row in rows] == ["helper", "helper"]


def test_exact_queries_use_expected_indexes(repository: CodeGraphAnalysisRepository) -> None:
    connection = repository._get_connection()
    function_query = _prepared(QueryTemplate.FUNCTION_SEARCH, ConditionField.QUALIFIED_NAME, "pkg::helper")
    file_query = _prepared(QueryTemplate.FUNCTIONS_BY_FILE, ConditionField.FILE_PATH, "src/helper.py")
    function_sql = repository._statements[function_query.template.value].replace("{conditions}", function_query.conditions_sql)
    file_sql = repository._statements[file_query.template.value].replace("{conditions}", file_query.conditions_sql)
    function_plan = connection.execute(function_sql.replace("SELECT id, kind, name, qualified_name, signature, return_type, file_path, start_line, start_column, end_line, end_column", "EXPLAIN QUERY PLAN SELECT id"), (*function_query.kinds, *function_query.condition_params)).fetchall()
    file_plan = connection.execute(file_sql.replace("SELECT id, kind, name, qualified_name, signature, return_type, file_path, start_line, start_column, end_line, end_column", "EXPLAIN QUERY PLAN SELECT id"), (*file_query.kinds, *file_query.condition_params)).fetchall()
    assert any("idx_nodes_qualified_name" in str(row[3]) for row in function_plan)
    assert any("idx_nodes_file_path" in str(row[3]) for row in file_plan)

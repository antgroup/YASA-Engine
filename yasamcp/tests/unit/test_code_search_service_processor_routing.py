from __future__ import annotations

import inspect
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest

from yasa_mcp.core.cache_status import CacheStatusMask
from yasa_mcp.service import code_search_service


@pytest.fixture
def cached_context(tmp_path: Path) -> MagicMock:
    context = MagicMock()
    context.project_path = tmp_path
    context.is_cache_ready.side_effect = lambda mask: mask in (
        CacheStatusMask.REPO,
        CacheStatusMask.ALL,
    )
    return context


def _function_row(file_path: str = "src/Example.py") -> dict[str, object]:
    return {
        "function_fqn": "pkg::Example::run",
        "function_signature": "run()",
        "file_path": file_path,
        "start_line": 1,
        "start_column": 0,
        "end_line": 2,
        "end_column": 0,
    }


@pytest.mark.anyio
async def test_cached_class_name_uses_request_scoped_processor(
    monkeypatch: pytest.MonkeyPatch,
    cached_context: MagicMock,
) -> None:
    repository = object()
    processor = MagicMock()
    processor.search.return_value = [
        {
            "class_fqn": "pkg::Example",
            "file_path": "src/Example.py",
            "start_line": 1,
            "start_column": 0,
            "end_line": 2,
            "end_column": 0,
        }
    ]
    factory = MagicMock(return_value=processor)
    monkeypatch.setattr(code_search_service, "_get_codegraph_repo_or_warn", lambda context: repository)
    monkeypatch.setattr(code_search_service, "ClassAnalysisProcessor", factory)
    monkeypatch.setattr(code_search_service.file_util, "get_file_content_by_location", lambda *args: "class Example: pass")

    result = await code_search_service.get_class_by_name(
        cached_context,
        name="Example",
        class_fqn="pkg.Example",
        max_results=2,
    )

    factory.assert_called_once_with(
        repository,
        name="Example",
        class_fqn="pkg.Example",
        use_regex=False,
    )
    processor.search.assert_called_once_with(limit=2, offset=0)
    assert result.results[0].class_fqn == "pkg::Example"


@pytest.mark.anyio
async def test_cached_function_name_uses_request_scoped_processor(
    monkeypatch: pytest.MonkeyPatch,
    cached_context: MagicMock,
) -> None:
    repository = object()
    processor = MagicMock()
    processor.search.return_value = [_function_row()]
    factory = MagicMock(return_value=processor)
    monkeypatch.setattr(code_search_service, "_get_codegraph_repo_or_warn", lambda context: repository)
    monkeypatch.setattr(code_search_service, "FunctionAnalysisProcessor", factory)
    monkeypatch.setattr(code_search_service.file_util, "get_file_content_by_location", lambda *args: "def run(): pass")
    monkeypatch.setattr(code_search_service, "extract_annotations", lambda *args: ([], []))

    result = await code_search_service.get_function_by_name(
        cached_context,
        name="run",
        function_fqn="pkg.Example.run",
        max_results=3,
    )

    factory.assert_called_once_with(
        repository,
        project_path=cached_context.project_path,
        name="run",
        function_fqn="pkg.Example.run",
        use_regex=False,
    )
    processor.search.assert_called_once_with(limit=3, offset=0)
    assert result.results[0].function_fqn == "pkg::Example::run"


@pytest.mark.anyio
async def test_cached_function_file_uses_processor_but_file_search_boundary_is_unchanged(
    monkeypatch: pytest.MonkeyPatch,
    cached_context: MagicMock,
) -> None:
    repository = object()
    processor = MagicMock()
    processor.search_file.return_value = [_function_row()]
    factory = MagicMock()
    factory.for_file.return_value = processor
    monkeypatch.setattr(code_search_service, "_get_codegraph_repo_or_warn", lambda context: repository)
    monkeypatch.setattr(code_search_service, "FunctionAnalysisProcessor", factory)
    monkeypatch.setattr(code_search_service, "extract_annotations", lambda *args: ([], []))

    result = await code_search_service.get_function_by_file(
        cached_context,
        file_path="src/Example.py",
        max_results=5,
    )

    factory.for_file.assert_called_once_with(
        repository,
        cached_context.project_path,
        "src/Example.py",
        use_regex=False,
    )
    processor.search_file.assert_called_once_with(limit=5, offset=0)
    assert result.results[0].content == ""

    ripgrep = MagicMock()
    ripgrep.search_keyword_with_line.return_value = []
    cached_context.get_tool.return_value = ripgrep
    await code_search_service.get_file_by_keyword(cached_context, keyword="needle")
    factory.assert_not_called()
    ripgrep.search_keyword_with_line.assert_called_once()


@pytest.mark.anyio
@pytest.mark.xfail(reason="get_function_by_name 已聚合为 get_function")
async def test_server_function_route_forwards_public_arguments(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from yasa_mcp import server

    context = MagicMock()
    service = AsyncMock(return_value="sentinel")
    monkeypatch.setattr(server, "get_project_context", lambda project_path=None: context)
    monkeypatch.setattr(server.code_search_service, "get_function_by_name", service)
    route = server.get_function_by_name
    if not callable(route):
        route = route.fn

    result = route(
        ctx=MagicMock(),
        name="run",
        function_fqn="pkg.Example.run",
        function_signature="",
        use_regex=True,
        offset=2,
        max_results=4,
        max_output_tokens=128,
    )
    if inspect.isawaitable(result):
        result = await result

    assert result == "sentinel"
    context.set_default_task.assert_called_once_with()
    service.assert_awaited_once_with(
        context,
        name="run",
        function_fqn="pkg.Example.run",
        function_signature="",
        use_regex=True,
        offset=2,
        max_results=4,
        max_output_tokens=128,
    )


@pytest.mark.anyio
async def test_server_import_route_forwards_context_to_code_search_service(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from yasa_mcp import server

    context = MagicMock()
    service = AsyncMock(return_value="sentinel")
    monkeypatch.setattr(server, "get_project_context", lambda project_path=None: context)
    monkeypatch.setattr(server.code_search_service, "get_import_by_file", service)
    route = server.get_import_by_file
    if not callable(route):
        route = route.fn

    result = route(
        ctx=MagicMock(),
        project_path="/tmp/proj",
        file_path="src/A.java",
        fuzzy_match=False,
        exclude_external_import=True,
        max_results=3,
        max_output_tokens=64,
    )
    if inspect.isawaitable(result):
        result = await result

    assert result == "sentinel"
    context.set_default_task.assert_called_once_with()
    service.assert_awaited_once_with(
        context=context,
        file_path="src/A.java",
        fuzzy_match=False,
        exclude_external_import=True,
        max_results=3,
        max_output_tokens=64,
    )

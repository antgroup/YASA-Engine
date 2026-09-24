"""search_symbol FTS recall, semantic routing and interface expansion tests."""

from pathlib import Path

import pytest

from yasa_mcp.core.cache_status import CacheStatusMask
from yasa_mcp.core.context import YasaMcpContext
from yasa_mcp.service import code_search_service
from yasa_mcp.util.codegraph_param_util import CodeGraphParamUtil


def _context(tmp_path: Path) -> YasaMcpContext:
    return YasaMcpContext(project_path=tmp_path, cache_status=CacheStatusMask.ALL)


def _node(
    node_id: str,
    kind: str,
    name: str,
    qualified_name: str,
    file_path: str,
    start_line: int = 1,
    score: float = -10.0,
) -> dict:
    return {
        "id": node_id,
        "kind": kind,
        "name": name,
        "qualified_name": qualified_name,
        "file_path": file_path,
        "language": "python",
        "start_line": start_line,
        "start_column": 0,
        "end_line": start_line + 1,
        "end_column": 0,
        "signature": "",
        "score": score,
    }


class _SymbolRepository:
    """模拟 repository，FTS 召回返回 rows，接口实现查询返回固定记录。"""

    # _IMPL_RECORD 模拟 InterfaceImplementationProcessor 返回的一条接口实现记录。
    # 接口类 IFoo 的实现类 FooImpl，实现方法 run。
    _IMPL_RECORD = {
        "interface_id": "iface",
        "interface_name": "IFoo",
        "interface_fqn": "pkg::IFoo",
        "implementation_class_id": "impl-class",
        "implementation_class_name": "FooImpl",
        "implementation_class_fqn": "pkg::FooImpl",
        "implementation_method_id": "impl-method",
        "function_fqn": "pkg::FooImpl::run",
        "short_name": "run",
        "function_signature": "run()",
        "return_type": "void",
        "language": "python",
        "file_path": "foo_impl.py",
        "start_line": 5,
        "start_column": 0,
        "end_line": 7,
        "end_column": 0,
        "implements_metadata": "",
        "implements_provenance": "",
        "implementation_class_file_path": "foo_impl.py",
        "implementation_class_start_line": 1,
        "implementation_class_start_column": 0,
        "implementation_class_end_line": 10,
        "implementation_class_end_column": 0,
        "implementation_class_language": "python",
    }

    def __init__(self, rows: list[dict]):
        self.rows = rows
        self.matches: list[str] = []
        self.call_options: list[tuple[int, int]] = []

    def search_symbol_nodes(self, match_query: str, *, limit: int = 0, offset: int = 0) -> list[dict]:
        self.matches.append(match_query)
        self.call_options.append((limit, offset))
        return self.rows

    def find_interface_implementations(self, **_kwargs):
        return [self._IMPL_RECORD]


@pytest.mark.anyio
async def test_search_symbol_filters_all_node_recall_by_semantic_kind(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    (tmp_path / "foo.py").write_text("class Foo:\n    pass\n", encoding="utf-8")
    repository = _SymbolRepository(
        [
            _node("class", "class", "Foo", "pkg::Foo", "foo.py"),
            _node("method", "method", "run", "pkg::Foo::run", "foo.py", 4),
            _node("file", "file", "foo.py", "foo.py", "foo.py"),
            _node("field", "field", "run", "pkg::Foo::run_field", "foo.py", 8),
        ]
    )
    monkeypatch.setattr(code_search_service, "get_codegraph_repository", lambda _ctx: repository)

    class_results = await code_search_service.search_symbol(_context(tmp_path), "Foo", "class")
    function_results = await code_search_service.search_symbol(_context(tmp_path), "run", "function")
    file_results = await code_search_service.search_symbol(_context(tmp_path), "foo.py", "file")

    assert [item.name for item in class_results.results] == ["Foo"]
    assert [item.name for item in function_results.results] == ["run"]
    assert [item.name for item in file_results.results] == ["foo.py"]
    assert all("kind" not in query.lower() for query in repository.matches)


@pytest.mark.anyio
async def test_search_symbol_interface_class_expand_to_implementation_classes(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """搜索命中接口类时，返回接口声明和实现类。"""
    (tmp_path / "foo.py").write_text("interface IFoo:\n    pass\n", encoding="utf-8")
    (tmp_path / "foo_impl.py").write_text("class FooImpl:\n    pass\n", encoding="utf-8")
    repository = _SymbolRepository(
        [_node("iface", "interface", "IFoo", "pkg::IFoo", "foo.py")]
    )
    monkeypatch.setattr(code_search_service, "get_codegraph_repository", lambda _ctx: repository)

    result = await code_search_service.search_symbol(_context(tmp_path), "IFoo")

    names = {item.qualified_name for item in result.results}
    assert "pkg::IFoo" in names
    assert "pkg::FooImpl" in names


@pytest.mark.anyio
async def test_search_symbol_interface_method_expand_to_implementation_methods(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """搜索命中接口方法时，返回声明和实现方法。"""
    (tmp_path / "foo.py").write_text("interface IFoo:\n    def run(self): pass\n", encoding="utf-8")
    (tmp_path / "foo_impl.py").write_text("class FooImpl:\n    def run(self): pass\n", encoding="utf-8")
    method_row = _node("iface-method", "method", "run", "pkg::IFoo::run", "foo.py", 2)
    interface_row = _node("iface", "interface", "IFoo", "pkg::IFoo", "foo.py")
    # FTS 应同时召回接口类和接口方法，这样接口方法才能被识别为接口函数
    repository = _SymbolRepository([interface_row, method_row])
    monkeypatch.setattr(code_search_service, "get_codegraph_repository", lambda _ctx: repository)

    result = await code_search_service.search_symbol(_context(tmp_path), "IFoo.run")

    names = {item.qualified_name for item in result.results}
    assert "pkg::IFoo::run" in names
    assert "pkg::FooImpl::run" in names


@pytest.mark.anyio
async def test_search_symbol_non_interface_method_no_expansion(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """非接口方法不触发实现展开。"""
    (tmp_path / "foo.py").write_text("class Foo:\n    def run(self): pass\n", encoding="utf-8")
    repository = _SymbolRepository(
        [_node("m1", "method", "run", "pkg::Foo::run", "foo.py", 2)]
    )
    monkeypatch.setattr(code_search_service, "get_codegraph_repository", lambda _ctx: repository)

    result = await code_search_service.search_symbol(_context(tmp_path), "run")

    names = {item.qualified_name for item in result.results}
    assert names == {"pkg::Foo::run"}


def test_search_symbol_match_normalizes_fqn_separators_and_fts_operators() -> None:
    assert CodeGraphParamUtil.build_search_symbol_match("pkg.Foo::run") == (
        '"pkg.Foo"* OR "run"*'
    )
    assert CodeGraphParamUtil.build_search_symbol_match("run AND *") == '"run"*'


@pytest.mark.anyio
async def test_search_symbol_passes_paging_to_fts_repository(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    repository = _SymbolRepository([_node("file", "file", "foo.py", "foo.py", "foo.py")])
    monkeypatch.setattr(code_search_service, "get_codegraph_repository", lambda _ctx: repository)

    await code_search_service.search_symbol(
        _context(tmp_path), "foo.py", "file", offset=3, max_results=2
    )

    assert repository.call_options == [(100, 3)]

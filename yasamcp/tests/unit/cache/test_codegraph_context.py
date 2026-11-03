import sqlite3
from pathlib import Path

import pytest

from yasa_mcp.core.exceptions import InvalidCacheError
from yasa_mcp.layout.cache_layout import CacheLayout
from yasa_mcp.tools.codegraph.codegraph_context import CodeGraphContext


class FakeCodeGraphTool:
    initialized = True

    def __init__(self, status, *, on_init=None, on_sync=None):
        self._status = status
        self._on_init = on_init
        self._on_sync = on_sync
        self.calls = []

    def init_project(self, project_path: Path):
        self.calls.append(("init", project_path))
        if self._on_init is not None:
            self._on_init(project_path)

    def sync_project(self, project_path: Path):
        self.calls.append(("sync", project_path))
        if self._on_sync is not None:
            self._on_sync(project_path)

    def status(self, project_path: Path):
        self.calls.append(("status", project_path))
        return self._status


def _status(**overrides):
    value = {
        "initialized": True,
        "version": "1.2.0",
        "backend": "node-sqlite",
        "journalMode": "wal",
        "pendingChanges": {"added": 0, "modified": 0, "removed": 0},
        "fileCount": 1,
        "nodeCount": 1,
        "edgeCount": 1,
        "index": {
            "builtWithVersion": "1.2.0",
            "builtWithExtractionVersion": 24,
            "currentExtractionVersion": 24,
            "reindexRecommended": False,
        },
    }
    value.update(overrides)
    return value


def _create_codegraph_db(path: Path, include_all_tables: bool = True):
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    try:
        conn.execute("CREATE TABLE nodes(id INTEGER PRIMARY KEY)")
        if include_all_tables:
            conn.execute("CREATE TABLE edges(id INTEGER PRIMARY KEY)")
            conn.execute("CREATE TABLE files(id INTEGER PRIMARY KEY)")
            conn.execute("CREATE TABLE project_metadata(key TEXT, value TEXT)")
        conn.commit()
    finally:
        conn.close()


def _create_project_state(project_path: Path, marker: str = "fresh") -> None:
    state_dir = project_path / ".codegraph"
    _create_codegraph_db(state_dir / "codegraph.db")
    (state_dir / "state.json").write_text(marker)


def test_full_build_removes_old_state_and_publishes_complete_directory(tmp_path):
    project = tmp_path / "project"
    old_state = project / ".codegraph"
    old_state.mkdir(parents=True)
    (old_state / "old.txt").write_text("stale")

    def initialize(project_path: Path):
        assert not (project_path / ".codegraph").exists()
        _create_project_state(project_path)

    cache_layout = CacheLayout(root_path=tmp_path / "cache")
    tool = FakeCodeGraphTool(_status(), on_init=initialize)
    ctx = CodeGraphContext(tool, cache_layout)

    ctx.build_context(project)

    cache_dir = cache_layout.codegraph_cache.get_dir_path()
    assert (cache_dir / "state.json").read_text() == "fresh"
    assert not (cache_dir / "old.txt").exists()
    assert ctx.metadata["publish_method"] == "vacuum_into"
    assert ctx.metadata["vacuum_success"] is True
    assert ctx.metadata["sqlite_runtime_version"] == sqlite3.sqlite_version
    assert tool.calls == [("init", project), ("status", project)]


def test_full_build_unlinks_project_state_symlink_without_deleting_target(tmp_path):
    project = tmp_path / "project"
    project.mkdir()
    external = tmp_path / "external"
    external.mkdir()
    sentinel = external / "keep.txt"
    sentinel.write_text("keep")
    (project / ".codegraph").symlink_to(external, target_is_directory=True)

    def initialize(project_path: Path):
        assert not (project_path / ".codegraph").exists()
        assert sentinel.read_text() == "keep"
        _create_project_state(project_path)

    ctx = CodeGraphContext(
        FakeCodeGraphTool(_status(), on_init=initialize),
        CacheLayout(root_path=tmp_path / "cache"),
    )

    ctx.build_context(project)

    assert sentinel.read_text() == "keep"


def test_incremental_build_restores_complete_cache_before_sync(tmp_path):
    project = tmp_path / "project"
    dirty_dir = project / ".codegraph"
    dirty_dir.mkdir(parents=True)
    (dirty_dir / "dirty.txt").write_text("dirty")
    cache_layout = CacheLayout(root_path=tmp_path / "cache")
    cache_dir = cache_layout.codegraph_cache.get_dir_path()
    _create_codegraph_db(cache_dir / "codegraph.db")
    (cache_dir / "state.json").write_text("cached-state")

    def synchronize(project_path: Path):
        state_dir = project_path / ".codegraph"
        assert not (state_dir / "dirty.txt").exists()
        assert (state_dir / "state.json").read_text() == "cached-state"
        (state_dir / "state.json").write_text("synced-state")

    tool = FakeCodeGraphTool(_status(), on_sync=synchronize)
    ctx = CodeGraphContext(tool, cache_layout)

    ctx.build_context_use_incremental_mode(project)

    assert (cache_dir / "state.json").read_text() == "synced-state"
    assert tool.calls == [("sync", project), ("status", project)]


def test_incremental_invalid_cache_falls_back_to_full_build(tmp_path):
    project = tmp_path / "project"
    dirty_dir = project / ".codegraph"
    dirty_dir.mkdir(parents=True)
    (dirty_dir / "dirty.txt").write_text("dirty")
    cache_layout = CacheLayout(root_path=tmp_path / "cache")
    _create_codegraph_db(cache_layout.codegraph_cache.get_db_path(), include_all_tables=False)

    def initialize(project_path: Path):
        assert not (project_path / ".codegraph").exists()
        _create_project_state(project_path, marker="full-fallback")

    tool = FakeCodeGraphTool(_status(), on_init=initialize)
    ctx = CodeGraphContext(tool, cache_layout)

    ctx.build_context_use_incremental_mode(project)

    assert tool.calls == [("init", project), ("status", project)]
    assert (cache_layout.codegraph_cache.get_dir_path() / "state.json").read_text() == "full-fallback"


def test_incremental_sync_failure_falls_back_to_full_build(tmp_path):
    project = tmp_path / "project"
    cache_layout = CacheLayout(root_path=tmp_path / "cache")
    cache_dir = cache_layout.codegraph_cache.get_dir_path()
    _create_codegraph_db(cache_dir / "codegraph.db")
    (cache_dir / "state.json").write_text("cached-state")

    def fail_sync(project_path: Path):
        raise RuntimeError("sync failed")

    def initialize(project_path: Path):
        assert not (project_path / ".codegraph").exists()
        _create_project_state(project_path, marker="full-after-sync-failure")

    tool = FakeCodeGraphTool(_status(), on_sync=fail_sync, on_init=initialize)
    ctx = CodeGraphContext(tool, cache_layout)

    ctx.build_context_use_incremental_mode(project)

    assert tool.calls == [("sync", project), ("init", project), ("status", project)]
    assert (cache_dir / "state.json").read_text() == "full-after-sync-failure"


def test_incremental_and_full_fallback_failure_reports_both_errors(tmp_path):
    project = tmp_path / "project"
    cache_layout = CacheLayout(root_path=tmp_path / "cache")
    _create_codegraph_db(cache_layout.codegraph_cache.get_db_path())

    def fail_sync(project_path: Path):
        raise RuntimeError("sync failed")

    def fail_init(project_path: Path):
        raise RuntimeError("init failed")

    tool = FakeCodeGraphTool(_status(), on_sync=fail_sync, on_init=fail_init)
    ctx = CodeGraphContext(tool, cache_layout)

    with pytest.raises(InvalidCacheError) as exc_info:
        ctx.build_context_use_incremental_mode(project)

    message = str(exc_info.value)
    assert "sync failed" in message
    assert "init failed" in message
    assert tool.calls == [("sync", project), ("init", project)]


def test_vacuum_failure_falls_back_to_complete_directory_copy(tmp_path, monkeypatch):
    project = tmp_path / "project"
    cache_layout = CacheLayout(root_path=tmp_path / "cache")

    def initialize(project_path: Path):
        _create_project_state(project_path, marker="fallback-state")

    ctx = CodeGraphContext(FakeCodeGraphTool(_status(), on_init=initialize), cache_layout)

    def fail_vacuum(source_db, consumer_db):
        consumer_db.write_text("partial")
        raise sqlite3.OperationalError('near "INTO": syntax error')

    monkeypatch.setattr(ctx, "_vacuum_into_consumer", fail_vacuum)

    ctx.build_context(project)

    cache_dir = cache_layout.codegraph_cache.get_dir_path()
    assert (cache_dir / "state.json").read_text() == "fallback-state"
    sqlite3.connect(cache_dir / "codegraph.db").execute("SELECT COUNT(*) FROM nodes").fetchone()
    assert ctx.metadata["publish_method"] == "directory_copy_fallback"
    assert ctx.metadata["vacuum_success"] is False
    assert "near" in ctx.metadata["vacuum_error"]


def test_fallback_failure_preserves_existing_cache(tmp_path, monkeypatch):
    project = tmp_path / "project"
    cache_layout = CacheLayout(root_path=tmp_path / "cache")
    cache_dir = cache_layout.codegraph_cache.get_dir_path()
    _create_codegraph_db(cache_dir / "codegraph.db")
    (cache_dir / "state.json").write_text("old-cache")

    def initialize(project_path: Path):
        _create_project_state(project_path, marker="new-cache")

    ctx = CodeGraphContext(FakeCodeGraphTool(_status(), on_init=initialize), cache_layout)
    monkeypatch.setattr(
        ctx,
        "_vacuum_into_consumer",
        lambda source_db, consumer_db: (_ for _ in ()).throw(sqlite3.OperationalError("unsupported")),
    )
    original_copytree = __import__("shutil").copytree
    copy_count = 0

    def fail_second_copy(source, target, *args, **kwargs):
        nonlocal copy_count
        copy_count += 1
        if copy_count == 2:
            raise OSError("fallback copy failed")
        return original_copytree(source, target, *args, **kwargs)

    monkeypatch.setattr("yasa_mcp.tools.codegraph.codegraph_context.shutil.copytree", fail_second_copy)

    with pytest.raises(InvalidCacheError, match="fallback copy failed"):
        ctx.build_context(project)

    assert (cache_dir / "state.json").read_text() == "old-cache"
    assert not cache_layout.codegraph_cache.get_staging_dir_path().exists()
    assert ctx.metadata == {}


def test_build_context_rejects_pending_changes_without_replacing_cache(tmp_path):
    project = tmp_path / "project"
    cache_layout = CacheLayout(root_path=tmp_path / "cache")
    cache_dir = cache_layout.codegraph_cache.get_dir_path()
    _create_codegraph_db(cache_dir / "codegraph.db")
    (cache_dir / "state.json").write_text("old-cache")

    ctx = CodeGraphContext(
        FakeCodeGraphTool(
            _status(pendingChanges={"added": 1, "modified": 0, "removed": 0}),
            on_init=_create_project_state,
        ),
        cache_layout,
    )

    with pytest.raises(InvalidCacheError, match="pending changes"):
        ctx.build_context(project)

    assert (cache_dir / "state.json").read_text() == "old-cache"
    assert ctx.metadata == {}


def test_load_context_from_cache_validates_required_tables_without_deleting_source(tmp_path):
    cache_layout = CacheLayout(root_path=tmp_path / "cache")
    db_path = cache_layout.codegraph_cache.get_db_path()
    _create_codegraph_db(db_path, include_all_tables=False)
    ctx = CodeGraphContext(None, cache_layout)

    with pytest.raises(InvalidCacheError):
        ctx.load_context_from_cache()

    assert not db_path.exists()

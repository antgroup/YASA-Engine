"""FolderFingerprint 差异计算 (compute_cache_diff / diff_out) 单元测试。"""
from pathlib import Path

from yasa_mcp.util.fingerprint_util import FolderFingerprint


def _entry(h: str, size: int = 1, sampled: str = "s") -> dict:
    return {"size": size, "sampled_hash": sampled, "hash": h}


class TestComputeCacheDiff:
    def test_added_removed_changed_all_collected(self):
        old = {
            "a/keep.java": _entry("h1"),
            "a/removed.java": _entry("h2"),
            "a/changed.java": _entry("h3"),
        }
        new = {
            "a/keep.java": _entry("h1"),
            "a/changed.java": _entry("hX"),  # 内容变化
            "a/added.java": _entry("h4"),     # 新增
        }
        diffs = FolderFingerprint.compute_cache_diff(old, new)
        by_rel = {rel: (kind, old_h, new_h) for kind, rel, old_h, new_h in diffs}

        assert "a/added.java" in by_rel and by_rel["a/added.java"][0] == "added"
        assert by_rel["a/added.java"][2] == "h4"  # new_hash
        assert "a/removed.java" in by_rel and by_rel["a/removed.java"][0] == "removed"
        assert by_rel["a/removed.java"][1] == "h2"  # old_hash
        assert "a/changed.java" in by_rel and by_rel["a/changed.java"][0] == "changed"
        assert by_rel["a/changed.java"] == ("changed", "h3", "hX")
        # 未变化文件不出现
        assert "a/keep.java" not in by_rel

    def test_stable_sorted_by_rel_path(self):
        old = {"zzz.java": _entry("1"), "aaa.java": _entry("2")}
        new = {"zzz.java": _entry("9"), "aaa.java": _entry("8")}
        diffs = FolderFingerprint.compute_cache_diff(old, new)
        rels = [d[1] for d in diffs]
        assert rels == sorted(rels)
        assert rels == ["aaa.java", "zzz.java"]

    def test_empty_inputs(self):
        assert FolderFingerprint.compute_cache_diff({}, {}) == []
        assert FolderFingerprint.compute_cache_diff(None, None) == []


class TestCalculateIncrementalDiffOut:
    def test_diff_out_collects_added_file(self, tmp_path):
        """第二次调用时新增一个文件，diff_out 应捕获 added，且两次 overall hash 不同。"""
        root = tmp_path / "repo"
        (root / "d").mkdir(parents=True)
        (root / "d" / "a.java").write_text("class A {}")
        cache_path = tmp_path / "fp.json"

        diff1 = []
        h1 = FolderFingerprint.calculate_incremental(root, cache_path, diff_out=diff1)
        # 首次：旧缓存为空，全部算 added；缓存已落盘
        assert diff1  # 首次每个文件相对空旧缓存都是 "added"
        assert all(k == "added" for k, *_ in diff1)

        # 新增文件
        (root / "d" / "b.java").write_text("class B {}")
        diff2 = []
        h2 = FolderFingerprint.calculate_incremental(root, cache_path, diff_out=diff2)
        assert h1 != h2
        added_rels = [rel for kind, rel, *_ in diff2 if kind == "added"]
        assert "d/b.java" in added_rels
        # 原有文件不应出现在 diff2（内容未变）
        assert "d/a.java" not in [rel for _, rel, *_ in diff2]

    def test_no_diff_out_means_no_collection(self, tmp_path):
        """不传 diff_out 时行为完全不变，正常返回 hash。"""
        root = tmp_path / "repo2"
        (root / "d").mkdir(parents=True)
        (root / "d" / "a.java").write_text("class A {}")
        cache_path = tmp_path / "fp2.json"
        h = FolderFingerprint.calculate_incremental(root, cache_path)
        assert isinstance(h, str) and len(h) == 32
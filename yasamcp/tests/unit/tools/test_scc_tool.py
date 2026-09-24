"""SccTool 单元测试。"""

import json
import subprocess
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from yasa_mcp.core.enums import Language, Tool
from yasa_mcp.tools.scc.scc_bin_layout import SccBinaryLayout
from yasa_mcp.tools.scc.scc_tool import SccTool


# ── SccBinaryLayout ──────────────────────────────────────────


class TestSccBinaryLayout:
    def test_scc_bin_path(self, tmp_path):
        """scc_bin 应指向 root_path / 'scc'。"""
        scc_dir = tmp_path / "scc"
        scc_dir.mkdir()
        scc_bin = scc_dir / "scc"
        scc_bin.touch()

        layout = SccBinaryLayout(root_path=scc_dir)
        assert layout.scc_bin == scc_bin.resolve()

    def test_scc_bin_path_not_exist(self, tmp_path):
        """root_path 下没有 scc 二进制时，validate_path 应抛异常。"""
        from yasa_mcp.core.exceptions import FileNotFoundError as YasaFileNotFoundError

        scc_dir = tmp_path / "scc"
        scc_dir.mkdir()
        # 不创建 scc 二进制文件

        layout = SccBinaryLayout(root_path=scc_dir)
        with pytest.raises(YasaFileNotFoundError):
            _ = layout.scc_bin


# ── SccTool.check_available ──────────────────────────────────


class TestSccToolCheckAvailable:
    def test_available(self, tmp_path):
        """check_binary_available 返回 True 时，initialized 为 True。"""
        scc_dir = tmp_path / "scc"
        scc_dir.mkdir()
        scc_bin = scc_dir / "scc"
        scc_bin.touch()
        layout = SccBinaryLayout(root_path=scc_dir)

        with patch("yasa_mcp.tools.scc.scc_tool.command_util.check_binary_available", return_value=True):
            tool = SccTool(layout)
        assert tool.initialized is True

    def test_not_available(self, tmp_path):
        """check_binary_available 返回 False 时，initialized 为 False。"""
        scc_dir = tmp_path / "scc"
        scc_dir.mkdir()
        scc_bin = scc_dir / "scc"
        scc_bin.touch()
        layout = SccBinaryLayout(root_path=scc_dir)

        with patch("yasa_mcp.tools.scc.scc_tool.command_util.check_binary_available", return_value=False):
            tool = SccTool(layout)
        assert tool.initialized is False


# ── SccTool.detect_languages ─────────────────────────────────


def _make_scc_tool(tmp_path) -> SccTool:
    """构造一个 mock 过 check_available 的 SccTool 实例。"""
    scc_dir = tmp_path / "scc"
    scc_dir.mkdir(exist_ok=True)
    scc_bin = scc_dir / "scc"
    scc_bin.touch()
    layout = SccBinaryLayout(root_path=scc_dir)
    with patch("yasa_mcp.tools.scc.scc_tool.command_util.check_binary_available", return_value=True):
        return SccTool(layout)


class TestDetectLanguages:
    def test_excludes_codegraph_directory(self, tmp_path):
        """scc 参数应默认排除 .codegraph 目录。"""
        tool = _make_scc_tool(tmp_path)
        mock_result = subprocess.CompletedProcess(args=[], returncode=0, stdout="[]", stderr="")

        with patch("yasa_mcp.tools.scc.scc_tool.command_util.run_binary", return_value=mock_result) as mock_run:
            tool.detect_languages(Path("/fake/project"))

        _, args = mock_run.call_args[0]
        exclude_dirs = args[args.index("--exclude-dir") + 1]
        assert ".codegraph" in exclude_dirs.split(",")

    def test_normal_parse(self, tmp_path):
        """正常 scc JSON 输出应按 Count 降序返回已识别的 Language。"""
        tool = _make_scc_tool(tmp_path)
        scc_output = json.dumps([
            {"Name": "Java", "Count": 200, "Code": 50000},
            {"Name": "Python", "Count": 80, "Code": 12000},
            {"Name": "Markdown", "Count": 30, "Code": 3000},
        ])
        mock_result = subprocess.CompletedProcess(args=[], returncode=0, stdout=scc_output, stderr="")

        with patch("yasa_mcp.tools.scc.scc_tool.command_util.run_binary", return_value=mock_result):
            result = tool.detect_languages(Path("/fake/project"))

        # Markdown 不在 Language 枚举中，应被跳过
        assert result == [Language.JAVA, Language.PYTHON]

    def test_php_language_mapping(self, tmp_path):
        """PHP 应直接映射为 Language.PHP。"""
        tool = _make_scc_tool(tmp_path)
        scc_output = json.dumps([
            {"Name": "PHP", "Count": 113, "Code": 5769},
            {"Name": "SQL", "Count": 6, "Code": 155},
        ])
        mock_result = subprocess.CompletedProcess(args=[], returncode=0, stdout=scc_output, stderr="")

        with patch("yasa_mcp.tools.scc.scc_tool.command_util.run_binary", return_value=mock_result):
            result = tool.detect_languages(Path("/fake/project"))

        assert result == [Language.PHP]

    def test_go_language_mapping(self, tmp_path):
        """Go 应映射为 Language.GO (golang)。"""
        tool = _make_scc_tool(tmp_path)
        scc_output = json.dumps([
            {"Name": "Go", "Count": 100, "Code": 20000},
            {"Name": "Java", "Count": 50, "Code": 10000},
        ])
        mock_result = subprocess.CompletedProcess(args=[], returncode=0, stdout=scc_output, stderr="")

        with patch("yasa_mcp.tools.scc.scc_tool.command_util.run_binary", return_value=mock_result):
            result = tool.detect_languages(Path("/fake/project"))

        assert result == [Language.GO, Language.JAVA]

    def test_run_binary_exception_returns_empty(self, tmp_path):
        """run_binary 抛异常时应返回空列表。"""
        tool = _make_scc_tool(tmp_path)

        with patch("yasa_mcp.tools.scc.scc_tool.command_util.run_binary", side_effect=Exception("timeout")):
            result = tool.detect_languages(Path("/fake/project"))

        assert result == []

    def test_nonzero_returncode_returns_empty(self, tmp_path):
        """scc 返回非零 returncode 时应返回空列表。"""
        tool = _make_scc_tool(tmp_path)
        mock_result = subprocess.CompletedProcess(args=[], returncode=1, stdout="", stderr="error")

        with patch("yasa_mcp.tools.scc.scc_tool.command_util.run_binary", return_value=mock_result):
            result = tool.detect_languages(Path("/fake/project"))

        assert result == []

    def test_invalid_json_returns_empty(self, tmp_path):
        """stdout 不是合法 JSON 时应返回空列表。"""
        tool = _make_scc_tool(tmp_path)
        mock_result = subprocess.CompletedProcess(args=[], returncode=0, stdout="not json", stderr="")

        with patch("yasa_mcp.tools.scc.scc_tool.command_util.run_binary", return_value=mock_result):
            result = tool.detect_languages(Path("/fake/project"))

        assert result == []

    def test_empty_stdout_returns_empty(self, tmp_path):
        """stdout 为空时应返回空列表。"""
        tool = _make_scc_tool(tmp_path)
        mock_result = subprocess.CompletedProcess(args=[], returncode=0, stdout="", stderr="")

        with patch("yasa_mcp.tools.scc.scc_tool.command_util.run_binary", return_value=mock_result):
            result = tool.detect_languages(Path("/fake/project"))

        assert result == []

    def test_count_ordering(self, tmp_path):
        """返回结果应按 Count 降序排列。"""
        tool = _make_scc_tool(tmp_path)
        scc_output = json.dumps([
            {"Name": "Python", "Count": 30, "Code": 5000},
            {"Name": "Java", "Count": 200, "Code": 50000},
            {"Name": "JavaScript", "Count": 100, "Code": 20000},
        ])
        mock_result = subprocess.CompletedProcess(args=[], returncode=0, stdout=scc_output, stderr="")

        with patch("yasa_mcp.tools.scc.scc_tool.command_util.run_binary", return_value=mock_result):
            result = tool.detect_languages(Path("/fake/project"))

        assert result == [Language.JAVA, Language.JAVASCRIPT, Language.PYTHON]


# ── Language.try_parse ───────────────────────────────────────


class TestLanguageTryParse:
    def test_go_alias(self):
        """'Go' 应通过别名解析为 Language.GO。"""
        assert Language.try_parse("Go") == Language.GO

    def test_golang_direct(self):
        """'golang' 应直接解析为 Language.GO。"""
        assert Language.try_parse("golang") == Language.GO

    def test_case_insensitive(self):
        """解析应忽略大小写。"""
        assert Language.try_parse("JAVA") == Language.JAVA
        assert Language.try_parse("Python") == Language.PYTHON

    def test_js_alias(self):
        """'JS' 应通过别名解析为 Language.JAVASCRIPT。"""
        assert Language.try_parse("js") == Language.JAVASCRIPT

    def test_php_case_insensitive(self):
        """scc 输出的 'PHP' 应解析为 Language.PHP。"""
        assert Language.try_parse("PHP") == Language.PHP
        assert Language.from_string("php") == Language.PHP

    def test_unsupported_returns_none(self):
        """不支持的语言应返回 None。"""
        assert Language.try_parse("Markdown") is None
        assert Language.try_parse("Ruby") is None

    def test_detect_languages_uses_try_parse(self, tmp_path):
        """detect_languages 应通过 try_parse 正确解析语言名称。"""
        tool = _make_scc_tool(tmp_path)
        scc_output = json.dumps([
            {"Name": "JavaScript", "Count": 50, "Code": 8000},
        ])
        mock_result = subprocess.CompletedProcess(args=[], returncode=0, stdout=scc_output, stderr="")

        with patch("yasa_mcp.tools.scc.scc_tool.command_util.run_binary", return_value=mock_result):
            result = tool.detect_languages(Path("/fake/project"))

        assert result == [Language.JAVASCRIPT]


# ── resolve_languages 增强逻辑 ──────────────────────────────


class TestResolveLanguagesWithScc:
    """测试 resolve_languages 的 scc 增强逻辑。"""

    @patch("yasa_mcp.core.context_builder_facade.get_runtime")
    @patch("yasa_mcp.core.context_builder_facade.global_config")
    def test_scc_available_returns_primary_language(self, mock_config, mock_get_runtime):
        """scc 可用且检测到支持的语言时，应只返回主语言。"""
        from yasa_mcp.core.context_builder_facade import resolve_languages

        mock_config.support_languages = [Language.JAVA, Language.PYTHON]

        mock_scc_tool = MagicMock()
        mock_scc_tool.detect_languages.return_value = [Language.PYTHON, Language.JAVA]

        mock_runtime = MagicMock()
        mock_runtime.tools = {Tool.SCC: mock_scc_tool}
        mock_get_runtime.return_value = mock_runtime

        from_scc, result = resolve_languages(None, project_path=Path("/fake/project"))

        assert from_scc is True
        assert result == [Language.PYTHON]
        mock_scc_tool.detect_languages.assert_called_once_with(Path("/fake/project"))

    @patch("yasa_mcp.core.context_builder_facade.get_runtime")
    @patch("yasa_mcp.core.context_builder_facade.global_config")
    def test_scc_selects_first_supported_language(self, mock_config, mock_get_runtime):
        """应选择 scc 按文件数降序返回的第一个受支持语言。"""
        from yasa_mcp.core.context_builder_facade import resolve_languages

        mock_config.support_languages = [Language.JAVA, Language.PYTHON, Language.GO]

        mock_scc_tool = MagicMock()
        mock_scc_tool.detect_languages.return_value = [Language.PYTHON, Language.GO, Language.JAVA]

        mock_runtime = MagicMock()
        mock_runtime.tools = {Tool.SCC: mock_scc_tool}
        mock_get_runtime.return_value = mock_runtime

        from_scc, result = resolve_languages(None, project_path=Path("/fake/project"))

        assert from_scc is True
        assert result == [Language.PYTHON]

    @patch("yasa_mcp.core.context_builder_facade.get_runtime")
    @patch("yasa_mcp.core.context_builder_facade.global_config")
    def test_scc_intersection_filters_unsupported(self, mock_config, mock_get_runtime):
        """scc 检测到不在 supported 中的语言应被过滤。"""
        from yasa_mcp.core.context_builder_facade import resolve_languages

        mock_config.support_languages = [Language.JAVA]

        mock_scc_tool = MagicMock()
        mock_scc_tool.detect_languages.return_value = [Language.PYTHON, Language.JAVA]

        mock_runtime = MagicMock()
        mock_runtime.tools = {Tool.SCC: mock_scc_tool}
        mock_get_runtime.return_value = mock_runtime

        from_scc, result = resolve_languages(None, project_path=Path("/fake/project"))

        assert from_scc is True
        assert result == [Language.JAVA]

    @patch("yasa_mcp.core.context_builder_facade.get_runtime")
    @patch("yasa_mcp.core.context_builder_facade.global_config")
    def test_scc_empty_result_fallback(self, mock_config, mock_get_runtime):
        """scc 检测结果为空时，应 fallback (from_scc=False)。"""
        from yasa_mcp.core.context_builder_facade import resolve_languages

        mock_config.support_languages = [Language.JAVA, Language.PYTHON]

        mock_scc_tool = MagicMock()
        mock_scc_tool.detect_languages.return_value = []

        mock_runtime = MagicMock()
        mock_runtime.tools = {Tool.SCC: mock_scc_tool}
        mock_get_runtime.return_value = mock_runtime

        from_scc, result = resolve_languages(None, project_path=Path("/fake/project"))

        assert from_scc is False
        assert result == [Language.JAVA, Language.PYTHON]

    @patch("yasa_mcp.core.context_builder_facade.get_runtime")
    @patch("yasa_mcp.core.context_builder_facade.global_config")
    def test_scc_no_intersection_fallback(self, mock_config, mock_get_runtime):
        """scc 检测的语言都不在 supported 中时，应 fallback (from_scc=False)。"""
        from yasa_mcp.core.context_builder_facade import resolve_languages

        mock_config.support_languages = [Language.JAVA]

        mock_scc_tool = MagicMock()
        mock_scc_tool.detect_languages.return_value = [Language.GO]

        mock_runtime = MagicMock()
        mock_runtime.tools = {Tool.SCC: mock_scc_tool}
        mock_get_runtime.return_value = mock_runtime

        from_scc, result = resolve_languages(None, project_path=Path("/fake/project"))

        assert from_scc is False
        assert result == [Language.JAVA]

    @patch("yasa_mcp.core.context_builder_facade.get_runtime")
    @patch("yasa_mcp.core.context_builder_facade.global_config")
    def test_scc_tool_not_in_runtime_fallback(self, mock_config, mock_get_runtime):
        """runtime.tools 中没有 SCC 时，应 fallback (from_scc=False)。"""
        from yasa_mcp.core.context_builder_facade import resolve_languages

        mock_config.support_languages = [Language.JAVA, Language.PYTHON]

        mock_runtime = MagicMock()
        mock_runtime.tools = {}
        mock_get_runtime.return_value = mock_runtime

        from_scc, result = resolve_languages(None, project_path=Path("/fake/project"))

        assert from_scc is False
        assert result == [Language.JAVA, Language.PYTHON]

    @patch("yasa_mcp.core.context_builder_facade.global_config")
    def test_no_project_path_fallback(self, mock_config):
        """project_path 为 None 时，应直接走 fallback (from_scc=False)。"""
        from yasa_mcp.core.context_builder_facade import resolve_languages

        mock_config.support_languages = [Language.JAVA, Language.PYTHON]

        from_scc, result = resolve_languages(None, project_path=None)

        assert from_scc is False
        assert result == [Language.JAVA, Language.PYTHON]

    @patch("yasa_mcp.core.context_builder_facade.global_config")
    def test_explicit_language_param_returns_single(self, mock_config):
        """显式传入 language 参数时，应返回 (False, [该语言])。"""
        from yasa_mcp.core.context_builder_facade import resolve_languages

        mock_config.support_languages = [Language.JAVA, Language.PYTHON]

        from_scc, result = resolve_languages("java")

        assert from_scc is False
        assert result == [Language.JAVA]

    @patch("yasa_mcp.core.context_builder_facade.global_config")
    def test_unsupported_language_raises(self, mock_config):
        """传入不支持的语言时应抛出 LanguageNotSupportedError。"""
        from yasa_mcp.core.exceptions import LanguageNotSupportedError
        from yasa_mcp.core.context_builder_facade import resolve_languages

        mock_config.support_languages = [Language.JAVA]

        with pytest.raises(LanguageNotSupportedError):
            resolve_languages("ruby")

    @patch("yasa_mcp.core.context_builder_facade.get_runtime")
    @patch("yasa_mcp.core.context_builder_facade.global_config")
    def test_scc_empty_with_language_returns_single(self, mock_config, mock_get_runtime):
        """scc 返回空且 language 非空时，应返回 (False, [该语言])。"""
        from yasa_mcp.core.context_builder_facade import resolve_languages

        mock_config.support_languages = [Language.JAVA, Language.PYTHON]

        mock_scc_tool = MagicMock()
        mock_scc_tool.detect_languages.return_value = []

        mock_runtime = MagicMock()
        mock_runtime.tools = {Tool.SCC: mock_scc_tool}
        mock_get_runtime.return_value = mock_runtime

        from_scc, result = resolve_languages("java", project_path=Path("/fake/project"))

        assert from_scc is False
        assert result == [Language.JAVA]


# ── 真实项目语言检测 ─────────────────────────────────────────

# 请将下方两个路径替换为您本地的环境路径：
# - _REPOS_BASE：存放各语言 benchmark 仓库的根目录（其下应有 java/、python/ 等子目录，每个子目录含各仓库）
# - _SCC_BIN_DIR：scc 原生二进制所在目录（该目录下应有可执行的 scc）
_REPOS_BASE = Path("请替换为您的 benchmark 仓库根目录")
_SCC_BIN_DIR = Path("请替换为您的 scc 二进制所在目录")


def _make_real_scc_tool() -> SccTool | None:
    """构造连接真实 scc 二进制的 SccTool，不可用时返回 None。"""
    scc_bin = _SCC_BIN_DIR / "scc"
    if not scc_bin.exists():
        return None
    layout = SccBinaryLayout(root_path=_SCC_BIN_DIR)
    return SccTool(layout)


_JAVA_REPOS = [
    "bizfmcg_benckmark",
    "mrcheshop",
    "govbizprodsys_benchmark",
    "mecp",
    "accountprod_benchmark",
]

_PYTHON_REPOS = [
    "stanfordsimpy",
    "lscpython",
    "morse-mdn",
    "finstockagent",
    "chatbot_backend",
]


@pytest.mark.skipif(
    not (_SCC_BIN_DIR / "scc").exists(),
    reason="scc binary not available",
)
class TestRealProjectDetection:
    """使用真实 scc 二进制检测真实项目语言，验证准确性并记录耗时。"""

    @pytest.fixture(autouse=True)
    def _tool(self):
        self.tool = _make_real_scc_tool()

    @pytest.mark.parametrize("repo_name", _JAVA_REPOS)
    def test_java_repo(self, repo_name):
        """Java 仓库应检测到 Language.JAVA 为主语言（排序第一）。"""
        repo_path = _REPOS_BASE / "java" / repo_name
        if not repo_path.exists():
            pytest.skip(f"repo not found: {repo_path}")

        import time
        start = time.perf_counter()
        result = self.tool.detect_languages(repo_path)
        elapsed_ms = (time.perf_counter() - start) * 1000

        print(f"\n  {repo_name}: {[l.value for l in result]}, {elapsed_ms:.0f}ms")

        assert len(result) > 0, f"{repo_name}: no languages detected"
        assert result[0] == Language.JAVA, (
            f"{repo_name}: expected JAVA as primary, got {result[0].value}"
        )

    @pytest.mark.parametrize("repo_name", _PYTHON_REPOS)
    def test_python_repo(self, repo_name):
        """Python 仓库应检测到 Language.PYTHON 为主语言（排序第一）。"""
        repo_path = _REPOS_BASE / "python" / repo_name
        if not repo_path.exists():
            pytest.skip(f"repo not found: {repo_path}")

        import time
        start = time.perf_counter()
        result = self.tool.detect_languages(repo_path)
        elapsed_ms = (time.perf_counter() - start) * 1000

        print(f"\n  {repo_name}: {[l.value for l in result]}, {elapsed_ms:.0f}ms")

        assert len(result) > 0, f"{repo_name}: no languages detected"
        assert result[0] == Language.PYTHON, (
            f"{repo_name}: expected PYTHON as primary, got {result[0].value}"
        )


@pytest.mark.skipif(
    not (_SCC_BIN_DIR / "scc").exists(),
    reason="scc binary not available",
)
class TestExcludeDirPerformance:
    """对比有无 --exclude-dir/--not-match 参数的检测耗时，各跑 5 次取均值。"""

    _RUNS = 5

    _ALL_REPOS: list[tuple[str, str]] = [
        ("java", name) for name in _JAVA_REPOS
    ] + [
        ("python", name) for name in _PYTHON_REPOS
    ]

    def _run_scc_raw(self, scc_bin: Path, project_path: Path) -> float:
        """不带排除参数调用 scc，返回耗时 ms。"""
        from yasa_mcp.util import command_util as cmd_util
        import time
        start = time.perf_counter()
        cmd_util.run_binary(
            scc_bin,
            ["-c", "--no-cocomo", "--format", "json", str(project_path)],
            timeout=30,
        )
        return (time.perf_counter() - start) * 1000

    def _run_scc_filtered(self, scc_bin: Path, project_path: Path) -> float:
        """带排除参数调用 scc，返回耗时 ms。"""
        from yasa_mcp.tools.scc.scc_tool import _EXCLUDE_DIRS, _EXCLUDE_EXTENSIONS
        from yasa_mcp.util import command_util as cmd_util
        import time
        start = time.perf_counter()
        cmd_util.run_binary(
            scc_bin,
            [
                "-c", "--no-cocomo", "--format", "json",
                "--exclude-dir", ",".join(_EXCLUDE_DIRS),
                "--not-match", ",".join(_EXCLUDE_EXTENSIONS),
                str(project_path),
            ],
            timeout=30,
        )
        return (time.perf_counter() - start) * 1000

    def test_exclude_dir_benchmark(self):
        """对比 10 个真实仓库有无排除参数的耗时差异（5 次均值）。"""
        scc_bin = _SCC_BIN_DIR / "scc"

        results: list[dict] = []
        for lang, repo_name in self._ALL_REPOS:
            repo_path = _REPOS_BASE / lang / repo_name
            if not repo_path.exists():
                continue

            raw_times = [self._run_scc_raw(scc_bin, repo_path) for _ in range(self._RUNS)]
            filtered_times = [self._run_scc_filtered(scc_bin, repo_path) for _ in range(self._RUNS)]

            raw_avg = sum(raw_times) / len(raw_times)
            filtered_avg = sum(filtered_times) / len(filtered_times)
            speedup = ((raw_avg - filtered_avg) / raw_avg) * 100 if raw_avg > 0 else 0

            results.append({
                "repo": repo_name,
                "lang": lang,
                "raw_avg_ms": raw_avg,
                "filtered_avg_ms": filtered_avg,
                "speedup_pct": speedup,
            })

        # 打印对比表格
        print("\n")
        print(f"  {'仓库':<35} {'语言':<8} {'无排除(ms)':<12} {'有排除(ms)':<12} {'提升':<8}")
        print(f"  {'─' * 75}")
        for r in results:
            print(
                f"  {r['repo']:<35} {r['lang']:<8} "
                f"{r['raw_avg_ms']:<12.0f} {r['filtered_avg_ms']:<12.0f} "
                f"{r['speedup_pct']:>+.1f}%"
            )

        # 至少要有结果
        assert len(results) > 0, "no repos found for benchmark"

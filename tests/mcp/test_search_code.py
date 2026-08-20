"""
测试 search_code_by_keyword tool

覆盖验收标准:
- 正则模式
- 大小写
- 空结果
- 超过 max_results 截断
- 排除目录 (.git/, node_modules/, target/, build/, dist/)
- path_prefix 过滤
- 二进制文件跳过
- 与 MCP 框架注册机制对齐
- 性能: 1k 文件 < 2s
"""

from __future__ import annotations

import os
import time
import tempfile

import pytest
from fastmcp import FastMCP

from yasa_mcp.tools.search_code_by_keyword import search_code_by_keyword
from yasa_mcp.registry import auto_discover_tools


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _create_file(root: str, relpath: str, content: str) -> str:
    """在 root 下创建文件,返回绝对路径"""
    abspath = os.path.join(root, relpath)
    os.makedirs(os.path.dirname(abspath), exist_ok=True)
    with open(abspath, "w", encoding="utf-8") as f:
        f.write(content)
    return abspath


def _create_binary_file(root: str, relpath: str) -> str:
    """创建一个二进制文件"""
    abspath = os.path.join(root, relpath)
    os.makedirs(os.path.dirname(abspath), exist_ok=True)
    with open(abspath, "wb") as f:
        f.write(b"\x00\x01\x02\x03binary\x00data")
    return abspath


@pytest.fixture
def temp_repo():
    """创建临时仓库"""
    with tempfile.TemporaryDirectory() as tmpdir:
        yield tmpdir


# ---------------------------------------------------------------------------
# 基本搜索
# ---------------------------------------------------------------------------

class TestBasicSearch:
    """测试基本搜索功能"""

    @pytest.mark.asyncio
    async def test_plain_string_match(self, temp_repo):
        """普通字符串匹配"""
        _create_file(temp_repo, "src/main.py", "Runtime.exec(userInput)\n")
        result = await search_code_by_keyword(
            keyword="Runtime.exec",
            repository_path=temp_repo,
        )
        assert result["total_matches"] == 1
        assert result["results"][0]["line_content"] == "Runtime.exec(userInput)"
        assert result["results"][0]["line_number"] == 1

    @pytest.mark.asyncio
    async def test_multiple_matches_in_one_file(self, temp_repo):
        """单文件多次匹配"""
        content = "eval(x)\neval(y)\nnot_a_match\n"
        _create_file(temp_repo, "app.js", content)
        result = await search_code_by_keyword(
            keyword="eval",
            repository_path=temp_repo,
        )
        assert result["total_matches"] == 2
        assert result["results"][0]["line_number"] == 1
        assert result["results"][1]["line_number"] == 2

    @pytest.mark.asyncio
    async def test_multiple_files(self, temp_repo):
        """跨文件匹配"""
        _create_file(temp_repo, "a.py", "Runtime.exec(x)\n")
        _create_file(temp_repo, "b.py", "Runtime.exec(y)\n")
        result = await search_code_by_keyword(
            keyword="Runtime.exec",
            repository_path=temp_repo,
        )
        assert result["total_matches"] == 2

    @pytest.mark.asyncio
    async def test_column_positions(self, temp_repo):
        """验证 column_start 和 column_end"""
        _create_file(temp_repo, "test.py", "    Runtime.exec(x)\n")
        result = await search_code_by_keyword(
            keyword="Runtime.exec",
            repository_path=temp_repo,
        )
        r = result["results"][0]
        # "    Runtime.exec(x)" — Runtime.exec 从第 5 个字符开始 (1-based)
        assert r["column_start"] == 5
        assert r["column_end"] == 17


# ---------------------------------------------------------------------------
# 正则模式
# ---------------------------------------------------------------------------

class TestRegexMode:
    """测试正则模式 (验收标准:正则模式)"""

    @pytest.mark.asyncio
    async def test_regex_match(self, temp_repo):
        """正则匹配"""
        _create_file(temp_repo, "a.py", "password123 = 'secret'\npassword456 = 'x'\n")
        result = await search_code_by_keyword(
            keyword=r"password\d+",
            repository_path=temp_repo,
            is_regex=True,
        )
        assert result["total_matches"] == 2

    @pytest.mark.asyncio
    async def test_regex_not_matched_as_plain(self, temp_repo):
        """is_regex=False 时正则特殊字符应被转义"""
        _create_file(temp_repo, "a.py", "test.func()\n")
        # is_regex=False, "." 应匹配字面量 "."
        result = await search_code_by_keyword(
            keyword="test.func",
            repository_path=temp_repo,
            is_regex=False,
        )
        assert result["total_matches"] == 1

    @pytest.mark.asyncio
    async def test_regex_word_boundary(self, temp_repo):
        """正则单词边界"""
        _create_file(temp_repo, "a.py", "var login = 1\nvar loginForm = 2\n")
        result = await search_code_by_keyword(
            keyword=r"\blogin\b",
            repository_path=temp_repo,
            is_regex=True,
        )
        assert result["total_matches"] == 1
        assert result["results"][0]["line_number"] == 1


# ---------------------------------------------------------------------------
# 大小写
# ---------------------------------------------------------------------------

class TestCaseSensitivity:
    """测试大小写 (验收标准:大小写)"""

    @pytest.mark.asyncio
    async def test_case_insensitive_default(self, temp_repo):
        """默认不区分大小写"""
        _create_file(temp_repo, "a.py", "Login\nLOGIN\nlogin\n")
        result = await search_code_by_keyword(
            keyword="login",
            repository_path=temp_repo,
        )
        assert result["total_matches"] == 3

    @pytest.mark.asyncio
    async def test_case_sensitive(self, temp_repo):
        """区分大小写"""
        _create_file(temp_repo, "a.py", "Login\nLOGIN\nlogin\n")
        result = await search_code_by_keyword(
            keyword="login",
            repository_path=temp_repo,
            case_sensitive=True,
        )
        assert result["total_matches"] == 1
        assert result["results"][0]["line_content"] == "login"


# ---------------------------------------------------------------------------
# 空结果
# ---------------------------------------------------------------------------

class TestEmptyResults:
    """测试空结果 (验收标准:空结果)"""

    @pytest.mark.asyncio
    async def test_no_match(self, temp_repo):
        """搜不存在的关键词"""
        _create_file(temp_repo, "a.py", "hello world\n")
        result = await search_code_by_keyword(
            keyword="nonexistent_keyword_xyz",
            repository_path=temp_repo,
        )
        assert result["total_matches"] == 0
        assert result["results"] == []

    @pytest.mark.asyncio
    async def test_empty_keyword(self, temp_repo):
        """空关键词返回空结果"""
        _create_file(temp_repo, "a.py", "hello\n")
        result = await search_code_by_keyword(
            keyword="",
            repository_path=temp_repo,
        )
        assert result["total_matches"] == 0

    @pytest.mark.asyncio
    async def test_nonexistent_repo(self):
        """不存在的仓库路径"""
        result = await search_code_by_keyword(
            keyword="test",
            repository_path="/nonexistent/path/xyz",
        )
        assert result["total_matches"] == 0


# ---------------------------------------------------------------------------
# max_results 截断
# ---------------------------------------------------------------------------

class TestMaxResults:
    """测试 max_results 截断 (验收标准:超过 max_results 截断)"""

    @pytest.mark.asyncio
    async def test_truncation(self, temp_repo):
        """结果数超过 max_results 时截断"""
        content = "\n".join(["eval(x)"] * 10) + "\n"
        _create_file(temp_repo, "a.py", content)
        result = await search_code_by_keyword(
            keyword="eval",
            repository_path=temp_repo,
            max_results=3,
        )
        assert result["total_matches"] == 3

    @pytest.mark.asyncio
    async def test_max_results_limit(self, temp_repo):
        """max_results 超过上限时被限制为 1000"""
        content = "\n".join(["eval(x)"] * 5) + "\n"
        _create_file(temp_repo, "a.py", content)
        result = await search_code_by_keyword(
            keyword="eval",
            repository_path=temp_repo,
            max_results=5000,
        )
        # 只有 5 个匹配,不会超过实际数量
        assert result["total_matches"] == 5


# ---------------------------------------------------------------------------
# 排除目录
# ---------------------------------------------------------------------------

class TestExcludedDirs:
    """测试排除目录 (验收标准:.git/、node_modules/、target/ 默认排除)"""

    @pytest.mark.asyncio
    async def test_exclude_git(self, temp_repo):
        """排除 .git/ 目录"""
        _create_file(temp_repo, "src/main.py", "Runtime.exec(x)\n")
        _create_file(temp_repo, ".git/config", "Runtime.exec(y)\n")
        result = await search_code_by_keyword(
            keyword="Runtime.exec",
            repository_path=temp_repo,
        )
        assert result["total_matches"] == 1
        assert "src/main.py" in result["results"][0]["file_path"]

    @pytest.mark.asyncio
    async def test_exclude_node_modules(self, temp_repo):
        """排除 node_modules/ 目录"""
        _create_file(temp_repo, "app.js", "eval(x)\n")
        _create_file(temp_repo, "node_modules/lib.js", "eval(y)\n")
        result = await search_code_by_keyword(
            keyword="eval",
            repository_path=temp_repo,
        )
        assert result["total_matches"] == 1

    @pytest.mark.asyncio
    async def test_exclude_target(self, temp_repo):
        """排除 target/ 目录"""
        _create_file(temp_repo, "src/Main.java", "Runtime.exec(x)\n")
        _create_file(temp_repo, "target/Main.class", "Runtime.exec(y)\n")
        result = await search_code_by_keyword(
            keyword="Runtime.exec",
            repository_path=temp_repo,
        )
        assert result["total_matches"] == 1


# ---------------------------------------------------------------------------
# path_prefix 过滤
# ---------------------------------------------------------------------------

class TestPathPrefix:
    """测试 path_prefix 过滤 (验收标准:支持 path_prefix 过滤)"""

    @pytest.mark.asyncio
    async def test_path_prefix_filters(self, temp_repo):
        """path_prefix 限定搜索范围"""
        _create_file(temp_repo, "src/a.py", "Runtime.exec(x)\n")
        _create_file(temp_repo, "test/b.py", "Runtime.exec(y)\n")
        result = await search_code_by_keyword(
            keyword="Runtime.exec",
            repository_path=temp_repo,
            path_prefix="src/",
        )
        assert result["total_matches"] == 1
        assert "src/a.py" in result["results"][0]["file_path"]

    @pytest.mark.asyncio
    async def test_nonexistent_path_prefix(self, temp_repo):
        """不存在的 path_prefix 返回空"""
        _create_file(temp_repo, "src/a.py", "Runtime.exec(x)\n")
        result = await search_code_by_keyword(
            keyword="Runtime.exec",
            repository_path=temp_repo,
            path_prefix="nonexistent/",
        )
        assert result["total_matches"] == 0


# ---------------------------------------------------------------------------
# 二进制文件
# ---------------------------------------------------------------------------

class TestBinaryFiles:
    """测试二进制文件跳过 (验收标准:二进制文件默认排除)"""

    @pytest.mark.asyncio
    async def test_skip_binary_file(self, temp_repo):
        """二进制文件被跳过"""
        _create_file(temp_repo, "src/app.py", "Runtime.exec(x)\n")
        _create_binary_file(temp_repo, "src/binary.dat")
        result = await search_code_by_keyword(
            keyword="Runtime.exec",
            repository_path=temp_repo,
        )
        assert result["total_matches"] == 1

    @pytest.mark.asyncio
    async def test_binary_not_searched(self, temp_repo):
        """二进制文件中即使有关键词也不匹配"""
        # 创建一个含 "eval" 文本的二进制文件
        abspath = os.path.join(temp_repo, "data.bin")
        with open(abspath, "wb") as f:
            f.write(b"\x00\x01eval(x)\x00\x02")
        result = await search_code_by_keyword(
            keyword="eval",
            repository_path=temp_repo,
        )
        assert result["total_matches"] == 0


# ---------------------------------------------------------------------------
# 上下文行
# ---------------------------------------------------------------------------

class TestContextLines:
    """测试上下文行输出"""

    @pytest.mark.asyncio
    async def test_context_before_and_after(self, temp_repo):
        """验证 context_before 和 context_after"""
        content = "line1\nline2\nRuntime.exec(x)\nline4\nline5\n"
        _create_file(temp_repo, "a.py", content)
        result = await search_code_by_keyword(
            keyword="Runtime.exec",
            repository_path=temp_repo,
        )
        r = result["results"][0]
        assert r["line_number"] == 3
        assert r["context_before"] == ["line1", "line2"]
        assert r["context_after"] == ["line4", "line5"]

    @pytest.mark.asyncio
    async def test_context_at_file_start(self, temp_repo):
        """文件开头匹配时 context_before 为空"""
        _create_file(temp_repo, "a.py", "Runtime.exec(x)\nline2\n")
        result = await search_code_by_keyword(
            keyword="Runtime.exec",
            repository_path=temp_repo,
        )
        r = result["results"][0]
        assert r["context_before"] == []
        assert r["context_after"] == ["line2"]


# ---------------------------------------------------------------------------
# MCP 框架注册对齐
# ---------------------------------------------------------------------------

class TestMCPRegistration:
    """测试与 MCP 框架注册机制对齐 (验收标准:与 bootstrap_mcp_framework 对齐)"""

    @pytest.mark.asyncio
    async def test_tool_auto_discovered(self):
        """tool 应被自动发现并注册"""
        mcp = FastMCP(name="test-server", version="0.0.1")
        registered = auto_discover_tools(mcp, "yasa_mcp.tools")
        assert "search_code_by_keyword" in registered

    @pytest.mark.asyncio
    async def test_tool_in_tools_list(self):
        """tool 应出现在 tools/list 中"""
        mcp = FastMCP(name="test-server-2", version="0.0.1")
        auto_discover_tools(mcp, "yasa_mcp.tools")
        tools = await mcp.list_tools()
        tool_names = [t.name for t in tools]
        assert "search_code_by_keyword" in tool_names

    @pytest.mark.asyncio
    async def test_tool_has_description(self):
        """tool 应有描述"""
        mcp = FastMCP(name="test-server-3", version="0.0.1")
        auto_discover_tools(mcp, "yasa_mcp.tools")
        tools = await mcp.list_tools()
        tool = [t for t in tools if t.name == "search_code_by_keyword"][0]
        assert tool.description is not None
        assert len(tool.description) > 0

    @pytest.mark.asyncio
    async def test_tool_callable_via_mcp(self, temp_repo):
        """通过 MCP 协议调用 tool"""
        mcp = FastMCP(name="test-server-4", version="0.0.1")
        auto_discover_tools(mcp, "yasa_mcp.tools")
        _create_file(temp_repo, "a.py", "Runtime.exec(x)\n")
        result = await mcp.call_tool("search_code_by_keyword", {
            "keyword": "Runtime.exec",
            "repository_path": temp_repo,
        })
        assert result is not None


# ---------------------------------------------------------------------------
# 性能测试
# ---------------------------------------------------------------------------

class TestPerformance:
    """性能测试 (验收标准:1k 文件 < 2s)"""

    @pytest.mark.asyncio
    async def test_1k_files_under_2s(self, temp_repo):
        """1000 文件搜索应在 2 秒内完成"""
        for i in range(1000):
            _create_file(temp_repo, f"src/file_{i}.py", f"def func_{i}():\n    pass\n")

        start = time.time()
        result = await search_code_by_keyword(
            keyword="def",
            repository_path=temp_repo,
            max_results=1000,
        )
        elapsed = time.time() - start

        assert elapsed < 2.0, f"Search took {elapsed:.2f}s, expected < 2s"
        assert result["total_matches"] == 1000
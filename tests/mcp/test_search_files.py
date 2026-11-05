"""
测试 search_files_by_keyword tool

覆盖验收标准:
- 正则模式
- 空仓库
- 超大量结果截断
- 默认排除 .git/、node_modules/、target/、build/、dist/
- extensions 过滤生效
- 1 万文件量级仓库响应 < 1s
- match_target (filename / fullpath)
- 与 MCP 框架注册机制对齐
"""

from __future__ import annotations

import os
import time
import tempfile

import pytest
from fastmcp import FastMCP

from yasa_mcp.tools.search_files_by_keyword import search_files_by_keyword
from yasa_mcp.registry import auto_discover_tools


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _create_file(root: str, relpath: str, content: str = "") -> str:
    abspath = os.path.join(root, relpath)
    os.makedirs(os.path.dirname(abspath), exist_ok=True)
    with open(abspath, "w", encoding="utf-8") as f:
        f.write(content)
    return abspath


@pytest.fixture
def temp_repo():
    with tempfile.TemporaryDirectory() as tmpdir:
        yield tmpdir


# ---------------------------------------------------------------------------
# 基本搜索
# ---------------------------------------------------------------------------

class TestBasicSearch:
    """测试基本文件名搜索"""

    @pytest.mark.asyncio
    async def test_filename_match(self, temp_repo):
        """按文件名匹配"""
        _create_file(temp_repo, "src/LoginController.java")
        _create_file(temp_repo, "src/UserService.java")
        result = await search_files_by_keyword(
            keyword="Login",
            repository_path=temp_repo,
        )
        assert result["total_matches"] == 1
        assert result["results"][0]["filename"] == "LoginController.java"

    @pytest.mark.asyncio
    async def test_case_insensitive_default(self, temp_repo):
        """默认不区分大小写"""
        _create_file(temp_repo, "Login.java")
        _create_file(temp_repo, "login.py")
        _create_file(temp_repo, "LOGIN.go")
        result = await search_files_by_keyword(
            keyword="login",
            repository_path=temp_repo,
        )
        assert result["total_matches"] == 3

    @pytest.mark.asyncio
    async def test_returns_file_metadata(self, temp_repo):
        """验证返回的文件元数据"""
        _create_file(temp_repo, "app.py", "print('hello')\n")
        result = await search_files_by_keyword(
            keyword="app",
            repository_path=temp_repo,
        )
        r = result["results"][0]
        assert r["filename"] == "app.py"
        assert r["file_path"] == "app.py"
        assert r["size_bytes"] > 0
        assert r["language"] == "python"

    @pytest.mark.asyncio
    async def test_language_detection(self, temp_repo):
        """验证语言标识"""
        _create_file(temp_repo, "a.java")
        _create_file(temp_repo, "b.py")
        _create_file(temp_repo, "c.go")
        _create_file(temp_repo, "d.js")
        _create_file(temp_repo, "e.unknown_ext")
        result = await search_files_by_keyword(
            keyword=".",
            repository_path=temp_repo,
            is_regex=True,
        )
        langs = {r["filename"]: r["language"] for r in result["results"]}
        assert langs["a.java"] == "java"
        assert langs["b.py"] == "python"
        assert langs["c.go"] == "golang"
        assert langs["d.js"] == "javascript"
        assert langs["e.unknown_ext"] == "unknown"


# ---------------------------------------------------------------------------
# 正则模式
# ---------------------------------------------------------------------------

class TestRegexMode:
    """测试正则模式 (验收标准:正则模式)"""

    @pytest.mark.asyncio
    async def test_regex_match(self, temp_repo):
        """正则匹配文件名"""
        _create_file(temp_repo, "UserController.java")
        _create_file(temp_repo, "AdminController.java")
        _create_file(temp_repo, "Model.java")
        result = await search_files_by_keyword(
            keyword=r".*Controller\.java$",
            repository_path=temp_repo,
            is_regex=True,
        )
        assert result["total_matches"] == 2

    @pytest.mark.asyncio
    async def test_regex_not_matched_as_plain(self, temp_repo):
        """is_regex=False 时正则字符被转义"""
        _create_file(temp_repo, "test.java")
        _create_file(temp_repo, "testXjava")
        result = await search_files_by_keyword(
            keyword="test.java",
            repository_path=temp_repo,
            is_regex=False,
        )
        # 只匹配 "test.java" 字面量，不匹配 "testXjava"
        assert result["total_matches"] == 1
        assert result["results"][0]["filename"] == "test.java"


# ---------------------------------------------------------------------------
# 空仓库
# ---------------------------------------------------------------------------

class TestEmptyRepo:
    """测试空仓库 (验收标准:空仓库)"""

    @pytest.mark.asyncio
    async def test_empty_repo(self, temp_repo):
        """空仓库返回空结果"""
        result = await search_files_by_keyword(
            keyword="Login",
            repository_path=temp_repo,
        )
        assert result["total_matches"] == 0
        assert result["results"] == []

    @pytest.mark.asyncio
    async def test_no_match(self, temp_repo):
        """有文件但搜不到匹配"""
        _create_file(temp_repo, "a.py")
        _create_file(temp_repo, "b.java")
        result = await search_files_by_keyword(
            keyword="nonexistent_xyz",
            repository_path=temp_repo,
        )
        assert result["total_matches"] == 0

    @pytest.mark.asyncio
    async def test_empty_keyword(self, temp_repo):
        """空关键词返回空"""
        _create_file(temp_repo, "a.py")
        result = await search_files_by_keyword(
            keyword="",
            repository_path=temp_repo,
        )
        assert result["total_matches"] == 0

    @pytest.mark.asyncio
    async def test_nonexistent_repo(self):
        """不存在的仓库路径"""
        result = await search_files_by_keyword(
            keyword="test",
            repository_path="/nonexistent/path/xyz",
        )
        assert result["total_matches"] == 0


# ---------------------------------------------------------------------------
# max_results 截断
# ---------------------------------------------------------------------------

class TestMaxResults:
    """测试 max_results 截断 (验收标准:超大量结果截断)"""

    @pytest.mark.asyncio
    async def test_truncation(self, temp_repo):
        """结果超过 max_results 时截断"""
        for i in range(50):
            _create_file(temp_repo, f"file_{i}.py")
        result = await search_files_by_keyword(
            keyword="file",
            repository_path=temp_repo,
            max_results=10,
        )
        assert result["total_matches"] == 10

    @pytest.mark.asyncio
    async def test_default_max_results(self, temp_repo):
        """默认 max_results 为 200"""
        for i in range(300):
            _create_file(temp_repo, f"file_{i}.py")
        result = await search_files_by_keyword(
            keyword="file",
            repository_path=temp_repo,
        )
        assert result["total_matches"] == 200


# ---------------------------------------------------------------------------
# 排除目录
# ---------------------------------------------------------------------------

class TestExcludedDirs:
    """测试排除目录 (验收标准:.git/、node_modules/、target/、build/、dist/)"""

    @pytest.mark.asyncio
    async def test_exclude_git(self, temp_repo):
        """排除 .git/"""
        _create_file(temp_repo, "src/Login.java")
        _create_file(temp_repo, ".git/config")
        result = await search_files_by_keyword(
            keyword=".",
            repository_path=temp_repo,
            is_regex=True,
        )
        paths = [r["file_path"] for r in result["results"]]
        assert not any(".git/" in p for p in paths)

    @pytest.mark.asyncio
    async def test_exclude_node_modules(self, temp_repo):
        """排除 node_modules/"""
        _create_file(temp_repo, "app.js")
        _create_file(temp_repo, "node_modules/lib.js")
        result = await search_files_by_keyword(
            keyword=".",
            repository_path=temp_repo,
            is_regex=True,
        )
        paths = [r["file_path"] for r in result["results"]]
        assert not any("node_modules/" in p for p in paths)

    @pytest.mark.asyncio
    async def test_exclude_target_build_dist(self, temp_repo):
        """排除 target/、build/、dist/"""
        _create_file(temp_repo, "src/Main.java")
        _create_file(temp_repo, "target/Main.class")
        _create_file(temp_repo, "build/output.js")
        _create_file(temp_repo, "dist/bundle.js")
        result = await search_files_by_keyword(
            keyword=".",
            repository_path=temp_repo,
            is_regex=True,
        )
        paths = [r["file_path"] for r in result["results"]]
        assert not any("target/" in p for p in paths)
        assert not any("build/" in p for p in paths)
        assert not any("dist/" in p for p in paths)


# ---------------------------------------------------------------------------
# extensions 过滤
# ---------------------------------------------------------------------------

class TestExtensionsFilter:
    """测试 extensions 过滤 (验收标准:extensions 过滤生效)"""

    @pytest.mark.asyncio
    async def test_filter_by_extension(self, temp_repo):
        """只返回指定扩展名的文件"""
        _create_file(temp_repo, "Login.java")
        _create_file(temp_repo, "Login.py")
        _create_file(temp_repo, "Login.go")
        result = await search_files_by_keyword(
            keyword="Login",
            repository_path=temp_repo,
            extensions=["java"],
        )
        assert result["total_matches"] == 1
        assert result["results"][0]["filename"] == "Login.java"

    @pytest.mark.asyncio
    async def test_filter_multiple_extensions(self, temp_repo):
        """多个扩展名过滤"""
        _create_file(temp_repo, "Auth.java")
        _create_file(temp_repo, "Auth.kt")
        _create_file(temp_repo, "Auth.py")
        result = await search_files_by_keyword(
            keyword="Auth",
            repository_path=temp_repo,
            extensions=["java", "kt"],
        )
        assert result["total_matches"] == 2
        exts = {r["filename"].rsplit(".", 1)[-1] for r in result["results"]}
        assert exts == {"java", "kt"}

    @pytest.mark.asyncio
    async def test_no_extensions_returns_all(self, temp_repo):
        """不传 extensions 返回所有文件"""
        _create_file(temp_repo, "a.java")
        _create_file(temp_repo, "b.py")
        result = await search_files_by_keyword(
            keyword=".",
            repository_path=temp_repo,
            is_regex=True,
        )
        assert result["total_matches"] == 2


# ---------------------------------------------------------------------------
# match_target
# ---------------------------------------------------------------------------

class TestMatchTarget:
    """测试 match_target (filename / fullpath)"""

    @pytest.mark.asyncio
    async def test_match_filename_default(self, temp_repo):
        """默认按文件名匹配"""
        _create_file(temp_repo, "src/auth/Login.java")
        _create_file(temp_repo, "src/user/Profile.java")
        result = await search_files_by_keyword(
            keyword="auth",
            repository_path=temp_repo,
        )
        # "auth" 在路径里但不在文件名里，默认 match_target=filename 应匹配 0
        assert result["total_matches"] == 0

    @pytest.mark.asyncio
    async def test_match_fullpath(self, temp_repo):
        """fullpath 模式匹配整条路径"""
        _create_file(temp_repo, "src/auth/Login.java")
        _create_file(temp_repo, "src/user/Profile.java")
        result = await search_files_by_keyword(
            keyword="auth",
            repository_path=temp_repo,
            match_target="fullpath",
        )
        assert result["total_matches"] == 1
        assert "auth/Login.java" in result["results"][0]["file_path"]


# ---------------------------------------------------------------------------
# MCP 框架注册对齐
# ---------------------------------------------------------------------------

class TestMCPRegistration:
    """测试与 MCP 框架注册机制对齐"""

    @pytest.mark.asyncio
    async def test_tool_auto_discovered(self):
        """tool 应被自动发现并注册"""
        mcp = FastMCP(name="test-server", version="0.0.1")
        registered = auto_discover_tools(mcp, "yasa_mcp.tools")
        assert "search_files_by_keyword" in registered

    @pytest.mark.asyncio
    async def test_tool_in_tools_list(self):
        """tool 应出现在 tools/list 中"""
        mcp = FastMCP(name="test-server-2", version="0.0.1")
        auto_discover_tools(mcp, "yasa_mcp.tools")
        tools = await mcp.list_tools()
        tool_names = [t.name for t in tools]
        assert "search_files_by_keyword" in tool_names

    @pytest.mark.asyncio
    async def test_tool_callable_via_mcp(self, temp_repo):
        """通过 MCP 协议调用 tool"""
        mcp = FastMCP(name="test-server-3", version="0.0.1")
        auto_discover_tools(mcp, "yasa_mcp.tools")
        _create_file(temp_repo, "Login.java")
        result = await mcp.call_tool("search_files_by_keyword", {
            "keyword": "Login",
            "repository_path": temp_repo,
        })
        assert result is not None


# ---------------------------------------------------------------------------
# 性能测试
# ---------------------------------------------------------------------------

class TestPerformance:
    """性能测试 (验收标准:1 万文件量级 < 1s)"""

    @pytest.mark.asyncio
    async def test_10k_files_under_1s(self, temp_repo):
        """10000 文件搜索应在 1 秒内完成"""
        for i in range(10000):
            _create_file(temp_repo, f"src/dir_{i % 100}/file_{i}.py")

        start = time.time()
        result = await search_files_by_keyword(
            keyword="file",
            repository_path=temp_repo,
            max_results=10000,
        )
        elapsed = time.time() - start

        assert elapsed < 1.0, f"Search took {elapsed:.2f}s, expected < 1s"
        assert result["total_matches"] == 10000
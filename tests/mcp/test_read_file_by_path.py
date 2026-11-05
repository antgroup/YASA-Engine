"""
测试 read_file_by_path tool

覆盖验收标准:
- [x] 拒绝 .. 路径穿越攻击
- [x] 拒绝读取 repository_path 之外的路径
- [x] 二进制文件返回错误而不是乱码内容
- [x] start_line / end_line 范围超界自动 clamp
- [x] 单元测试覆盖:路径越权、二进制文件、空文件、超大文件截断

测试数据:
  - 单元测试: 临时创建的文件
  - 集成测试: test-repos/ 下的开源项目文件
"""

from __future__ import annotations

import os

import pytest
from fastmcp import FastMCP

from yasa_mcp.tools.read_file_by_path import read_file_by_path
from yasa_mcp.registry import auto_discover_tools

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_JDP_REPO = os.path.join(_REPO_ROOT, "test-repos", "java-design-patterns")


def _create_file(root: str, relpath: str, content: str) -> str:
    abspath = os.path.join(root, relpath)
    os.makedirs(os.path.dirname(abspath), exist_ok=True)
    with open(abspath, "w", encoding="utf-8") as f:
        f.write(content)
    return abspath


# ---------------------------------------------------------------------------
# 基本读取
# ---------------------------------------------------------------------------

class TestBasicRead:
    """测试基本文件读取"""

    @pytest.mark.asyncio
    async def test_read_java_file(self, tmp_path):
        """读取 Java 文件"""
        _create_file(tmp_path, "src/Main.java", "package com.example;\npublic class Main {}\n")

        result = await read_file_by_path(
            file_path="src/Main.java",
            repository_path=str(tmp_path),
        )

        assert "error" not in result
        assert result["language"] == "java"
        assert result["encoding"] == "utf-8"
        assert result["total_lines"] == 2
        assert "public class Main" in result["content"]
        assert result["truncated"] is False

    @pytest.mark.asyncio
    async def test_read_python_file(self, tmp_path):
        """读取 Python 文件, 语言检测正确"""
        _create_file(tmp_path, "script.py", "print('hello')\n")

        result = await read_file_by_path(
            file_path="script.py",
            repository_path=str(tmp_path),
        )

        assert result["language"] == "python"

    @pytest.mark.asyncio
    async def test_returned_lines_metadata(self, tmp_path):
        """返回 returned_lines 元数据"""
        _create_file(tmp_path, "test.txt", "line1\nline2\nline3\n")

        result = await read_file_by_path(
            file_path="test.txt",
            repository_path=str(tmp_path),
        )

        assert result["returned_lines"] == {"start": 1, "end": 3}

    @pytest.mark.asyncio
    async def test_size_bytes(self, tmp_path):
        """返回 size_bytes"""
        content = "hello world\n"
        _create_file(tmp_path, "test.txt", content)

        result = await read_file_by_path(
            file_path="test.txt",
            repository_path=str(tmp_path),
        )

        assert result["size_bytes"] == len(content.encode("utf-8"))

    @pytest.mark.asyncio
    async def test_relative_path_returned(self, tmp_path):
        """返回相对路径"""
        _create_file(tmp_path, "src/deep/File.java", "package x;\n")

        result = await read_file_by_path(
            file_path="src/deep/File.java",
            repository_path=str(tmp_path),
        )

        assert result["file_path"] == "src/deep/File.java"


# ---------------------------------------------------------------------------
# 路径安全
# ---------------------------------------------------------------------------

class TestPathSecurity:
    """测试路径安全防护"""

    @pytest.mark.asyncio
    async def test_reject_traversal(self, tmp_path):
        """拒绝 .. 路径穿越"""
        _create_file(tmp_path, "safe.txt", "safe content\n")

        result = await read_file_by_path(
            file_path="../../../etc/passwd",
            repository_path=str(tmp_path),
        )

        assert "error" in result
        assert "traversal" in result["error"].lower()

    @pytest.mark.asyncio
    async def test_reject_outside_repo(self, tmp_path):
        """拒绝仓库外文件"""
        # 创建仓库外文件
        outside = os.path.join(tmp_path, "..", "outside.txt")
        with open(os.path.join(tmp_path.parent, "outside.txt"), "w") as f:
            f.write("outside\n")

        result = await read_file_by_path(
            file_path="../outside.txt",
            repository_path=str(tmp_path),
        )

        assert "error" in result

    @pytest.mark.asyncio
    async def test_reject_absolute_outside(self, tmp_path):
        """拒绝仓库外绝对路径"""
        result = await read_file_by_path(
            file_path="/etc/passwd",
            repository_path=str(tmp_path),
        )

        assert "error" in result


# ---------------------------------------------------------------------------
# 二进制文件
# ---------------------------------------------------------------------------

class TestBinaryFile:
    """测试二进制文件检测"""

    @pytest.mark.asyncio
    async def test_binary_rejected(self, tmp_path):
        """二进制文件返回错误"""
        bpath = os.path.join(tmp_path, "data.bin")
        with open(bpath, "wb") as f:
            f.write(b"\x00\x01\x02\x03binary\x00data")

        result = await read_file_by_path(
            file_path="data.bin",
            repository_path=str(tmp_path),
        )

        assert "error" in result
        assert "binary" in result["error"].lower()

    @pytest.mark.asyncio
    async def test_text_file_not_rejected(self, tmp_path):
        """纯文本文件不被误判为二进制"""
        _create_file(tmp_path, "text.txt", "Hello, World!\n")

        result = await read_file_by_path(
            file_path="text.txt",
            repository_path=str(tmp_path),
        )

        assert "error" not in result
        assert "Hello, World!" in result["content"]


# ---------------------------------------------------------------------------
# 行号区间
# ---------------------------------------------------------------------------

class TestLineRange:
    """测试行号区间读取"""

    @pytest.mark.asyncio
    async def test_read_specific_range(self, tmp_path):
        """读取指定行号区间"""
        _create_file(tmp_path, "test.txt", "line1\nline2\nline3\nline4\nline5\n")

        result = await read_file_by_path(
            file_path="test.txt",
            repository_path=str(tmp_path),
            start_line=2,
            end_line=4,
        )

        assert result["returned_lines"] == {"start": 2, "end": 4}
        assert "line2" in result["content"]
        assert "line3" in result["content"]
        assert "line4" in result["content"]
        assert "line1" not in result["content"]
        assert "line5" not in result["content"]

    @pytest.mark.asyncio
    async def test_start_line_only(self, tmp_path):
        """只指定 start_line, 读到文件尾"""
        _create_file(tmp_path, "test.txt", "line1\nline2\nline3\n")

        result = await read_file_by_path(
            file_path="test.txt",
            repository_path=str(tmp_path),
            start_line=2,
        )

        assert result["returned_lines"] == {"start": 2, "end": 3}

    @pytest.mark.asyncio
    async def test_clamp_start_line(self, tmp_path):
        """start_line 超界自动 clamp"""
        _create_file(tmp_path, "test.txt", "line1\nline2\n")

        result = await read_file_by_path(
            file_path="test.txt",
            repository_path=str(tmp_path),
            start_line=100,
        )

        # clamp 到文件末尾
        assert result["returned_lines"]["start"] <= result["total_lines"]

    @pytest.mark.asyncio
    async def test_clamp_end_line(self, tmp_path):
        """end_line 超界自动 clamp"""
        _create_file(tmp_path, "test.txt", "line1\nline2\n")

        result = await read_file_by_path(
            file_path="test.txt",
            repository_path=str(tmp_path),
            start_line=1,
            end_line=100,
        )

        assert result["returned_lines"]["end"] == result["total_lines"]


# ---------------------------------------------------------------------------
# 截断
# ---------------------------------------------------------------------------

class TestTruncation:
    """测试大文件截断"""

    @pytest.mark.asyncio
    async def test_truncated(self, tmp_path):
        """超过 max_bytes 时截断"""
        content = "x" * 500 + "\n"
        _create_file(tmp_path, "big.txt", content)

        result = await read_file_by_path(
            file_path="big.txt",
            repository_path=str(tmp_path),
            max_bytes=100,
        )

        assert result["truncated"] is True
        assert result["size_bytes"] <= 100

    @pytest.mark.asyncio
    async def test_not_truncated(self, tmp_path):
        """未超 max_bytes 不截断"""
        _create_file(tmp_path, "small.txt", "hello\n")

        result = await read_file_by_path(
            file_path="small.txt",
            repository_path=str(tmp_path),
            max_bytes=1024,
        )

        assert result["truncated"] is False

    @pytest.mark.asyncio
    async def test_large_file(self, tmp_path):
        """大文件截断到 1MB 默认"""
        # 创建 2MB 文件
        content = "A" * (2 * 1024 * 1024)
        _create_file(tmp_path, "large.txt", content)

        result = await read_file_by_path(
            file_path="large.txt",
            repository_path=str(tmp_path),
        )

        assert result["truncated"] is True
        assert result["size_bytes"] <= 1024 * 1024


# ---------------------------------------------------------------------------
# 空文件
# ---------------------------------------------------------------------------

class TestEmptyFile:
    """测试空文件"""

    @pytest.mark.asyncio
    async def test_empty_file(self, tmp_path):
        """空文件"""
        _create_file(tmp_path, "empty.java", "")

        result = await read_file_by_path(
            file_path="empty.java",
            repository_path=str(tmp_path),
        )

        assert result["total_lines"] == 0
        assert result["content"] == ""
        assert result["truncated"] is False


# ---------------------------------------------------------------------------
# 边界情况
# ---------------------------------------------------------------------------

class TestEdgeCases:
    """测试边界情况"""

    @pytest.mark.asyncio
    async def test_file_not_found(self, tmp_path):
        """文件不存在"""
        result = await read_file_by_path(
            file_path="nonexistent.java",
            repository_path=str(tmp_path),
        )

        assert "error" in result

    @pytest.mark.asyncio
    async def test_empty_file_path(self, tmp_path):
        """空文件路径"""
        result = await read_file_by_path(
            file_path="",
            repository_path=str(tmp_path),
        )

        assert "error" in result

    @pytest.mark.asyncio
    async def test_invalid_repo(self):
        """无效仓库路径"""
        result = await read_file_by_path(
            file_path="test.txt",
            repository_path="/nonexistent/path",
        )

        assert "error" in result

    @pytest.mark.asyncio
    async def test_absolute_path_within_repo(self, tmp_path):
        """仓库内绝对路径"""
        fpath = _create_file(tmp_path, "src/Test.java", "package x;\n")
        result = await read_file_by_path(
            file_path=fpath,
            repository_path=str(tmp_path),
        )

        assert "error" not in result
        assert "package x" in result["content"]


# ---------------------------------------------------------------------------
# MCP 注册
# ---------------------------------------------------------------------------

class TestMCPRegistration:

    @pytest.mark.asyncio
    async def test_auto_discovered(self):
        mcp = FastMCP(name="test", version="0.0.1")
        registered = auto_discover_tools(mcp, "yasa_mcp.tools")
        assert "read_file_by_path" in registered

    @pytest.mark.asyncio
    async def test_callable_via_mcp(self, tmp_path):
        mcp = FastMCP(name="test2", version="0.0.1")
        auto_discover_tools(mcp, "yasa_mcp.tools")
        _create_file(tmp_path, "test.txt", "hello\n")
        result = await mcp.call_tool("read_file_by_path", {
            "file_path": "test.txt",
            "repository_path": str(tmp_path),
        })
        assert result is not None


# ---------------------------------------------------------------------------
# 集成测试: java-design-patterns
# ---------------------------------------------------------------------------

class TestJDPIntegration:

    @pytest.fixture
    def repo(self):
        if not os.path.isdir(_JDP_REPO):
            pytest.skip("JDP not available")
        return _JDP_REPO

    @pytest.mark.asyncio
    async def test_read_java_from_jdp(self, repo):
        """从 JDP 读取 Java 文件"""
        result = await read_file_by_path(
            file_path="filterer/src/main/java/com/iluwatar/filterer/threat/Threat.java",
            repository_path=repo,
        )

        assert "error" not in result
        assert result["language"] == "java"
        assert "interface Threat" in result["content"]

    @pytest.mark.asyncio
    async def test_line_range_jdp(self, repo):
        """从 JDP 读取文件指定行范围"""
        result = await read_file_by_path(
            file_path="filterer/src/main/java/com/iluwatar/filterer/threat/Threat.java",
            repository_path=repo,
            start_line=1,
            end_line=10,
        )

        assert result["returned_lines"]["end"] <= 10
        assert result["total_lines"] > 10
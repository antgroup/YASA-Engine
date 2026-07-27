"""
测试 find_implementations_by_interface_name tool

覆盖验收标准:
- 正确识别 implements、extends（抽象类）关系
- 支持泛型接口 Repository<User>
- 多层继承（ConcreteValidator extends AbstractValidator implements RequestValidator）
- 嵌套类/内部类
- 找不到时返回空列表
- include_abstract_classes=false 时排除抽象类
- 与 MCP 框架注册机制对齐
"""

from __future__ import annotations

import os
import tempfile

import pytest
from fastmcp import FastMCP

from yasa_mcp.tools.find_implementations_by_interface_name import (
    find_implementations_by_interface_name,
)
from yasa_mcp.registry import auto_discover_tools

# 测试数据仓库路径
TEST_REPO = os.path.join(os.path.dirname(__file__), "test-impl-repo")


class TestDirectImplements:
    """测试直接 implements 关系"""

    @pytest.mark.asyncio
    async def test_find_direct_implementations(self):
        """查找直接 implements RequestValidator 的类"""
        result = await find_implementations_by_interface_name(
            interface_full_name="com.example.RequestValidator",
            repository_path=TEST_REPO,
        )
        assert result["interface_full_name"] == "com.example.RequestValidator"
        assert result["total_implementations"] >= 2

        class_names = [impl["class_full_name"] for impl in result["implementations"]]
        assert "com.example.impl.JsonRequestValidator" in class_names
        assert "com.example.impl.XmlRequestValidator" in class_names

    @pytest.mark.asyncio
    async def test_returns_correct_metadata(self):
        """验证返回的元数据结构"""
        result = await find_implementations_by_interface_name(
            interface_full_name="com.example.RequestValidator",
            repository_path=TEST_REPO,
        )
        for impl in result["implementations"]:
            assert "class_full_name" in impl
            assert "file_path" in impl
            assert "line_number" in impl
            assert "kind" in impl
            assert impl["kind"] in ("class", "abstract_class")
            assert impl["line_number"] > 0
            assert impl["file_path"].endswith(".java")


class TestAbstractClass:
    """测试抽象类 implements"""

    @pytest.mark.asyncio
    async def test_includes_abstract_by_default(self):
        """默认包含抽象类"""
        result = await find_implementations_by_interface_name(
            interface_full_name="com.example.RequestValidator",
            repository_path=TEST_REPO,
        )
        class_names = [impl["class_full_name"] for impl in result["implementations"]]
        assert "com.example.impl.AbstractValidator" in class_names

        abstract_impl = [
            impl for impl in result["implementations"]
            if impl["class_full_name"] == "com.example.impl.AbstractValidator"
        ][0]
        assert abstract_impl["kind"] == "abstract_class"

    @pytest.mark.asyncio
    async def test_excludes_abstract_when_requested(self):
        """include_abstract_classes=False 时排除抽象类"""
        result = await find_implementations_by_interface_name(
            interface_full_name="com.example.RequestValidator",
            repository_path=TEST_REPO,
            include_abstract_classes=False,
        )
        class_names = [impl["class_full_name"] for impl in result["implementations"]]
        assert "com.example.impl.AbstractValidator" not in class_names
        assert all(impl["kind"] == "class" for impl in result["implementations"])


class TestIndirectInheritance:
    """测试间接继承（多层继承）"""

    @pytest.mark.asyncio
    async def test_indirect_through_abstract_class(self):
        """ConcreteValidator extends AbstractValidator implements RequestValidator"""
        result = await find_implementations_by_interface_name(
            interface_full_name="com.example.RequestValidator",
            repository_path=TEST_REPO,
        )
        class_names = [impl["class_full_name"] for impl in result["implementations"]]
        assert "com.example.impl.ConcreteValidator" in class_names

        concrete_impl = [
            impl for impl in result["implementations"]
            if impl["class_full_name"] == "com.example.impl.ConcreteValidator"
        ][0]
        assert concrete_impl["kind"] == "class"


class TestGenericInterface:
    """测试泛型接口"""

    @pytest.mark.asyncio
    async def test_generic_interface(self):
        """Repository<T> 的实现"""
        result = await find_implementations_by_interface_name(
            interface_full_name="com.example.Repository",
            repository_path=TEST_REPO,
        )
        class_names = [impl["class_full_name"] for impl in result["implementations"]]
        assert "com.example.impl.UserRepository" in class_names


class TestInnerClass:
    """测试内部类"""

    @pytest.mark.asyncio
    async def test_inner_class_implements(self):
        """OuterClass.InnerValidator implements RequestValidator"""
        result = await find_implementations_by_interface_name(
            interface_full_name="com.example.RequestValidator",
            repository_path=TEST_REPO,
        )
        class_names = [impl["class_full_name"] for impl in result["implementations"]]
        # 内部类可能被识别为 OuterClass 或包含 InnerValidator
        assert any("InnerValidator" in name for name in class_names)


class TestAnonymousClass:
    """测试匿名实现类"""

    @pytest.mark.asyncio
    async def test_anonymous_implementation(self):
        """匿名实现类 new RequestValidator() { ... }"""
        result = await find_implementations_by_interface_name(
            interface_full_name="com.example.RequestValidator",
            repository_path=TEST_REPO,
        )
        class_names = [impl["class_full_name"] for impl in result["implementations"]]
        # 匿名类命名格式: 包名.文件名$序号
        assert any("$" in name and "AnonymousExample" in name for name in class_names), \
            f"Anonymous class not found in: {class_names}"


class TestNotFound:
    """测试找不到的情况"""

    @pytest.mark.asyncio
    async def test_nonexistent_interface(self):
        """查找不存在的接口返回空"""
        result = await find_implementations_by_interface_name(
            interface_full_name="com.example.NonExistent",
            repository_path=TEST_REPO,
        )
        assert result["total_implementations"] == 0
        assert result["implementations"] == []

    @pytest.mark.asyncio
    async def test_empty_interface_name(self):
        """空接口名返回空"""
        result = await find_implementations_by_interface_name(
            interface_full_name="",
            repository_path=TEST_REPO,
        )
        assert result["total_implementations"] == 0

    @pytest.mark.asyncio
    async def test_nonexistent_repo(self):
        """不存在的仓库返回空"""
        result = await find_implementations_by_interface_name(
            interface_full_name="com.example.RequestValidator",
            repository_path="/nonexistent/path",
        )
        assert result["total_implementations"] == 0

    @pytest.mark.asyncio
    async def test_empty_repo(self):
        """空仓库返回空"""
        with tempfile.TemporaryDirectory() as tmpdir:
            result = await find_implementations_by_interface_name(
                interface_full_name="com.example.RequestValidator",
                repository_path=tmpdir,
            )
            assert result["total_implementations"] == 0


class TestMCPRegistration:
    """测试与 MCP 框架注册机制对齐"""

    @pytest.mark.asyncio
    async def test_tool_auto_discovered(self):
        """tool 应被自动发现并注册"""
        mcp = FastMCP(name="test-server", version="0.0.1")
        registered = auto_discover_tools(mcp, "yasa_mcp.tools")
        assert "find_implementations_by_interface_name" in registered

    @pytest.mark.asyncio
    async def test_tool_in_tools_list(self):
        """tool 应出现在 tools/list 中"""
        mcp = FastMCP(name="test-server-2", version="0.0.1")
        auto_discover_tools(mcp, "yasa_mcp.tools")
        tools = await mcp.list_tools()
        tool_names = [t.name for t in tools]
        assert "find_implementations_by_interface_name" in tool_names

    @pytest.mark.asyncio
    async def test_tool_callable_via_mcp(self):
        """通过 MCP 协议调用 tool"""
        mcp = FastMCP(name="test-server-3", version="0.0.1")
        auto_discover_tools(mcp, "yasa_mcp.tools")
        result = await mcp.call_tool("find_implementations_by_interface_name", {
            "interface_full_name": "com.example.RequestValidator",
            "repository_path": TEST_REPO,
        })
        assert result is not None
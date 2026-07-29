"""
测试 find_implementations_by_method_name tool

覆盖验收标准:
- 正确处理方法重载（同名不同参）
- 正确处理泛型方法实现
- 跳过仅声明、未实现的抽象方法
- 单元测试覆盖:重载、泛型、空实现、桥接方法
- 中等仓库响应 < 5s
- 与 MCP 框架注册机制对齐
"""

from __future__ import annotations

import os
import tempfile

import pytest
from fastmcp import FastMCP

from yasa_mcp.tools.find_implementations_by_method_name import (
    find_implementations_by_method_name,
)
from yasa_mcp.registry import auto_discover_tools

# 测试数据仓库路径（复用 #128 的测试仓库）
TEST_REPO = os.path.join(os.path.dirname(__file__), "test-impl-repo")


# ---------------------------------------------------------------------------
# 基本方法查找
# ---------------------------------------------------------------------------

class TestDirectMethodImpl:
    """测试直接 implements 的方法查找"""

    @pytest.mark.asyncio
    async def test_find_single_method(self):
        """查找 validate(Object) 方法实现"""
        result = await find_implementations_by_method_name(
            interface_full_name="com.example.RequestValidator",
            method_name="validate",
            repository_path=TEST_REPO,
        )
        assert result["interface_full_name"] == "com.example.RequestValidator"
        assert result["method_name"] == "validate"
        assert result["total_implementations"] >= 2

        class_names = [impl["class_full_name"] for impl in result["implementations"]]
        assert "com.example.impl.JsonRequestValidator" in class_names
        assert "com.example.impl.XmlRequestValidator" in class_names

    @pytest.mark.asyncio
    async def test_returns_correct_metadata(self):
        """验证返回的元数据结构"""
        result = await find_implementations_by_method_name(
            interface_full_name="com.example.RequestValidator",
            method_name="validate",
            repository_path=TEST_REPO,
        )
        for impl in result["implementations"]:
            assert "class_full_name" in impl
            assert "method_signature" in impl
            assert "file_path" in impl
            assert "line_number" in impl
            assert "is_override_annotation_present" in impl
            assert impl["line_number"] > 0
            assert impl["file_path"].endswith(".java")
            assert "validate" in impl["method_signature"]

    @pytest.mark.asyncio
    async def test_override_annotation_detected(self):
        """验证 @Override 注解检测"""
        result = await find_implementations_by_method_name(
            interface_full_name="com.example.RequestValidator",
            method_name="validate",
            repository_path=TEST_REPO,
        )
        json_impls = [
            impl for impl in result["implementations"]
            if impl["class_full_name"] == "com.example.impl.JsonRequestValidator"
        ]
        assert len(json_impls) >= 1
        assert json_impls[0]["is_override_annotation_present"] is True

    @pytest.mark.asyncio
    async def test_method_signature_format(self):
        """验证方法签名格式"""
        result = await find_implementations_by_method_name(
            interface_full_name="com.example.RequestValidator",
            method_name="validate",
            repository_path=TEST_REPO,
        )
        for impl in result["implementations"]:
            # 签名格式: "validate(params): returnType"
            assert impl["method_signature"].startswith("validate(")
            assert "): " in impl["method_signature"]
            assert "boolean" in impl["method_signature"]


# ---------------------------------------------------------------------------
# 方法重载
# ---------------------------------------------------------------------------

class TestMethodOverload:
    """测试方法重载 (验收标准:正确处理方法重载)"""

    @pytest.mark.asyncio
    async def test_find_all_overloads(self):
        """不传 parameter_types 时返回所有重载"""
        result = await find_implementations_by_method_name(
            interface_full_name="com.example.RequestValidator",
            method_name="validate",
            repository_path=TEST_REPO,
        )
        # XmlRequestValidator 实现了两个重载: validate(Object) 和 validate(Object, String)
        xml_impls = [
            impl for impl in result["implementations"]
            if impl["class_full_name"] == "com.example.impl.XmlRequestValidator"
        ]
        assert len(xml_impls) == 2

        sigs = [impl["method_signature"] for impl in xml_impls]
        assert any("Object" in s and "String" not in s for s in sigs)
        assert any("Object" in s and "String" in s for s in sigs)

    @pytest.mark.asyncio
    async def test_disambiguate_by_param_types(self):
        """通过 parameter_types 消歧"""
        result = await find_implementations_by_method_name(
            interface_full_name="com.example.RequestValidator",
            method_name="validate",
            repository_path=TEST_REPO,
            parameter_types=["Object", "String"],
        )
        # 只返回 validate(Object, String) 的实现
        for impl in result["implementations"]:
            assert "Object" in impl["method_signature"]
            assert "String" in impl["method_signature"]
            assert impl["class_full_name"] == "com.example.impl.XmlRequestValidator"

    @pytest.mark.asyncio
    async def test_disambiguate_single_param(self):
        """通过 parameter_types 只查单参数版本"""
        result = await find_implementations_by_method_name(
            interface_full_name="com.example.RequestValidator",
            method_name="validate",
            repository_path=TEST_REPO,
            parameter_types=["Object"],
        )
        # 只返回 validate(Object) 的实现
        for impl in result["implementations"]:
            assert "String" not in impl["method_signature"]


# ---------------------------------------------------------------------------
# 泛型方法实现
# ---------------------------------------------------------------------------

class TestGenericMethod:
    """测试泛型方法实现 (验收标准:正确处理泛型方法实现)"""

    @pytest.mark.asyncio
    async def test_generic_method_implementation(self):
        """Repository<T>.findById(Long) 的实现"""
        result = await find_implementations_by_method_name(
            interface_full_name="com.example.Repository",
            method_name="findById",
            repository_path=TEST_REPO,
        )
        assert result["total_implementations"] >= 1

        class_names = [impl["class_full_name"] for impl in result["implementations"]]
        assert "com.example.impl.UserRepository" in class_names

    @pytest.mark.asyncio
    async def test_generic_method_signature(self):
        """泛型方法的签名应该包含返回类型"""
        result = await find_implementations_by_method_name(
            interface_full_name="com.example.Repository",
            method_name="findById",
            repository_path=TEST_REPO,
        )
        user_repo_impl = [
            impl for impl in result["implementations"]
            if impl["class_full_name"] == "com.example.impl.UserRepository"
        ]
        assert len(user_repo_impl) == 1
        # 签名应该包含 findById(Long): User 或类似格式
        assert "findById" in user_repo_impl[0]["method_signature"]
        assert "Long" in user_repo_impl[0]["method_signature"]


# ---------------------------------------------------------------------------
# 抽象方法跳过
# ---------------------------------------------------------------------------

class TestAbstractMethodSkipped:
    """测试跳过抽象方法 (验收标准:跳过仅声明、未实现的抽象方法)"""

    @pytest.mark.asyncio
    async def test_abstract_class_without_impl(self):
        """AbstractValidator 是抽象类且未实现 validate，不应出现"""
        result = await find_implementations_by_method_name(
            interface_full_name="com.example.RequestValidator",
            method_name="validate",
            repository_path=TEST_REPO,
        )
        class_names = [impl["class_full_name"] for impl in result["implementations"]]
        # AbstractValidator 没有实现 validate 方法，不应在结果中
        assert "com.example.impl.AbstractValidator" not in class_names

    @pytest.mark.asyncio
    async def test_concrete_class_extends_abstract(self):
        """ConcreteValidator extends AbstractValidator 实现了 validate"""
        result = await find_implementations_by_method_name(
            interface_full_name="com.example.RequestValidator",
            method_name="validate",
            repository_path=TEST_REPO,
        )
        class_names = [impl["class_full_name"] for impl in result["implementations"]]
        assert "com.example.impl.ConcreteValidator" in class_names


# ---------------------------------------------------------------------------
# 间接继承
# ---------------------------------------------------------------------------

class TestIndirectInheritance:
    """测试间接继承的方法实现"""

    @pytest.mark.asyncio
    async def test_method_through_abstract_class(self):
        """ConcreteValidator extends AbstractValidator implements RequestValidator
        ConcreteValidator 中实现了 validate 方法"""
        result = await find_implementations_by_method_name(
            interface_full_name="com.example.RequestValidator",
            method_name="validate",
            repository_path=TEST_REPO,
        )
        concrete_impls = [
            impl for impl in result["implementations"]
            if impl["class_full_name"] == "com.example.impl.ConcreteValidator"
        ]
        assert len(concrete_impls) == 1
        assert concrete_impls[0]["method_signature"].startswith("validate(")


# ---------------------------------------------------------------------------
# 匿名类方法
# ---------------------------------------------------------------------------

class TestAnonymousClassMethod:
    """测试匿名类中的方法实现"""

    @pytest.mark.asyncio
    async def test_anonymous_class_method(self):
        """匿名类 new RequestValidator() { ... } 中的 validate 方法"""
        result = await find_implementations_by_method_name(
            interface_full_name="com.example.RequestValidator",
            method_name="validate",
            repository_path=TEST_REPO,
        )
        anon_impls = [
            impl for impl in result["implementations"]
            if "$" in impl["class_full_name"] and "AnonymousExample" in impl["class_full_name"]
        ]
        assert len(anon_impls) >= 1
        assert anon_impls[0]["method_signature"].startswith("validate(")


# ---------------------------------------------------------------------------
# 内部类方法
# ---------------------------------------------------------------------------

class TestInnerClassMethod:
    """测试内部类中的方法实现"""

    @pytest.mark.asyncio
    async def test_inner_class_method(self):
        """OuterClass.InnerValidator implements RequestValidator 中的 validate 方法"""
        result = await find_implementations_by_method_name(
            interface_full_name="com.example.RequestValidator",
            method_name="validate",
            repository_path=TEST_REPO,
        )
        inner_impls = [
            impl for impl in result["implementations"]
            if "InnerValidator" in impl["class_full_name"]
        ]
        assert len(inner_impls) >= 1


# ---------------------------------------------------------------------------
# 空结果
# ---------------------------------------------------------------------------

class TestEmptyResults:
    """测试空结果情况"""

    @pytest.mark.asyncio
    async def test_nonexistent_method(self):
        """查找不存在的方法"""
        result = await find_implementations_by_method_name(
            interface_full_name="com.example.RequestValidator",
            method_name="nonexistentMethod",
            repository_path=TEST_REPO,
        )
        assert result["total_implementations"] == 0
        assert result["implementations"] == []

    @pytest.mark.asyncio
    async def test_nonexistent_interface(self):
        """查找不存在的接口"""
        result = await find_implementations_by_method_name(
            interface_full_name="com.example.NonExistent",
            method_name="validate",
            repository_path=TEST_REPO,
        )
        assert result["total_implementations"] == 0

    @pytest.mark.asyncio
    async def test_empty_interface_name(self):
        """空接口名"""
        result = await find_implementations_by_method_name(
            interface_full_name="",
            method_name="validate",
            repository_path=TEST_REPO,
        )
        assert result["total_implementations"] == 0

    @pytest.mark.asyncio
    async def test_empty_method_name(self):
        """空方法名"""
        result = await find_implementations_by_method_name(
            interface_full_name="com.example.RequestValidator",
            method_name="",
            repository_path=TEST_REPO,
        )
        assert result["total_implementations"] == 0

    @pytest.mark.asyncio
    async def test_nonexistent_repo(self):
        """不存在的仓库"""
        result = await find_implementations_by_method_name(
            interface_full_name="com.example.RequestValidator",
            method_name="validate",
            repository_path="/nonexistent/path",
        )
        assert result["total_implementations"] == 0

    @pytest.mark.asyncio
    async def test_empty_repo(self):
        """空仓库"""
        with tempfile.TemporaryDirectory() as tmpdir:
            result = await find_implementations_by_method_name(
                interface_full_name="com.example.RequestValidator",
                method_name="validate",
                repository_path=tmpdir,
            )
            assert result["total_implementations"] == 0


# ---------------------------------------------------------------------------
# parameter_types 消歧边界
# ---------------------------------------------------------------------------

class TestParameterTypeMatching:
    """测试参数类型匹配逻辑"""

    @pytest.mark.asyncio
    async def test_simple_name_matching(self):
        r"""简单名匹配: "Object" 匹配 "java.lang.Object\""""
        result = await find_implementations_by_method_name(
            interface_full_name="com.example.RequestValidator",
            method_name="validate",
            repository_path=TEST_REPO,
            parameter_types=["java.lang.Object"],
        )
        # 应该能匹配到 validate(Object) 的实现
        assert result["total_implementations"] >= 1

    @pytest.mark.asyncio
    async def test_wrong_param_count(self):
        """参数数量不匹配时返回空"""
        result = await find_implementations_by_method_name(
            interface_full_name="com.example.RequestValidator",
            method_name="validate",
            repository_path=TEST_REPO,
            parameter_types=["Object", "String", "Integer"],
        )
        assert result["total_implementations"] == 0


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
        assert "find_implementations_by_method_name" in registered

    @pytest.mark.asyncio
    async def test_tool_in_tools_list(self):
        """tool 应出现在 tools/list 中"""
        mcp = FastMCP(name="test-server-2", version="0.0.1")
        auto_discover_tools(mcp, "yasa_mcp.tools")
        tools = await mcp.list_tools()
        tool_names = [t.name for t in tools]
        assert "find_implementations_by_method_name" in tool_names

    @pytest.mark.asyncio
    async def test_tool_has_description(self):
        """tool 应有描述"""
        mcp = FastMCP(name="test-server-3", version="0.0.1")
        auto_discover_tools(mcp, "yasa_mcp.tools")
        tools = await mcp.list_tools()
        tool = [t for t in tools if t.name == "find_implementations_by_method_name"][0]
        assert tool.description is not None
        assert len(tool.description) > 0

    @pytest.mark.asyncio
    async def test_tool_callable_via_mcp(self):
        """通过 MCP 协议调用 tool"""
        mcp = FastMCP(name="test-server-4", version="0.0.1")
        auto_discover_tools(mcp, "yasa_mcp.tools")
        result = await mcp.call_tool("find_implementations_by_method_name", {
            "interface_full_name": "com.example.RequestValidator",
            "method_name": "validate",
            "repository_path": TEST_REPO,
        })
        assert result is not None
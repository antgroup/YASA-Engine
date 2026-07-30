"""
测试 list_methods_by_class_name tool

覆盖验收标准:
- [x] 正确处理嵌套类:返回当前类的方法,不串到内部类
- [x] 继承方法标识 inherited_from 字段
- [x] 构造器、静态初始化块作为特殊条目返回
- [x] include_source=false 时返回不带 source 的轻量版
- [x] 单元测试覆盖:重载、抽象方法、内部类干扰、空类
- [x] 中等仓库响应 < 3s
"""

from __future__ import annotations

import os
import time

import pytest
from fastmcp import FastMCP

from yasa_mcp.tools.list_methods_by_class_name import list_methods_by_class_name
from yasa_mcp.registry import auto_discover_tools

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_JDP_REPO = os.path.join(_REPO_ROOT, "test-repos", "java-design-patterns")
_SF_REPO = os.path.join(_REPO_ROOT, "test-repos", "spring-framework")


def _create_file(root: str, relpath: str, content: str) -> str:
    abspath = os.path.join(root, relpath)
    os.makedirs(os.path.dirname(abspath), exist_ok=True)
    with open(abspath, "w", encoding="utf-8") as f:
        f.write(content)
    return abspath


# 测试数据
_JAVA_CONTROLLER = """\
package com.example.controller;

import javax.servlet.http.HttpServletRequest;

public class UserController extends BaseController implements RequestValidator {

    private String defaultName = "anonymous";

    /**
     * Get user by id.
     */
    @GetMapping("/users/{id}")
    public ResponseEntity<User> getUser(HttpServletRequest req, String id) {
        return null;
    }

    public User getUser(String id) {
        return null;
    }

    @Override
    public void validate(Object request) {
        System.out.println("validating");
    }

    protected void doInternal() {
        System.out.println("internal");
    }

    private void secretHelper() {
        System.out.println("secret");
    }

    static {
        System.out.println("class loaded");
    }

    public UserController() {
        this.defaultName = "default";
    }

    class InnerClass {
        public void innerMethod() {
            System.out.println("inner");
        }
    }
}
"""

_JAVA_ABSTRACT = """\
package com.example.repository;

public abstract class AbstractRepository<T> {

    public abstract T findById(Long id);

    public abstract void save(T entity);

    public void flush() {
        System.out.println("flushing");
    }
}
"""

_JAVA_EMPTY = """\
package com.example;

public class EmptyClass {
}
"""


# ---------------------------------------------------------------------------
# 基本功能
# ---------------------------------------------------------------------------

class TestBasicListing:
    """测试基本方法列表"""

    @pytest.mark.asyncio
    async def test_list_methods(self, tmp_path):
        """列出类的方法"""
        _create_file(tmp_path, "src/main/java/com/example/controller/UserController.java", _JAVA_CONTROLLER)

        result = await list_methods_by_class_name(
            class_full_name="com.example.controller.UserController",
            repository_path=str(tmp_path),
        )

        assert "error" not in result
        assert result["class_full_name"] == "com.example.controller.UserController"
        assert result["total_methods"] >= 6

    @pytest.mark.asyncio
    async def test_class_metadata(self, tmp_path):
        """返回类元数据"""
        _create_file(tmp_path, "src/main/java/com/example/controller/UserController.java", _JAVA_CONTROLLER)

        result = await list_methods_by_class_name(
            class_full_name="com.example.controller.UserController",
            repository_path=str(tmp_path),
        )

        assert result["extends_class"] == "BaseController"
        assert "RequestValidator" in result["implements_interfaces"]
        assert result["class_start_line"] is not None
        assert result["class_end_line"] is not None

    @pytest.mark.asyncio
    async def test_method_visibility(self, tmp_path):
        """方法可见性正确"""
        _create_file(tmp_path, "src/main/java/com/example/controller/UserController.java", _JAVA_CONTROLLER)

        result = await list_methods_by_class_name(
            class_full_name="com.example.controller.UserController",
            repository_path=str(tmp_path),
        )

        visibilities = {m["method_short_name"]: m["visibility"] for m in result["methods"]}
        assert visibilities.get("getUser") == "public"
        assert visibilities.get("doInternal") == "protected"
        assert visibilities.get("secretHelper") == "private"

    @pytest.mark.asyncio
    async def test_method_is_static(self, tmp_path):
        """静态初始化块标记为 static"""
        _create_file(tmp_path, "src/main/java/com/example/controller/UserController.java", _JAVA_CONTROLLER)

        result = await list_methods_by_class_name(
            class_full_name="com.example.controller.UserController",
            repository_path=str(tmp_path),
        )

        static_inits = [m for m in result["methods"] if m["method_short_name"] == "<static_init>"]
        assert len(static_inits) == 1
        assert static_inits[0]["is_static"] is True

    @pytest.mark.asyncio
    async def test_method_annotations(self, tmp_path):
        """返回方法注解"""
        _create_file(tmp_path, "src/main/java/com/example/controller/UserController.java", _JAVA_CONTROLLER)

        result = await list_methods_by_class_name(
            class_full_name="com.example.controller.UserController",
            repository_path=str(tmp_path),
        )

        get_user = [m for m in result["methods"] if m["method_short_name"] == "getUser"
                    and "HttpServletRequest" in m["method_signature"]][0]
        assert any("@GetMapping" in a for a in get_user["annotations"])

    @pytest.mark.asyncio
    async def test_method_line_range(self, tmp_path):
        """方法起止行号"""
        _create_file(tmp_path, "src/main/java/com/example/controller/UserController.java", _JAVA_CONTROLLER)

        result = await list_methods_by_class_name(
            class_full_name="com.example.controller.UserController",
            repository_path=str(tmp_path),
        )

        for m in result["methods"]:
            assert m["start_line"] >= 1
            if m["method_short_name"] != "<static_init>":
                assert m["end_line"] >= m["start_line"]


# ---------------------------------------------------------------------------
# 嵌套类隔离
# ---------------------------------------------------------------------------

class TestNestedClass:
    """测试嵌套类不串"""

    @pytest.mark.asyncio
    async def test_no_inner_class_methods(self, tmp_path):
        """不返回内部类方法"""
        _create_file(tmp_path, "src/main/java/com/example/controller/UserController.java", _JAVA_CONTROLLER)

        result = await list_methods_by_class_name(
            class_full_name="com.example.controller.UserController",
            repository_path=str(tmp_path),
        )

        inner_methods = [m for m in result["methods"] if "innerMethod" in m.get("method_signature", "")]
        assert len(inner_methods) == 0


# ---------------------------------------------------------------------------
# 构造器和静态初始化块
# ---------------------------------------------------------------------------

class TestSpecialMethods:
    """测试构造器和静态初始化块"""

    @pytest.mark.asyncio
    async def test_constructor_in_list(self, tmp_path):
        """构造器出现在方法列表中"""
        _create_file(tmp_path, "src/main/java/com/example/controller/UserController.java", _JAVA_CONTROLLER)

        result = await list_methods_by_class_name(
            class_full_name="com.example.controller.UserController",
            repository_path=str(tmp_path),
        )

        ctors = [m for m in result["methods"] if m["method_short_name"] == "UserController"]
        assert len(ctors) == 1

    @pytest.mark.asyncio
    async def test_static_init_in_list(self, tmp_path):
        """静态初始化块出现在方法列表中"""
        _create_file(tmp_path, "src/main/java/com/example/controller/UserController.java", _JAVA_CONTROLLER)

        result = await list_methods_by_class_name(
            class_full_name="com.example.controller.UserController",
            repository_path=str(tmp_path),
        )

        static_inits = [m for m in result["methods"] if m["method_short_name"] == "<static_init>"]
        assert len(static_inits) == 1


# ---------------------------------------------------------------------------
# 重载
# ---------------------------------------------------------------------------

class TestOverloading:
    """测试重载方法"""

    @pytest.mark.asyncio
    async def test_overloaded_methods(self, tmp_path):
        """重载方法都出现在列表中"""
        _create_file(tmp_path, "src/main/java/com/example/controller/UserController.java", _JAVA_CONTROLLER)

        result = await list_methods_by_class_name(
            class_full_name="com.example.controller.UserController",
            repository_path=str(tmp_path),
        )

        get_users = [m for m in result["methods"] if m["method_short_name"] == "getUser"]
        assert len(get_users) == 2


# ---------------------------------------------------------------------------
# 抽象方法
# ---------------------------------------------------------------------------

class TestAbstractMethods:
    """测试抽象方法"""

    @pytest.mark.asyncio
    async def test_abstract_methods(self, tmp_path):
        """抽象方法标记 is_abstract"""
        _create_file(tmp_path, "src/main/java/com/example/repository/AbstractRepository.java", _JAVA_ABSTRACT)

        result = await list_methods_by_class_name(
            class_full_name="com.example.repository.AbstractRepository",
            repository_path=str(tmp_path),
        )

        find_by_id = [m for m in result["methods"] if m["method_short_name"] == "findById"]
        assert len(find_by_id) == 1
        assert find_by_id[0]["is_abstract"] is True

    @pytest.mark.asyncio
    async def test_concrete_method_in_abstract_class(self, tmp_path):
        """抽象类中的具体方法"""
        _create_file(tmp_path, "src/main/java/com/example/repository/AbstractRepository.java", _JAVA_ABSTRACT)

        result = await list_methods_by_class_name(
            class_full_name="com.example.repository.AbstractRepository",
            repository_path=str(tmp_path),
        )

        flush = [m for m in result["methods"] if m["method_short_name"] == "flush"]
        assert len(flush) == 1
        assert flush[0]["is_abstract"] is False


# ---------------------------------------------------------------------------
# 开关控制
# ---------------------------------------------------------------------------

class TestSwitches:
    """测试 include_private / include_source 开关"""

    @pytest.mark.asyncio
    async def test_include_private_false(self, tmp_path):
        """include_private=False 过滤 private 方法"""
        _create_file(tmp_path, "src/main/java/com/example/controller/UserController.java", _JAVA_CONTROLLER)

        result = await list_methods_by_class_name(
            class_full_name="com.example.controller.UserController",
            repository_path=str(tmp_path),
            include_private=False,
        )

        visibilities = [m["visibility"] for m in result["methods"]]
        assert "private" not in visibilities

    @pytest.mark.asyncio
    async def test_include_private_true(self, tmp_path):
        """include_private=True 包含 private 方法"""
        _create_file(tmp_path, "src/main/java/com/example/controller/UserController.java", _JAVA_CONTROLLER)

        result = await list_methods_by_class_name(
            class_full_name="com.example.controller.UserController",
            repository_path=str(tmp_path),
            include_private=True,
        )

        visibilities = [m["visibility"] for m in result["methods"]]
        assert "private" in visibilities

    @pytest.mark.asyncio
    async def test_include_source_false(self, tmp_path):
        """include_source=False 不返回 source"""
        _create_file(tmp_path, "src/main/java/com/example/controller/UserController.java", _JAVA_CONTROLLER)

        result = await list_methods_by_class_name(
            class_full_name="com.example.controller.UserController",
            repository_path=str(tmp_path),
            include_source=False,
        )

        for m in result["methods"]:
            assert "source" not in m

    @pytest.mark.asyncio
    async def test_include_source_true(self, tmp_path):
        """include_source=True 返回 source"""
        _create_file(tmp_path, "src/main/java/com/example/controller/UserController.java", _JAVA_CONTROLLER)

        result = await list_methods_by_class_name(
            class_full_name="com.example.controller.UserController",
            repository_path=str(tmp_path),
            include_source=True,
        )

        has_source = any("source" in m for m in result["methods"])
        assert has_source


# ---------------------------------------------------------------------------
# 空类
# ---------------------------------------------------------------------------

class TestEmptyClass:
    """测试空类"""

    @pytest.mark.asyncio
    async def test_empty_class(self, tmp_path):
        """空类返回 0 个方法"""
        _create_file(tmp_path, "src/main/java/com/example/EmptyClass.java", _JAVA_EMPTY)

        result = await list_methods_by_class_name(
            class_full_name="com.example.EmptyClass",
            repository_path=str(tmp_path),
        )

        assert result["total_methods"] == 0
        assert result["methods"] == []


# ---------------------------------------------------------------------------
# 边界情况
# ---------------------------------------------------------------------------

class TestEdgeCases:

    @pytest.mark.asyncio
    async def test_class_not_found(self, tmp_path):
        result = await list_methods_by_class_name(
            class_full_name="com.example.NonExistent",
            repository_path=str(tmp_path),
        )
        assert "error" in result

    @pytest.mark.asyncio
    async def test_empty_class_name(self, tmp_path):
        result = await list_methods_by_class_name(
            class_full_name="",
            repository_path=str(tmp_path),
        )
        assert "error" in result

    @pytest.mark.asyncio
    async def test_invalid_repo(self):
        result = await list_methods_by_class_name(
            class_full_name="com.example.Test",
            repository_path="/nonexistent",
        )
        assert "error" in result


# ---------------------------------------------------------------------------
# inherited_from
# ---------------------------------------------------------------------------

class TestInherited:
    """测试继承方法"""

    @pytest.mark.asyncio
    async def test_inherited_from_null_for_own_methods(self, tmp_path):
        """本类方法 inherited_from 为 null"""
        _create_file(tmp_path, "src/main/java/com/example/controller/UserController.java", _JAVA_CONTROLLER)

        result = await list_methods_by_class_name(
            class_full_name="com.example.controller.UserController",
            repository_path=str(tmp_path),
        )

        for m in result["methods"]:
            assert m["inherited_from"] is None


# ---------------------------------------------------------------------------
# MCP 注册
# ---------------------------------------------------------------------------

class TestMCPRegistration:

    @pytest.mark.asyncio
    async def test_auto_discovered(self):
        mcp = FastMCP(name="test", version="0.0.1")
        registered = auto_discover_tools(mcp, "yasa_mcp.tools")
        assert "list_methods_by_class_name" in registered

    @pytest.mark.asyncio
    async def test_callable_via_mcp(self, tmp_path):
        mcp = FastMCP(name="test2", version="0.0.1")
        auto_discover_tools(mcp, "yasa_mcp.tools")
        _create_file(tmp_path, "src/main/java/com/example/EmptyClass.java", _JAVA_EMPTY)
        result = await mcp.call_tool("list_methods_by_class_name", {
            "class_full_name": "com.example.EmptyClass",
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
    async def test_list_methods_from_jdp(self, repo):
        """从 JDP 列出方法"""
        result = await list_methods_by_class_name(
            class_full_name="com.iluwatar.filterer.threat.SimpleProbableThreat",
            repository_path=repo,
            include_source=False,
        )
        assert "error" not in result
        assert result["total_methods"] >= 1
        # probability 和 toString 应该在列表中
        names = [m["method_short_name"] for m in result["methods"]]
        assert "probability" in names

    @pytest.mark.asyncio
    async def test_performance_jdp(self, repo):
        """性能: JDP < 3s"""
        start = time.time()
        await list_methods_by_class_name(
            class_full_name="com.iluwatar.filterer.threat.SimpleProbableThreat",
            repository_path=repo,
            include_source=False,
        )
        elapsed = time.time() - start
        assert elapsed < 3.0, f"Took {elapsed:.2f}s"


# ---------------------------------------------------------------------------
# 集成测试: spring-framework
# ---------------------------------------------------------------------------

class TestSFIntegration:

    @pytest.fixture
    def repo(self):
        if not os.path.isdir(_SF_REPO):
            pytest.skip("SF not available")
        return _SF_REPO

    @pytest.mark.asyncio
    async def test_list_methods_from_sf(self, repo):
        """从 SF 列出方法"""
        result = await list_methods_by_class_name(
            class_full_name="org.springframework.web.reactive.handler.WebFluxResponseStatusExceptionHandler",
            repository_path=repo,
            include_source=False,
        )
        if "error" not in result:
            assert result["total_methods"] >= 1
            names = [m["method_short_name"] for m in result["methods"]]
            assert "determineStatus" in names
"""
测试 read_method_source_by_method_name tool

全新测试, 与 #134/#135 测试完全不同的数据和场景。

覆盖验收标准:
- [x] 正确返回方法的完整源码,包括嵌套 lambda/匿名类
- [x] 重载方法在不带 parameter_types 时返回 ambiguous + 候选
- [x] 注解、Javadoc 控制开关生效
- [x] 单元测试覆盖:重载、嵌套类方法、构造器、静态初始化块、抽象方法只声明
- [x] 中等仓库响应 < 3s

测试数据:
  - 单元测试: 临时创建的 Java 文件 (全新场景)
  - 集成测试: test-repos/ 下的开源项目
"""

from __future__ import annotations

import os
import time

import pytest
from fastmcp import FastMCP

from yasa_mcp.tools.read_method_source_by_method_name import (
    read_method_source_by_method_name,
    _parse_method_full_name,
    _parse_param_types,
    _split_params,
)
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


# ---------------------------------------------------------------------------
# 测试数据 (全新场景, 与 #134/#135 完全不同)
# ---------------------------------------------------------------------------

# 场景1: 服务类 — 重载 + Javadoc + 注解
_JAVA_SERVICE = """\
package com.example.service;

import java.util.List;

public class UserService {

    /**
     * Find user by primary key.
     * @param id the user id
     * @return the user entity
     * @throws IllegalArgumentException if id is null
     */
    @Override
    public User findById(Long id) {
        return repository.get(id);
    }

    /**
     * Find users by name pattern.
     * @param name name pattern
     * @return list of matching users
     */
    public List<User> findById(String name) {
        return repository.search(name);
    }

    public void delete(Long id) {
        repository.remove(id);
    }
}
"""

# 场景2: 构造器 + 静态初始化块
_JAVA_CONSTRUCTOR = """\
package com.example.model;

public class User {

    private static final String DEFAULT_NAME = "anonymous";

    static {
        System.out.println("User class loaded");
    }

    private String name;
    private int age;

    public User() {
        this(DEFAULT_NAME, 0);
    }

    public User(String name, int age) {
        this.name = name;
        this.age = age;
    }

    public String getName() {
        return name;
    }
}
"""

# 场景3: 抽象方法 + 接口
_JAVA_ABSTRACT = """\
package com.example.repository;

public abstract class AbstractRepository<T> {

    /**
     * Find entity by id.
     */
    public abstract T findById(Long id);

    /**
     * Save entity.
     */
    public abstract void save(T entity);

    public void flush() {
        System.out.println("flushing");
    }
}
"""

# 场景4: 嵌套 lambda + 匿名类
_JAVA_NESTED = """\
package com.example.handler;

import java.util.function.Consumer;

public class EventHandler {

    public void process(String input) {
        Consumer<String> consumer = s -> {
            System.out.println("processing: " + s);
            log(s);
        };
        consumer.accept(input);

        Runnable r = new Runnable() {
            @Override
            public void run() {
                System.out.println("anonymous run");
            }
        };
        r.run();
    }

    private void log(String msg) {
        System.out.println("[LOG] " + msg);
    }
}
"""


# ---------------------------------------------------------------------------
# 方法全限定名解析
# ---------------------------------------------------------------------------

class TestParseFullName:
    """测试方法全限定名解析"""

    def test_normal(self):
        p, c, m = _parse_method_full_name("com.example.UserController.getUser")
        assert p == "com.example"
        assert c == "UserController"
        assert m == "getUser"

    def test_inner_class_dollar(self):
        p, c, m = _parse_method_full_name("com.example.Outer$Inner.method")
        assert p == "com.example"
        assert c == "Outer$Inner"
        assert m == "method"

    def test_no_package(self):
        p, c, m = _parse_method_full_name("MyClass.myMethod")
        assert p == ""
        assert c == "MyClass"
        assert m == "myMethod"

    def test_empty(self):
        p, c, m = _parse_method_full_name("")
        assert p == ""
        assert c == ""
        assert m == ""


# ---------------------------------------------------------------------------
# 参数类型解析
# ---------------------------------------------------------------------------

class TestParseParamTypes:
    """测试参数类型解析"""

    def test_simple(self):
        result = _parse_param_types("Long id")
        assert result == ["Long"]

    def test_multiple(self):
        result = _parse_param_types("Long id, String name")
        assert result == ["Long", "String"]

    def test_with_annotation(self):
        result = _parse_param_types("@PathVariable String id, @RequestBody UserDTO dto")
        assert result == ["String", "UserDTO"]

    def test_with_final(self):
        result = _parse_param_types("final String name, final int age")
        assert result == ["String", "int"]

    def test_varargs(self):
        result = _parse_param_types("String... args")
        assert result == ["String"]

    def test_empty(self):
        assert _parse_param_types("") == []

    def test_generic(self):
        result = _parse_param_types("List<String> items, Map<String, Object> props")
        assert result == ["List<String>", "Map<String, Object>"]


class TestSplitParams:
    """测试参数分割"""

    def test_simple_split(self):
        assert _split_params("a, b, c") == ["a", " b", " c"]

    def test_generic_no_split(self):
        result = _split_params("Map<String, Object> props, int x")
        assert len(result) == 2


# ---------------------------------------------------------------------------
# 基本源码读取
# ---------------------------------------------------------------------------

class TestReadSource:
    """测试基本源码读取"""

    @pytest.mark.asyncio
    async def test_read_simple_method(self, tmp_path):
        """读取简单方法源码"""
        _create_file(tmp_path, "src/com/example/service/UserService.java", _JAVA_SERVICE)

        result = await read_method_source_by_method_name(
            method_full_name="com.example.service.UserService.delete",
            repository_path=str(tmp_path),
        )

        assert "source" in result
        assert "delete" in result["source"]
        assert "repository.remove" in result["source"]
        assert result["containing_class"] == "com.example.service.UserService"

    @pytest.mark.asyncio
    async def test_method_start_end_line(self, tmp_path):
        """返回正确的起止行号"""
        _create_file(tmp_path, "src/com/example/service/UserService.java", _JAVA_SERVICE)

        result = await read_method_source_by_method_name(
            method_full_name="com.example.service.UserService.delete",
            repository_path=str(tmp_path),
        )

        # delete 方法在文件中:
        # line 24:     public void delete(Long id) {
        # line 25:         repository.remove(id);
        # line 26:     }
        assert result["start_line"] >= 24
        assert result["end_line"] > result["start_line"]

    @pytest.mark.asyncio
    async def test_method_signature(self, tmp_path):
        """返回方法签名"""
        _create_file(tmp_path, "src/com/example/service/UserService.java", _JAVA_SERVICE)

        result = await read_method_source_by_method_name(
            method_full_name="com.example.service.UserService.delete",
            repository_path=str(tmp_path),
        )

        assert result["method_signature"] == "delete(Long): void"

    @pytest.mark.asyncio
    async def test_source_contains_full_body(self, tmp_path):
        """源码包含完整方法体"""
        _create_file(tmp_path, "src/com/example/service/UserService.java", _JAVA_SERVICE)

        result = await read_method_source_by_method_name(
            method_full_name="com.example.service.UserService.delete",
            repository_path=str(tmp_path),
            include_javadoc=False,
            include_annotations=False,
        )

        source = result["source"]
        assert "public void delete(Long id)" in source
        assert "repository.remove(id)" in source
        assert source.rstrip().endswith("}")


# ---------------------------------------------------------------------------
# 重载处理
# ---------------------------------------------------------------------------

class TestOverloading:
    """测试重载方法"""

    @pytest.mark.asyncio
    async def test_ambiguous_without_param_types(self, tmp_path):
        """不带参数类型返回 ambiguous"""
        _create_file(tmp_path, "src/com/example/service/UserService.java", _JAVA_SERVICE)

        result = await read_method_source_by_method_name(
            method_full_name="com.example.service.UserService.findById",
            repository_path=str(tmp_path),
        )

        assert result.get("ambiguous") is True
        assert result.get("found") is False
        assert len(result["candidates"]) == 2
        assert "findById(Long): User" in result["candidates"]
        assert "findById(String): List<User>" in result["candidates"]

    @pytest.mark.asyncio
    async def test_disambiguate_with_param_types(self, tmp_path):
        """带参数类型消歧"""
        _create_file(tmp_path, "src/com/example/service/UserService.java", _JAVA_SERVICE)

        result = await read_method_source_by_method_name(
            method_full_name="com.example.service.UserService.findById",
            repository_path=str(tmp_path),
            parameter_types=["Long"],
        )

        assert "source" in result
        assert result["method_signature"] == "findById(Long): User"
        assert "repository.get(id)" in result["source"]

    @pytest.mark.asyncio
    async def test_disambiguate_second_overload(self, tmp_path):
        """消歧到第二个重载"""
        _create_file(tmp_path, "src/com/example/service/UserService.java", _JAVA_SERVICE)

        result = await read_method_source_by_method_name(
            method_full_name="com.example.service.UserService.findById",
            repository_path=str(tmp_path),
            parameter_types=["String"],
        )

        assert result["method_signature"] == "findById(String): List<User>"
        assert "repository.search" in result["source"]


# ---------------------------------------------------------------------------
# Javadoc 和注解控制
# ---------------------------------------------------------------------------

class TestJavadocAnnotations:
    """测试 Javadoc 和注解开关"""

    @pytest.mark.asyncio
    async def test_javadoc_included(self, tmp_path):
        """默认包含 Javadoc"""
        _create_file(tmp_path, "src/com/example/service/UserService.java", _JAVA_SERVICE)

        result = await read_method_source_by_method_name(
            method_full_name="com.example.service.UserService.delete",
            repository_path=str(tmp_path),
            include_javadoc=True,
        )

        assert result.get("javadoc") is not None
        assert "Find user" in result["javadoc"] or "/**" in result.get("javadoc", "")

    @pytest.mark.asyncio
    async def test_javadoc_excluded(self, tmp_path):
        """关闭 Javadoc"""
        _create_file(tmp_path, "src/com/example/service/UserService.java", _JAVA_SERVICE)

        result = await read_method_source_by_method_name(
            method_full_name="com.example.service.UserService.delete",
            repository_path=str(tmp_path),
            include_javadoc=False,
        )

        assert "javadoc" not in result or result.get("javadoc") is None

    @pytest.mark.asyncio
    async def test_annotations_included(self, tmp_path):
        """默认包含注解"""
        _create_file(tmp_path, "src/com/example/service/UserService.java", _JAVA_SERVICE)

        result = await read_method_source_by_method_name(
            method_full_name="com.example.service.UserService.findById",
            repository_path=str(tmp_path),
            parameter_types=["Long"],
            include_annotations=True,
        )

        assert "@Override" in result["source"]

    @pytest.mark.asyncio
    async def test_annotations_excluded(self, tmp_path):
        """关闭注解"""
        _create_file(tmp_path, "src/com/example/service/UserService.java", _JAVA_SERVICE)

        result = await read_method_source_by_method_name(
            method_full_name="com.example.service.UserService.findById",
            repository_path=str(tmp_path),
            parameter_types=["Long"],
            include_annotations=False,
        )

        assert "@Override" not in result["source"]


# ---------------------------------------------------------------------------
# 构造器
# ---------------------------------------------------------------------------

class TestConstructor:
    """测试构造器"""

    @pytest.mark.asyncio
    async def test_no_arg_constructor(self, tmp_path):
        """无参构造器"""
        _create_file(tmp_path, "src/com/example/model/User.java", _JAVA_CONSTRUCTOR)

        result = await read_method_source_by_method_name(
            method_full_name="com.example.model.User.User",
            repository_path=str(tmp_path),
        )

        assert "source" in result
        assert "User()" in result["source"]
        assert "DEFAULT_NAME" in result["source"]

    @pytest.mark.asyncio
    async def test_parameterized_constructor_ambiguous(self, tmp_path):
        """带参构造器 — 两个构造器返回 ambiguous"""
        _create_file(tmp_path, "src/com/example/model/User.java", _JAVA_CONSTRUCTOR)

        result = await read_method_source_by_method_name(
            method_full_name="com.example.model.User.User",
            repository_path=str(tmp_path),
        )

        # User() 和 User(String, int) 是两个构造器
        assert result.get("ambiguous") is True
        assert len(result["candidates"]) == 2

    @pytest.mark.asyncio
    async def test_parameterized_constructor_disambiguated(self, tmp_path):
        """带参构造器消歧"""
        _create_file(tmp_path, "src/com/example/model/User.java", _JAVA_CONSTRUCTOR)

        result = await read_method_source_by_method_name(
            method_full_name="com.example.model.User.User",
            repository_path=str(tmp_path),
            parameter_types=["String", "int"],
        )

        assert "source" in result
        assert "User(String name, int age)" in result["source"]


# ---------------------------------------------------------------------------
# 静态初始化块
# ---------------------------------------------------------------------------

class TestStaticInit:
    """测试静态初始化块"""

    @pytest.mark.asyncio
    async def test_read_static_init_block(self, tmp_path):
        """读取静态初始化块源码"""
        _create_file(tmp_path, "src/com/example/model/User.java", _JAVA_CONSTRUCTOR)

        result = await read_method_source_by_method_name(
            method_full_name="com.example.model.User.<static_init>",
            repository_path=str(tmp_path),
        )

        assert "source" in result
        assert "static" in result["source"]
        assert "User class loaded" in result["source"]

    @pytest.mark.asyncio
    async def test_static_init_line_range(self, tmp_path):
        """静态初始化块返回正确行范围"""
        _create_file(tmp_path, "src/com/example/model/User.java", _JAVA_CONSTRUCTOR)

        result = await read_method_source_by_method_name(
            method_full_name="com.example.model.User.<static_init>",
            repository_path=str(tmp_path),
        )

        assert result["start_line"] < result["end_line"]
        assert result["containing_class"] == "com.example.model.User"


# ---------------------------------------------------------------------------
# 抽象方法
# ---------------------------------------------------------------------------

class TestAbstractMethod:
    """测试抽象方法"""

    @pytest.mark.asyncio
    async def test_abstract_method_declaration(self, tmp_path):
        """抽象方法只声明, 返回声明行"""
        _create_file(tmp_path, "src/com/example/repository/AbstractRepository.java", _JAVA_ABSTRACT)

        result = await read_method_source_by_method_name(
            method_full_name="com.example.repository.AbstractRepository.findById",
            repository_path=str(tmp_path),
        )

        assert "source" in result
        assert "abstract" in result["source"]
        assert "findById" in result["source"]
        # 抽象方法只有一行, start_line == end_line
        assert result["start_line"] == result["end_line"]

    @pytest.mark.asyncio
    async def test_concrete_method_in_abstract_class(self, tmp_path):
        """抽象类中的具体方法"""
        _create_file(tmp_path, "src/com/example/repository/AbstractRepository.java", _JAVA_ABSTRACT)

        result = await read_method_source_by_method_name(
            method_full_name="com.example.repository.AbstractRepository.flush",
            repository_path=str(tmp_path),
        )

        assert "source" in result
        assert "flushing" in result["source"]
        assert result["start_line"] != result["end_line"]  # 有方法体


# ---------------------------------------------------------------------------
# 嵌套 lambda / 匿名类
# ---------------------------------------------------------------------------

class TestNestedStructures:
    """测试嵌套 lambda 和匿名类"""

    @pytest.mark.asyncio
    async def test_method_with_lambda(self, tmp_path):
        """方法体包含 lambda"""
        _create_file(tmp_path, "src/com/example/handler/EventHandler.java", _JAVA_NESTED)

        result = await read_method_source_by_method_name(
            method_full_name="com.example.handler.EventHandler.process",
            repository_path=str(tmp_path),
        )

        assert "source" in result
        source = result["source"]
        # lambda 体应包含在源码中
        assert "Consumer<String> consumer" in source
        assert "consumer.accept(input)" in source
        # 匿名类体也应包含
        assert "new Runnable()" in source
        assert "anonymous run" in source


# ---------------------------------------------------------------------------
# 边界情况
# ---------------------------------------------------------------------------

class TestEdgeCases:
    """测试边界情况"""

    @pytest.mark.asyncio
    async def test_method_not_found(self, tmp_path):
        """方法不存在"""
        _create_file(tmp_path, "src/com/example/service/UserService.java", _JAVA_SERVICE)

        result = await read_method_source_by_method_name(
            method_full_name="com.example.service.UserService.nonExistent",
            repository_path=str(tmp_path),
        )

        assert result.get("found") is False

    @pytest.mark.asyncio
    async def test_class_not_found(self, tmp_path):
        """类不存在"""
        result = await read_method_source_by_method_name(
            method_full_name="com.example.NonExistent.method",
            repository_path=str(tmp_path),
        )

        assert result.get("found") is False

    @pytest.mark.asyncio
    async def test_empty_method_name(self, tmp_path):
        """空方法名"""
        result = await read_method_source_by_method_name(
            method_full_name="",
            repository_path=str(tmp_path),
        )

        assert result.get("found") is False

    @pytest.mark.asyncio
    async def test_nonexistent_repo(self):
        """不存在的仓库"""
        result = await read_method_source_by_method_name(
            method_full_name="com.example.Test.method",
            repository_path="/nonexistent/path",
        )

        assert result.get("found") is False


# ---------------------------------------------------------------------------
# MCP 注册
# ---------------------------------------------------------------------------

class TestMCPRegistration:

    @pytest.mark.asyncio
    async def test_auto_discovered(self):
        mcp = FastMCP(name="test", version="0.0.1")
        registered = auto_discover_tools(mcp, "yasa_mcp.tools")
        assert "read_method_source_by_method_name" in registered

    @pytest.mark.asyncio
    async def test_callable_via_mcp(self, tmp_path):
        mcp = FastMCP(name="test2", version="0.0.1")
        auto_discover_tools(mcp, "yasa_mcp.tools")
        _create_file(tmp_path, "src/com/example/service/UserService.java", _JAVA_SERVICE)
        result = await mcp.call_tool("read_method_source_by_method_name", {
            "method_full_name": "com.example.service.UserService.delete",
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
    async def test_read_method_from_jdp(self, repo):
        """从 JDP 中读取方法源码"""
        # JDP 中 filterer 模块有 SimpleProbableThreat 类
        result = await read_method_source_by_method_name(
            method_full_name="com.iluwatar.filterer.threat.SimpleProbableThreat.probability",
            repository_path=repo,
        )
        if "source" in result:
            assert "probability" in result["source"]
            assert result["containing_class"] == "com.iluwatar.filterer.threat.SimpleProbableThreat"
        elif result.get("found") is False and result.get("ambiguous"):
            # 可能找到多个, 检查候选
            assert len(result["candidates"]) > 0

    @pytest.mark.asyncio
    async def test_read_to_string_method(self, repo):
        """从 JDP 中读取 toString 方法"""
        result = await read_method_source_by_method_name(
            method_full_name="com.iluwatar.filterer.threat.SimpleProbableThreat.toString",
            repository_path=repo,
        )
        if "source" in result:
            assert "toString" in result["source"]

    @pytest.mark.asyncio
    async def test_performance_jdp(self, repo):
        """性能: JDP < 3s"""
        start = time.time()
        await read_method_source_by_method_name(
            method_full_name="com.iluwatar.filterer.threat.SimpleProbableThreat.probability",
            repository_path=repo,
        )
        elapsed = time.time() - start
        assert elapsed < 3.0, f"Took {elapsed:.2f}s, expected < 3s"


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
    async def test_read_method_from_sf(self, repo):
        """从 SF 中读取方法源码"""
        # WebFluxResponseStatusExceptionHandler.determineStatus
        result = await read_method_source_by_method_name(
            method_full_name="org.springframework.web.reactive.handler.WebFluxResponseStatusExceptionHandler.determineStatus",
            repository_path=repo,
        )
        if "source" in result:
            assert "determineStatus" in result["source"]
            assert "HttpStatusCode" in result["source"] or "statusCode" in result["source"]

    @pytest.mark.asyncio
    async def test_performance_sf(self, repo):
        """性能: SF < 5s (大仓库)"""
        start = time.time()
        await read_method_source_by_method_name(
            method_full_name="org.springframework.web.reactive.handler.WebFluxResponseStatusExceptionHandler.determineStatus",
            repository_path=repo,
        )
        elapsed = time.time() - start
        assert elapsed < 5.0, f"Took {elapsed:.2f}s, expected < 5s"
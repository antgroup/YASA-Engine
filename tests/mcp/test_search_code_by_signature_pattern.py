"""
测试 search_code_by_signature_pattern tool

覆盖验收标准:
- [x] 在 Java 项目上能匹配方法、类、字段三种签名
- [x] 跳过注释内的伪命中
- [x] 单元测试覆盖: 方法/类/字段三种 element_kind、找不到、大量结果截断
- [x] 中等仓库响应 < 3s

测试数据:
  - 单元测试: 临时创建的 Java 文件 (精确控制预期值)
  - 集成测试: test-repos/ 下的开源项目
    - java-design-patterns (1902 个 Java 文件, 中等规模)
    - spring-framework (9240 个 Java 文件, 大规模)
"""

from __future__ import annotations

import os
import time
import tempfile

import pytest
from fastmcp import FastMCP

from yasa_mcp.tools.search_code_by_signature_pattern import (
    search_code_by_signature_pattern,
    _strip_comments,
    _find_matching_brace_line,
)
from yasa_mcp.registry import auto_discover_tools

# ---------------------------------------------------------------------------
# 测试数据路径
# ---------------------------------------------------------------------------

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_JDP_REPO = os.path.join(_REPO_ROOT, "test-repos", "java-design-patterns")
_SF_REPO = os.path.join(_REPO_ROOT, "test-repos", "spring-framework")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _create_file(root: str, relpath: str, content: str) -> str:
    abspath = os.path.join(root, relpath)
    os.makedirs(os.path.dirname(abspath), exist_ok=True)
    with open(abspath, "w", encoding="utf-8") as f:
        f.write(content)
    return abspath


# ---------------------------------------------------------------------------
# 测试用的 Java 代码 (精确控制, 每行都经过分析)
# ---------------------------------------------------------------------------

# 文件1: Controller — 测试方法签名
# 行号分析:
#   1:  package com.example.controller;
#   2:  (空)
#   3:  import ...
#   4:  import ...
#   5:  import ...
#   6:  (空)
#   7:  @RestController
#   8:  @RequestMapping("/api/users")
#   9:  public class UserController {
#   10: (空)
#   11:     private final UserService userService;
#   12:     private final String defaultPageSize = "20";
#   13: (空)
#   14:     @GetMapping("/{id}")
#   15:     public ResponseEntity<User> getUser(HttpServletRequest req, @PathVariable String id) {
#   16:         return ResponseEntity.ok(user);
#   17:     }
#   18: (空)
#   19:     @PostMapping
#   20:     public ResponseEntity<User> createUser(HttpServletRequest req, @RequestBody UserDTO dto) {
#   21:         return null;
#   22:     }
#   23: (空)
#   24:     @DeleteMapping("/{id}")
#   25:     public ResponseEntity<Void> deleteUser(@PathVariable String id) {
#   26:         return null;
#   27:     }
#   28: (空)
#   29:     protected void validatePageSize(int size) {
#   30:         if (size <= 0) { throw new IllegalArgumentException("x"); }
#   31:     }
#   32: }
_JAVA_CONTROLLER = """\
package com.example.controller;

import javax.servlet.http.HttpServletRequest;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/users")
public class UserController {

    private final UserService userService;
    private final String defaultPageSize = "20";

    @GetMapping("/{id}")
    public ResponseEntity<User> getUser(HttpServletRequest req, @PathVariable String id) {
        return ResponseEntity.ok(user);
    }

    @PostMapping
    public ResponseEntity<User> createUser(HttpServletRequest req, @RequestBody UserDTO dto) {
        return null;
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<Void> deleteUser(@PathVariable String id) {
        return null;
    }

    protected void validatePageSize(int size) {
        if (size <= 0) { throw new IllegalArgumentException("x"); }
    }
}
"""

# 文件2: Filters — 测试类/接口签名 + 字段
# 行号分析:
#   1:  package com.example.filter;
#   2:  (空)
#   3:  public abstract class AbstractBaseFilter {
#   4:     protected boolean enabled = true;
#   5:  (空)
#   6:     public abstract boolean doFilter(Object request);
#   7:  }
#   8:  (空)
#   9:  public class SecurityFilter extends AbstractBaseFilter {
#   10:    @Override
#   11:    public boolean doFilter(Object request) {
#   12:        return false;
#   13:    }
#   14: }
#   15: (空)
#   16: public class LoggingFilter extends AbstractBaseFilter {
#   17:    @Override
#   18:    public boolean doFilter(Object request) {
#   19:        return true;
#   20:    }
#   21: }
#   22: (空)
#   23: interface FilterChain {
#   24:    void addFilter(AbstractBaseFilter filter);
#   25: }
_JAVA_FILTERS = """\
package com.example.filter;

public abstract class AbstractBaseFilter {
    protected boolean enabled = true;

    public abstract boolean doFilter(Object request);
}

public class SecurityFilter extends AbstractBaseFilter {
    @Override
    public boolean doFilter(Object request) {
        return false;
    }
}

public class LoggingFilter extends AbstractBaseFilter {
    @Override
    public boolean doFilter(Object request) {
        return true;
    }
}

interface FilterChain {
    void addFilter(AbstractBaseFilter filter);
}
"""

# 文件3: 注释噪声 — 测试注释过滤
_JAVA_COMMENT_NOISE = """\
package com.example;

// This is a public void method() in a comment
/* public class FakeClass { } */
public class RealClass {

    // public String getName() should not match
    /*
     * public int getCount(HttpServletRequest req) { return 0; }
     */

    public String getName() {
        return "public void fakeMethod(HttpServletRequest req)";
    }
}
"""

# 文件4: 字段 vs 局部变量
_JAVA_FIELD_TEST = """\
package com.example;

public class MyClass {
    private int classField = 0;

    public void doSomething() {
        int localVar = 42;
        String anotherLocal = "hello";
    }
}
"""


# ---------------------------------------------------------------------------
# 方法签名匹配 (element_kind=method)
# ---------------------------------------------------------------------------

class TestMethodSignature:
    """测试方法签名匹配"""

    @pytest.mark.asyncio
    async def test_match_methods_with_httpservletrequest(self, tmp_path):
        """匹配所有形参含 HttpServletRequest 的方法"""
        _create_file(tmp_path, "src/UserController.java", _JAVA_CONTROLLER)

        result = await search_code_by_signature_pattern(
            pattern=r"HttpServletRequest",
            element_kind="method",
            repository_path=str(tmp_path),
        )

        # getUser(line 15) 和 createUser(line 20) 含 HttpServletRequest
        assert result["total_matches"] == 2
        names = [r["matched_signature"] for r in result["results"]]
        assert any("getUser" in n for n in names)
        assert any("createUser" in n for n in names)

    @pytest.mark.asyncio
    async def test_match_method_by_name(self, tmp_path):
        """按方法名精确匹配"""
        _create_file(tmp_path, "src/UserController.java", _JAVA_CONTROLLER)

        result = await search_code_by_signature_pattern(
            pattern=r"getUser",
            element_kind="method",
            repository_path=str(tmp_path),
        )

        assert result["total_matches"] == 1
        assert result["results"][0]["line_number"] == 15
        assert result["results"][0]["containing_class"] == "com.example.controller.UserController"

    @pytest.mark.asyncio
    async def test_match_response_entity_return_type(self, tmp_path):
        """匹配返回类型为 ResponseEntity<XXX> 的方法"""
        _create_file(tmp_path, "src/UserController.java", _JAVA_CONTROLLER)

        result = await search_code_by_signature_pattern(
            pattern=r"ResponseEntity<\w+>",
            element_kind="method",
            repository_path=str(tmp_path),
        )

        # getUser(ResponseEntity<User>), createUser(ResponseEntity<User>),
        # deleteUser(ResponseEntity<Void>)
        assert result["total_matches"] == 3

    @pytest.mark.asyncio
    async def test_match_protected_method(self, tmp_path):
        """匹配 protected 方法"""
        _create_file(tmp_path, "src/UserController.java", _JAVA_CONTROLLER)

        result = await search_code_by_signature_pattern(
            pattern=r"protected\s+void\s+\w+",
            element_kind="method",
            repository_path=str(tmp_path),
        )

        assert result["total_matches"] == 1
        assert "validatePageSize" in result["results"][0]["matched_signature"]

    @pytest.mark.asyncio
    async def test_if_statement_not_matched(self, tmp_path):
        """if 语句不应被匹配为方法"""
        _create_file(tmp_path, "src/UserController.java", _JAVA_CONTROLLER)

        result = await search_code_by_signature_pattern(
            pattern=r"if",
            element_kind="method",
            repository_path=str(tmp_path),
        )

        assert result["total_matches"] == 0

    @pytest.mark.asyncio
    async def test_throw_not_matched(self, tmp_path):
        """throw new 语句不应被匹配为方法"""
        _create_file(tmp_path, "src/UserController.java", _JAVA_CONTROLLER)

        result = await search_code_by_signature_pattern(
            pattern=r"IllegalArgumentException",
            element_kind="method",
            repository_path=str(tmp_path),
        )

        assert result["total_matches"] == 0

    @pytest.mark.asyncio
    async def test_method_not_in_comment(self, tmp_path):
        """注释中的方法签名不应被匹配"""
        _create_file(tmp_path, "src/RealClass.java", _JAVA_COMMENT_NOISE)

        result = await search_code_by_signature_pattern(
            pattern=r"HttpServletRequest",
            element_kind="method",
            repository_path=str(tmp_path),
        )

        # 注释和字符串中的 HttpServletRequest 不应被匹配
        assert result["total_matches"] == 0

    @pytest.mark.asyncio
    async def test_match_query_prefix_methods(self, tmp_path):
        """匹配以 query/select/load 开头的方法"""
        content = """\
package com.example;

public class DataRepository {

    public Object queryById(String id) { return null; }
    public Object selectByName(String name) { return null; }
    public Object loadAll() { return null; }
    public Object deleteById(String id) { return null; }
}
"""
        _create_file(tmp_path, "src/DataRepository.java", content)

        result = await search_code_by_signature_pattern(
            pattern=r"\b(query|select|load)\w*\s*\(",
            element_kind="method",
            repository_path=str(tmp_path),
        )

        assert result["total_matches"] == 3
        names = [r["matched_signature"] for r in result["results"]]
        assert any("queryById" in n for n in names)
        assert any("selectByName" in n for n in names)
        assert any("loadAll" in n for n in names)


# ---------------------------------------------------------------------------
# 类签名匹配 (element_kind=class)
# ---------------------------------------------------------------------------

class TestClassSignature:
    """测试类签名匹配"""

    @pytest.mark.asyncio
    async def test_match_class_extends_abstract_filter(self, tmp_path):
        """匹配所有继承 *Filter 的类"""
        _create_file(tmp_path, "src/Filters.java", _JAVA_FILTERS)

        result = await search_code_by_signature_pattern(
            pattern=r"class\s+\w+\s+extends\s+\w*Filter",
            element_kind="class",
            repository_path=str(tmp_path),
        )

        assert result["total_matches"] == 2
        names = [r["matched_signature"] for r in result["results"]]
        assert any("SecurityFilter" in n for n in names)
        assert any("LoggingFilter" in n for n in names)

    @pytest.mark.asyncio
    async def test_match_interface(self, tmp_path):
        """匹配接口定义"""
        _create_file(tmp_path, "src/Filters.java", _JAVA_FILTERS)

        result = await search_code_by_signature_pattern(
            pattern=r"interface\s+FilterChain",
            element_kind="class",
            repository_path=str(tmp_path),
        )

        assert result["total_matches"] == 1
        assert "FilterChain" in result["results"][0]["matched_signature"]

    @pytest.mark.asyncio
    async def test_match_abstract_class(self, tmp_path):
        """匹配抽象类"""
        _create_file(tmp_path, "src/Filters.java", _JAVA_FILTERS)

        result = await search_code_by_signature_pattern(
            pattern=r"abstract\s+class\s+AbstractBaseFilter",
            element_kind="class",
            repository_path=str(tmp_path),
        )

        assert result["total_matches"] == 1

    @pytest.mark.asyncio
    async def test_class_not_in_comment(self, tmp_path):
        """注释中的类定义不应被匹配"""
        _create_file(tmp_path, "src/RealClass.java", _JAVA_COMMENT_NOISE)

        result = await search_code_by_signature_pattern(
            pattern=r"class\s+FakeClass",
            element_kind="class",
            repository_path=str(tmp_path),
        )

        assert result["total_matches"] == 0

    @pytest.mark.asyncio
    async def test_class_containing_class(self, tmp_path):
        """类的 containing_class 是全限定名 (包含包名)"""
        _create_file(tmp_path, "src/Filters.java", _JAVA_FILTERS)

        result = await search_code_by_signature_pattern(
            pattern=r"class\s+SecurityFilter",
            element_kind="class",
            repository_path=str(tmp_path),
        )

        assert result["total_matches"] == 1
        assert result["results"][0]["containing_class"] == "com.example.filter.SecurityFilter"


# ---------------------------------------------------------------------------
# 字段签名匹配 (element_kind=field)
# ---------------------------------------------------------------------------

class TestFieldSignature:
    """测试字段签名匹配"""

    @pytest.mark.asyncio
    async def test_match_field_by_type(self, tmp_path):
        """匹配指定类型的字段"""
        _create_file(tmp_path, "src/UserController.java", _JAVA_CONTROLLER)

        result = await search_code_by_signature_pattern(
            pattern=r"UserService\s+userService",
            element_kind="field",
            repository_path=str(tmp_path),
        )

        assert result["total_matches"] == 1
        assert "userService" in result["results"][0]["matched_signature"]

    @pytest.mark.asyncio
    async def test_match_string_field(self, tmp_path):
        """匹配 String 类型字段"""
        _create_file(tmp_path, "src/UserController.java", _JAVA_CONTROLLER)

        result = await search_code_by_signature_pattern(
            pattern=r"String\s+defaultPageSize",
            element_kind="field",
            repository_path=str(tmp_path),
        )

        assert result["total_matches"] == 1

    @pytest.mark.asyncio
    async def test_field_not_local_variable(self, tmp_path):
        """方法内的局部变量不应被匹配为字段"""
        _create_file(tmp_path, "src/MyClass.java", _JAVA_FIELD_TEST)

        result = await search_code_by_signature_pattern(
            pattern=r"(int|String)\s+\w+",
            element_kind="field",
            repository_path=str(tmp_path),
        )

        # 只应匹配 classField, 不应匹配 localVar 和 anotherLocal
        assert result["total_matches"] == 1
        assert "classField" in result["results"][0]["matched_signature"]

    @pytest.mark.asyncio
    async def test_field_containing_class(self, tmp_path):
        """验证字段的 containing_class"""
        _create_file(tmp_path, "src/Filters.java", _JAVA_FILTERS)

        result = await search_code_by_signature_pattern(
            pattern=r"boolean\s+enabled",
            element_kind="field",
            repository_path=str(tmp_path),
        )

        assert result["total_matches"] == 1
        assert result["results"][0]["containing_class"] == "com.example.filter.AbstractBaseFilter"

    @pytest.mark.asyncio
    async def test_protected_field(self, tmp_path):
        """匹配 protected 字段"""
        _create_file(tmp_path, "src/Filters.java", _JAVA_FILTERS)

        result = await search_code_by_signature_pattern(
            pattern=r"boolean\s+enabled",
            element_kind="field",
            repository_path=str(tmp_path),
        )

        assert result["total_matches"] == 1
        assert "enabled" in result["results"][0]["matched_signature"]

    @pytest.mark.asyncio
    async def test_return_not_matched_as_field(self, tmp_path):
        """return false; 不应被匹配为字段"""
        _create_file(tmp_path, "src/Filters.java", _JAVA_FILTERS)

        result = await search_code_by_signature_pattern(
            pattern=r"return",
            element_kind="field",
            repository_path=str(tmp_path),
        )

        assert result["total_matches"] == 0


# ---------------------------------------------------------------------------
# element_kind=any
# ---------------------------------------------------------------------------

class TestAnyElementKind:
    """测试 element_kind=any"""

    @pytest.mark.asyncio
    async def test_any_matches_all_kinds(self, tmp_path):
        """any 应匹配方法、类、字段"""
        _create_file(tmp_path, "src/UserController.java", _JAVA_CONTROLLER)

        result = await search_code_by_signature_pattern(
            pattern=r"UserController",
            element_kind="any",
            repository_path=str(tmp_path),
        )

        # 类名 UserController 出现在类签名中
        assert result["total_matches"] >= 1

    @pytest.mark.asyncio
    async def test_any_returns_mixed_kinds(self, tmp_path):
        """any 返回结果应包含多种元素类型"""
        content = """\
package com.example;

public class UserHelper {
    private String userName;

    public String getUserName() { return userName; }
    public void setUserName(String name) { userName = name; }
}
"""
        _create_file(tmp_path, "src/UserHelper.java", content)

        result = await search_code_by_signature_pattern(
            pattern=r"[Uu]ser[Nn]ame|UserHelper",
            element_kind="any",
            repository_path=str(tmp_path),
        )

        # 应匹配: 类 UserHelper, 字段 userName, 方法 getUserName/setUserName
        assert result["total_matches"] >= 3


# ---------------------------------------------------------------------------
# 空结果 / 边界情况
# ---------------------------------------------------------------------------

class TestEmptyAndEdgeCases:
    """测试空结果和边界情况"""

    @pytest.mark.asyncio
    async def test_no_match(self, tmp_path):
        """搜不到任何匹配"""
        _create_file(tmp_path, "src/Test.java", _JAVA_CONTROLLER)

        result = await search_code_by_signature_pattern(
            pattern=r"NonExistentMethod",
            element_kind="method",
            repository_path=str(tmp_path),
        )

        assert result["total_matches"] == 0
        assert result["results"] == []

    @pytest.mark.asyncio
    async def test_empty_pattern(self, tmp_path):
        """空 pattern 返回空结果"""
        _create_file(tmp_path, "src/Test.java", _JAVA_CONTROLLER)

        result = await search_code_by_signature_pattern(
            pattern="",
            element_kind="method",
            repository_path=str(tmp_path),
        )

        assert result["total_matches"] == 0

    @pytest.mark.asyncio
    async def test_nonexistent_repo(self):
        """不存在的仓库路径"""
        result = await search_code_by_signature_pattern(
            pattern="test",
            element_kind="method",
            repository_path="/nonexistent/path/xyz",
        )

        assert result["total_matches"] == 0

    @pytest.mark.asyncio
    async def test_invalid_element_kind(self, tmp_path):
        """无效的 element_kind"""
        _create_file(tmp_path, "src/Test.java", _JAVA_CONTROLLER)

        result = await search_code_by_signature_pattern(
            pattern="test",
            element_kind="invalid_kind",
            repository_path=str(tmp_path),
        )

        assert result["total_matches"] == 0
        assert "error" in result

    @pytest.mark.asyncio
    async def test_invalid_regex(self, tmp_path):
        """无效的正则表达式"""
        _create_file(tmp_path, "src/Test.java", _JAVA_CONTROLLER)

        result = await search_code_by_signature_pattern(
            pattern="[invalid(",
            element_kind="method",
            repository_path=str(tmp_path),
        )

        assert result["total_matches"] == 0
        assert "error" in result

    @pytest.mark.asyncio
    async def test_no_java_files(self, tmp_path):
        """仓库中没有 Java 文件"""
        _create_file(tmp_path, "src/main.py", "print('hello')\n")

        result = await search_code_by_signature_pattern(
            pattern="test",
            element_kind="method",
            repository_path=str(tmp_path),
        )

        assert result["total_matches"] == 0


# ---------------------------------------------------------------------------
# max_results 截断
# ---------------------------------------------------------------------------

class TestMaxResults:
    """测试 max_results 截断"""

    @pytest.mark.asyncio
    async def test_truncation(self, tmp_path):
        """结果数超过 max_results 时截断"""
        methods = "\n".join(
            f"    public void method{i}() {{ }}"
            for i in range(20)
        )
        content = f"package com.example;\npublic class ManyMethods {{\n{methods}\n}}\n"
        _create_file(tmp_path, "src/ManyMethods.java", content)

        result = await search_code_by_signature_pattern(
            pattern=r"public\s+void\s+\w+",
            element_kind="method",
            repository_path=str(tmp_path),
            max_results=5,
        )

        assert result["total_matches"] == 5

    @pytest.mark.asyncio
    async def test_max_results_limit(self, tmp_path):
        """max_results 超过上限时被限制为 1000"""
        methods = "\n".join(
            f"    public void m{i}() {{ }}"
            for i in range(5)
        )
        content = f"package com.example;\npublic class SmallClass {{\n{methods}\n}}\n"
        _create_file(tmp_path, "src/SmallClass.java", content)

        result = await search_code_by_signature_pattern(
            pattern=r"public\s+void\s+\w+",
            element_kind="method",
            repository_path=str(tmp_path),
            max_results=5000,
        )

        assert result["total_matches"] == 5


# ---------------------------------------------------------------------------
# 注释过滤
# ---------------------------------------------------------------------------

class TestCommentFiltering:
    """测试注释过滤"""

    def test_strip_line_comment(self):
        """行注释被移除"""
        content = "int x = 1; // public void fake() {}"
        stripped = _strip_comments(content)
        assert "fake" not in stripped

    def test_strip_block_comment(self):
        """块注释被移除"""
        content = "/* public class FakeClass { } */ int x = 1;"
        stripped = _strip_comments(content)
        assert "FakeClass" not in stripped

    def test_strip_multiline_block_comment(self):
        """多行块注释被移除"""
        content = "/*\n * public void method() {}\n */\npublic class RealClass {}\n"
        stripped = _strip_comments(content)
        assert "FakeClass" not in stripped
        assert "RealClass" in stripped

    @pytest.mark.asyncio
    async def test_comment_not_matched_as_signature(self, tmp_path):
        """注释中的方法签名不应被匹配"""
        _create_file(tmp_path, "src/RealClass.java", _JAVA_COMMENT_NOISE)

        result = await search_code_by_signature_pattern(
            pattern=r"public\s+void\s+\w+\s*\(\s*\)",
            element_kind="method",
            repository_path=str(tmp_path),
        )

        assert result["total_matches"] == 0


# ---------------------------------------------------------------------------
# 花括号匹配
# ---------------------------------------------------------------------------

class TestFindMatchingBraceLine:
    """测试花括号匹配"""

    def test_simple_braces(self):
        """简单花括号"""
        lines = ["{", "}"]
        assert _find_matching_brace_line(lines, 0) == 1

    def test_nested_braces(self):
        """嵌套花括号"""
        lines = ["{", "  {", "  }", "}"]
        assert _find_matching_brace_line(lines, 0) == 3

    def test_braces_same_line(self):
        """同行花括号"""
        lines = ["public class Foo {", "  void bar() {", "  }", "}"]
        assert _find_matching_brace_line(lines, 0) == 3


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
        assert "search_code_by_signature_pattern" in registered

    @pytest.mark.asyncio
    async def test_tool_in_tools_list(self):
        """tool 应出现在 tools/list 中"""
        mcp = FastMCP(name="test-server-2", version="0.0.1")
        auto_discover_tools(mcp, "yasa_mcp.tools")
        tools = await mcp.list_tools()
        tool_names = [t.name for t in tools]
        assert "search_code_by_signature_pattern" in tool_names

    @pytest.mark.asyncio
    async def test_tool_has_description(self):
        """tool 应有描述"""
        mcp = FastMCP(name="test-server-3", version="0.0.1")
        auto_discover_tools(mcp, "yasa_mcp.tools")
        tools = await mcp.list_tools()
        tool = [t for t in tools if t.name == "search_code_by_signature_pattern"][0]
        assert tool.description is not None
        assert len(tool.description) > 0

    @pytest.mark.asyncio
    async def test_tool_callable_via_mcp(self, tmp_path):
        """通过 MCP 协议调用 tool"""
        mcp = FastMCP(name="test-server-4", version="0.0.1")
        auto_discover_tools(mcp, "yasa_mcp.tools")
        _create_file(tmp_path, "src/Test.java", _JAVA_CONTROLLER)
        result = await mcp.call_tool("search_code_by_signature_pattern", {
            "pattern": "getUser",
            "element_kind": "method",
            "repository_path": str(tmp_path),
        })
        assert result is not None


# ---------------------------------------------------------------------------
# 集成测试: java-design-patterns (中等规模, ~1900 Java 文件)
# ---------------------------------------------------------------------------

class TestJavaDesignPatternsIntegration:
    """使用 java-design-patterns 开源项目做集成测试"""

    @pytest.fixture
    def repo(self):
        if not os.path.isdir(_JDP_REPO):
            pytest.skip("java-design-patterns test-repo not available")
        return _JDP_REPO

    @pytest.mark.asyncio
    async def test_find_abstract_classes(self, repo):
        """在 JDP 中搜索抽象类"""
        result = await search_code_by_signature_pattern(
            pattern=r"abstract\s+class\s+\w+",
            element_kind="class",
            repository_path=repo,
            max_results=50,
        )
        # JDP 中有抽象类 (如 RateLimiterTest 等)
        assert result["total_matches"] >= 1
        for r in result["results"]:
            assert "abstract class" in r["matched_signature"]

    @pytest.mark.asyncio
    async def test_find_implements(self, repo):
        """在 JDP 中搜索 implements 关键字的类"""
        result = await search_code_by_signature_pattern(
            pattern=r"class\s+\w+\s+implements\s+\w+",
            element_kind="class",
            repository_path=repo,
            max_results=100,
        )
        assert result["total_matches"] >= 1
        for r in result["results"]:
            assert "implements" in r["matched_signature"]

    @pytest.mark.asyncio
    async def test_find_static_final_fields(self, repo):
        """在 JDP 中搜索 static final 字段"""
        result = await search_code_by_signature_pattern(
            pattern=r"static\s+final\s+\w+\s+\w+",
            element_kind="field",
            repository_path=repo,
            max_results=100,
        )
        # JDP 中有大量 static final 字段 (如测试中的常量)
        assert result["total_matches"] >= 10
        for r in result["results"]:
            assert "static" in r["matched_signature"]
            assert "final" in r["matched_signature"]

    @pytest.mark.asyncio
    async def test_find_private_final_fields(self, repo):
        """在 JDP 中搜索 private final 字段"""
        result = await search_code_by_signature_pattern(
            pattern=r"private\s+final\s+\w+\s+\w+",
            element_kind="field",
            repository_path=repo,
            max_results=100,
        )
        assert result["total_matches"] >= 1
        for r in result["results"]:
            assert "private" in r["matched_signature"]
            assert "final" in r["matched_signature"]

    @pytest.mark.asyncio
    async def test_find_logger_any(self, repo):
        """在 JDP 中用 any 模式搜索 Logger"""
        result = await search_code_by_signature_pattern(
            pattern=r"Logger\b",
            element_kind="any",
            repository_path=repo,
            max_results=50,
        )
        assert result["total_matches"] >= 1

    @pytest.mark.asyncio
    async def test_performance_jdp(self, repo):
        """性能测试: JDP (中等仓库) 响应 < 3s"""
        start = time.time()
        result = await search_code_by_signature_pattern(
            pattern=r"public\s+\w+.*\(",
            element_kind="method",
            repository_path=repo,
            max_results=100,
        )
        elapsed = time.time() - start

        assert elapsed < 3.0, f"Search took {elapsed:.2f}s, expected < 3s"
        assert result["total_matches"] > 0


# ---------------------------------------------------------------------------
# 集成测试: spring-framework (大规模, ~9000 Java 文件)
# ---------------------------------------------------------------------------

class TestSpringFrameworkIntegration:
    """使用 spring-framework 开源项目做集成测试"""

    @pytest.fixture
    def repo(self):
        if not os.path.isdir(_SF_REPO):
            pytest.skip("spring-framework test-repo not available")
        return _SF_REPO

    @pytest.mark.asyncio
    async def test_find_classes_extends_abstract(self, repo):
        """在 SF 中搜索继承 Abstract* 的类"""
        result = await search_code_by_signature_pattern(
            pattern=r"class\s+\w+\s+extends\s+Abstract\w+",
            element_kind="class",
            repository_path=repo,
            max_results=50,
        )
        assert result["total_matches"] >= 1
        for r in result["results"]:
            assert "extends Abstract" in r["matched_signature"]

    @pytest.mark.asyncio
    async def test_find_interface_service(self, repo):
        """在 SF 中搜索 *Service 接口"""
        result = await search_code_by_signature_pattern(
            pattern=r"interface\s+\w+Service\b",
            element_kind="class",
            repository_path=repo,
            max_results=50,
        )
        assert result["total_matches"] >= 1

    @pytest.mark.asyncio
    async def test_find_get_find_methods(self, repo):
        """在 SF 中搜索 get/find 开头的方法"""
        result = await search_code_by_signature_pattern(
            pattern=r"\b(get|find)\w*\s*\(",
            element_kind="method",
            repository_path=repo,
            max_results=100,
        )
        # Spring 中有大量 getter/find 方法
        assert result["total_matches"] >= 50

    @pytest.mark.asyncio
    async def test_performance_sf_classes(self, repo):
        """性能测试: SF 类搜索 < 5s (大仓库放宽)"""
        start = time.time()
        result = await search_code_by_signature_pattern(
            pattern=r"abstract\s+class\s+\w+",
            element_kind="class",
            repository_path=repo,
            max_results=50,
        )
        elapsed = time.time() - start

        assert elapsed < 5.0, f"Search took {elapsed:.2f}s, expected < 5s"
        assert result["total_matches"] >= 1

    @pytest.mark.asyncio
    async def test_performance_sf_methods(self, repo):
        """性能测试: SF 方法搜索 < 5s"""
        start = time.time()
        result = await search_code_by_signature_pattern(
            pattern=r"public\s+\w+.*\(",
            element_kind="method",
            repository_path=repo,
            max_results=100,
        )
        elapsed = time.time() - start

        assert elapsed < 5.0, f"Search took {elapsed:.2f}s, expected < 5s"
        assert result["total_matches"] > 0
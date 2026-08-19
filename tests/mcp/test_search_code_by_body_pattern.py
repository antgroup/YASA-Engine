"""
测试 search_code_by_body_pattern tool

覆盖验收标准:
- [x] 命中位置必须返回所在方法的全限定名 (containing_method)
- [x] 多行匹配正确 (默认 multi_line=true)
- [x] 命中位置必须在真正的方法体内, 不能命中字段初始化、import、注释
- [x] 单元测试覆盖: 跨行匹配、嵌套方法(lambda/匿名类)、注释内伪命中过滤
- [x] 中等仓库响应 < 5s

测试数据:
  - 单元测试: 临时创建的 Java 文件 (精确控制预期值)
  - 集成测试: test-repos/ 下的开源项目
    - java-design-patterns (~1900 Java 文件, 中等规模)
    - spring-framework (~9200 Java 文件, 大规模)
"""

from __future__ import annotations

import os
import time
import tempfile

import pytest
from fastmcp import FastMCP

from yasa_mcp.tools.search_code_by_body_pattern import search_code_by_body_pattern
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

# 文件1: 基本方法体搜索
# 行号分析 (0-based → 1-based):
#   1:  package com.example;
#   2:  (空)
#   3:  import java.lang.Runtime;
#   4:  (空)
#   5:  public class Cmd {
#   6:      private String cmd = "ls";
#   7:  (空)
#   8:      public void run(String userInput) {
#   9:          Runtime.getRuntime().exec(userInput);
#   10:         System.out.println("done");
#   11:     }
#   12: (空)
#   13:     public void safeMethod() {
#   14:         System.out.println("safe");
#   15:     }
#   16: (空)
#   17:     public void catchExample() {
#   18:         try {
#   19:             doSomething();
#   20:         } catch (Exception e) {
#   21:             e.printStackTrace();
#   22:         }
#   23:     }
#   24: }
_JAVA_CMD = """\
package com.example;

import java.lang.Runtime;

public class Cmd {
    private String cmd = "ls";

    public void run(String userInput) {
        Runtime.getRuntime().exec(userInput);
        System.out.println("done");
    }

    public void safeMethod() {
        System.out.println("safe");
    }

    public void catchExample() {
        try {
            doSomething();
        } catch (Exception e) {
            e.printStackTrace();
        }
    }
}
"""

# 文件2: Lambda / 匿名类 (测试嵌套方法)
# 行号分析:
#   5:  public class LambdaTest {
#   6:      public void outerMethod() {
#   7:          Runnable r = () -> {
#   8:              Runtime.getRuntime().exec("cmd");
#   9:          };
#   10:         r.run();
#   11:     }
#   12: (空)
#   13:     public void anotherMethod() {
#   14:         System.out.println("safe");
#   15:     }
#   16: }
_JAVA_LAMBDA = """\
package com.example;

public class LambdaTest {
    public void outerMethod() {
        Runnable r = () -> {
            Runtime.getRuntime().exec("cmd");
        };
        r.run();
    }

    public void anotherMethod() {
        System.out.println("safe");
    }
}
"""

# 文件3: 注释中的伪命中
# 行号分析:
#   5:  public class CommentTest {
#   6:      // Runtime.exec("fake") in comment
#   7:      /* Runtime.exec("also fake") */
#   8:      public void realMethod() {
#   9:          Runtime.exec("real");
#   10:     }
#   11: }
_JAVA_COMMENT = """\
package com.example;

public class CommentTest {
    // Runtime.exec("fake") in comment
    /* Runtime.exec("also fake") */
    public void realMethod() {
        Runtime.exec("real");
    }
}
"""

# 文件4: 跨行匹配
# 行号分析:
#   5:  public class MultiLineTest {
#   6:      public void doWork() {
#   7:          String sql = "SELECT * FROM users" +
#   8:              " WHERE id = " + userInput;
#   9:          stmt.execute(sql);
#   10:     }
#   11: }
_JAVA_MULTILINE = """\
package com.example;

public class MultiLineTest {
    public void doWork() {
        String sql = "SELECT * FROM users" +
            " WHERE id = " + userInput;
        stmt.execute(sql);
    }
}
"""


# ---------------------------------------------------------------------------
# 基本方法体搜索
# ---------------------------------------------------------------------------

class TestBasicBodySearch:
    """测试基本方法体搜索"""

    @pytest.mark.asyncio
    async def test_match_in_method_body(self, tmp_path):
        """命中方法体内的代码"""
        _create_file(tmp_path, "src/Cmd.java", _JAVA_CMD)

        result = await search_code_by_body_pattern(
            pattern=r"exec",
            repository_path=str(tmp_path),
        )

        assert result["total_matches"] == 1
        r = result["results"][0]
        assert r["containing_method"] == "com.example.Cmd.run"
        assert r["match_line"] == 9

    @pytest.mark.asyncio
    async def test_containing_method_fqn(self, tmp_path):
        """命中返回全限定方法名"""
        _create_file(tmp_path, "src/Cmd.java", _JAVA_CMD)

        result = await search_code_by_body_pattern(
            pattern=r"printStackTrace",
            repository_path=str(tmp_path),
        )

        assert result["total_matches"] == 1
        assert result["results"][0]["containing_method"] == "com.example.Cmd.catchExample"

    @pytest.mark.asyncio
    async def test_method_start_end_line(self, tmp_path):
        """返回方法起止行号"""
        _create_file(tmp_path, "src/Cmd.java", _JAVA_CMD)

        result = await search_code_by_body_pattern(
            pattern=r"exec",
            repository_path=str(tmp_path),
        )

        r = result["results"][0]
        assert r["method_start_line"] == 8   # public void run 行
        assert r["method_end_line"] == 11    # } 行

    @pytest.mark.asyncio
    async def test_match_snippet(self, tmp_path):
        """返回命中片段"""
        _create_file(tmp_path, "src/Cmd.java", _JAVA_CMD)

        result = await search_code_by_body_pattern(
            pattern=r"exec",
            repository_path=str(tmp_path),
        )

        assert result["total_matches"] == 1
        assert "exec" in result["results"][0]["match_snippet"]

    @pytest.mark.asyncio
    async def test_snippet_with_context(self, tmp_path):
        """返回带上下文的代码片段"""
        _create_file(tmp_path, "src/Cmd.java", _JAVA_CMD)

        result = await search_code_by_body_pattern(
            pattern=r"exec",
            repository_path=str(tmp_path),
        )

        r = result["results"][0]
        assert ">>>" in r["snippet_with_context"]
        assert "exec" in r["snippet_with_context"]

    @pytest.mark.asyncio
    async def test_multiple_methods_match(self, tmp_path):
        """多个方法命中"""
        content = """\
package com.example;

public class Multi {
    public void methodA() {
        Runtime.exec("a");
    }

    public void methodB() {
        Runtime.exec("b");
    }

    public void methodC() {
        System.out.println("safe");
    }
}
"""
        _create_file(tmp_path, "src/Multi.java", content)

        result = await search_code_by_body_pattern(
            pattern=r"Runtime\.exec",
            repository_path=str(tmp_path),
        )

        assert result["total_matches"] == 2
        methods = [r["containing_method"] for r in result["results"]]
        assert "com.example.Multi.methodA" in methods
        assert "com.example.Multi.methodB" in methods


# ---------------------------------------------------------------------------
# 排除: 字段初始化 / import / 注释
# ---------------------------------------------------------------------------

class TestExclusion:
    """测试排除非方法体内容"""

    @pytest.mark.asyncio
    async def test_not_in_import(self, tmp_path):
        """import 语句不应被匹配"""
        _create_file(tmp_path, "src/Cmd.java", _JAVA_CMD)

        result = await search_code_by_body_pattern(
            pattern=r"import",
            repository_path=str(tmp_path),
        )

        assert result["total_matches"] == 0

    @pytest.mark.asyncio
    async def test_not_in_field_init(self, tmp_path):
        """字段初始化不应被匹配"""
        _create_file(tmp_path, "src/Cmd.java", _JAVA_CMD)

        # "ls" 出现在字段初始化 private String cmd = "ls";
        result = await search_code_by_body_pattern(
            pattern=r'"ls"',
            repository_path=str(tmp_path),
        )

        assert result["total_matches"] == 0

    @pytest.mark.asyncio
    async def test_not_in_comment(self, tmp_path):
        """注释中的内容不应被匹配"""
        _create_file(tmp_path, "src/CommentTest.java", _JAVA_COMMENT)

        result = await search_code_by_body_pattern(
            pattern=r'Runtime\.exec',
            repository_path=str(tmp_path),
        )

        # 只有 realMethod 中的 Runtime.exec("real") 应匹配
        # 注释中的 Runtime.exec("fake") 和 /* Runtime.exec("also fake") */ 不应匹配
        assert result["total_matches"] == 1
        assert result["results"][0]["containing_method"] == "com.example.CommentTest.realMethod"
        assert result["results"][0]["match_line"] == 9


# ---------------------------------------------------------------------------
# 嵌套方法 (Lambda / 匿名类)
# ---------------------------------------------------------------------------

class TestNestedMethods:
    """测试嵌套方法 (lambda/匿名类)"""

    @pytest.mark.asyncio
    async def test_lambda_belongs_to_outer(self, tmp_path):
        """lambda 内的匹配归属于外层方法"""
        _create_file(tmp_path, "src/LambdaTest.java", _JAVA_LAMBDA)

        result = await search_code_by_body_pattern(
            pattern=r"Runtime",
            repository_path=str(tmp_path),
        )

        assert result["total_matches"] >= 1
        for r in result["results"]:
            assert r["containing_method"] == "com.example.LambdaTest.outerMethod"

    @pytest.mark.asyncio
    async def test_anonymous_class_belongs_to_outer(self, tmp_path):
        """匿名类内的匹配归属于外层方法"""
        content = """\
package com.example;

public class AnonTest {
    public void outerMethod() {
        Runnable r = new Runnable() {
            @Override
            public void run() {
                Runtime.exec("cmd");
            }
        };
        r.run();
    }
}
"""
        _create_file(tmp_path, "src/AnonTest.java", content)

        result = await search_code_by_body_pattern(
            pattern=r"Runtime\.exec",
            repository_path=str(tmp_path),
        )

        # 匿名类的 run() 方法在 depth=2, 不会被当作顶层方法
        # 匹配应归属于 outerMethod
        assert result["total_matches"] == 1
        assert result["results"][0]["containing_method"] == "com.example.AnonTest.outerMethod"


# ---------------------------------------------------------------------------
# 多行匹配
# ---------------------------------------------------------------------------

class TestMultiLine:
    """测试多行匹配 (multi_line=true)"""

    @pytest.mark.asyncio
    async def test_multiline_match(self, tmp_path):
        """跨行匹配"""
        _create_file(tmp_path, "src/MultiLineTest.java", _JAVA_MULTILINE)

        # 匹配跨行的 SELECT...WHERE
        result = await search_code_by_body_pattern(
            pattern=r"SELECT.*WHERE",
            repository_path=str(tmp_path),
            multi_line=True,
        )

        assert result["total_matches"] == 1
        assert result["results"][0]["containing_method"] == "com.example.MultiLineTest.doWork"

    @pytest.mark.asyncio
    async def test_multiline_disabled(self, tmp_path):
        """关闭 multi_line 后不跨行匹配"""
        _create_file(tmp_path, "src/MultiLineTest.java", _JAVA_MULTILINE)

        result = await search_code_by_body_pattern(
            pattern=r"SELECT.*WHERE",
            repository_path=str(tmp_path),
            multi_line=False,
        )

        # . 不匹配换行, 所以跨行的 SELECT...WHERE 不匹配
        assert result["total_matches"] == 0


# ---------------------------------------------------------------------------
# 边界情况
# ---------------------------------------------------------------------------

class TestEdgeCases:
    """测试边界情况"""

    @pytest.mark.asyncio
    async def test_no_match(self, tmp_path):
        """搜不到匹配"""
        _create_file(tmp_path, "src/Cmd.java", _JAVA_CMD)

        result = await search_code_by_body_pattern(
            pattern=r"NonExistentMethod",
            repository_path=str(tmp_path),
        )

        assert result["total_matches"] == 0

    @pytest.mark.asyncio
    async def test_empty_pattern(self, tmp_path):
        """空 pattern"""
        _create_file(tmp_path, "src/Cmd.java", _JAVA_CMD)

        result = await search_code_by_body_pattern(
            pattern="",
            repository_path=str(tmp_path),
        )

        assert result["total_matches"] == 0

    @pytest.mark.asyncio
    async def test_nonexistent_repo(self):
        """不存在的仓库"""
        result = await search_code_by_body_pattern(
            pattern="test",
            repository_path="/nonexistent/path",
        )

        assert result["total_matches"] == 0

    @pytest.mark.asyncio
    async def test_invalid_regex(self, tmp_path):
        """无效正则"""
        _create_file(tmp_path, "src/Cmd.java", _JAVA_CMD)

        result = await search_code_by_body_pattern(
            pattern="[invalid(",
            repository_path=str(tmp_path),
        )

        assert result["total_matches"] == 0
        assert "error" in result

    @pytest.mark.asyncio
    async def test_no_java_files(self, tmp_path):
        """无 Java 文件"""
        _create_file(tmp_path, "src/main.py", "print('hello')\n")

        result = await search_code_by_body_pattern(
            pattern="test",
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
        """结果截断"""
        content = """\
package com.example;

public class ManyCalls {
    public void method() {
        Runtime.exec("a");
        Runtime.exec("b");
        Runtime.exec("c");
        Runtime.exec("d");
        Runtime.exec("e");
    }
}
"""
        _create_file(tmp_path, "src/ManyCalls.java", content)

        result = await search_code_by_body_pattern(
            pattern=r"Runtime\.exec",
            repository_path=str(tmp_path),
            max_results=3,
        )

        assert result["total_matches"] == 3


# ---------------------------------------------------------------------------
# path_prefix 过滤
# ---------------------------------------------------------------------------

class TestPathPrefix:
    """测试 path_prefix 过滤"""

    @pytest.mark.asyncio
    async def test_path_prefix(self, tmp_path):
        """path_prefix 限定搜索范围"""
        _create_file(tmp_path, "src/main/Cmd.java", _JAVA_CMD)
        _create_file(tmp_path, "test/Test.java", _JAVA_CMD)

        result = await search_code_by_body_pattern(
            pattern=r"exec",
            repository_path=str(tmp_path),
            path_prefix="src/main/",
        )

        assert result["total_matches"] == 1
        assert "src/main/Cmd.java" in result["results"][0]["file_path"]

    @pytest.mark.asyncio
    async def test_multiline_method_signature(self, tmp_path):
        """方法签名跨多行时, 方法体搜索仍正确"""
        content = """\
package com.example;

public class LongSig {
    public void doWork(
        String param1,
        int param2,
        boolean param3) {
        Runtime.exec("cmd");
    }
}
"""
        _create_file(tmp_path, "src/LongSig.java", content)

        result = await search_code_by_body_pattern(
            pattern=r"Runtime\.exec",
            repository_path=str(tmp_path),
        )

        assert result["total_matches"] == 1
        assert result["results"][0]["containing_method"] == "com.example.LongSig.doWork"


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
        assert "search_code_by_body_pattern" in registered

    @pytest.mark.asyncio
    async def test_tool_has_description(self):
        """tool 应有描述"""
        mcp = FastMCP(name="test-server-2", version="0.0.1")
        auto_discover_tools(mcp, "yasa_mcp.tools")
        tools = await mcp.list_tools()
        tool = [t for t in tools if t.name == "search_code_by_body_pattern"][0]
        assert tool.description is not None

    @pytest.mark.asyncio
    async def test_tool_callable_via_mcp(self, tmp_path):
        """通过 MCP 协议调用"""
        mcp = FastMCP(name="test-server-3", version="0.0.1")
        auto_discover_tools(mcp, "yasa_mcp.tools")
        _create_file(tmp_path, "src/Cmd.java", _JAVA_CMD)
        result = await mcp.call_tool("search_code_by_body_pattern", {
            "pattern": "exec",
            "repository_path": str(tmp_path),
        })
        assert result is not None


# ---------------------------------------------------------------------------
# 集成测试: java-design-patterns (中等规模, ~1900 Java 文件)
# ---------------------------------------------------------------------------

class TestJDPIntegration:
    """使用 java-design-patterns 开源项目做集成测试"""

    @pytest.fixture
    def repo(self):
        if not os.path.isdir(_JDP_REPO):
            pytest.skip("java-design-patterns test-repo not available")
        return _JDP_REPO

    @pytest.mark.asyncio
    async def test_find_runtime_calls(self, repo):
        """在 JDP 中搜索 Runtime 调用"""
        result = await search_code_by_body_pattern(
            pattern=r"Runtime\b",
            repository_path=repo,
            max_results=50,
        )
        assert result["total_matches"] >= 1
        for r in result["results"]:
            assert r["containing_method"]  # 必须有全限定方法名

    @pytest.mark.asyncio
    async def test_find_get_logger(self, repo):
        """在 JDP 中搜索 getLogger 调用"""
        result = await search_code_by_body_pattern(
            pattern=r"getLogger",
            repository_path=repo,
            max_results=100,
        )
        assert result["total_matches"] >= 1
        for r in result["results"]:
            assert "getLogger" in r["match_snippet"]

    @pytest.mark.asyncio
    async def test_find_catch_exception(self, repo):
        """在 JDP 中搜索 catch (Exception"""
        result = await search_code_by_body_pattern(
            pattern=r"catch\s*\(\s*\w*Exception",
            repository_path=repo,
            max_results=50,
        )
        assert result["total_matches"] >= 1

    @pytest.mark.asyncio
    async def test_performance_jdp(self, repo):
        """性能测试: JDP (中等仓库) 响应 < 5s"""
        start = time.time()
        result = await search_code_by_body_pattern(
            pattern=r"public\s+\w+\s+\w+\s*\(",
            repository_path=repo,
            max_results=100,
        )
        elapsed = time.time() - start

        assert elapsed < 5.0, f"Search took {elapsed:.2f}s, expected < 5s"


# ---------------------------------------------------------------------------
# 集成测试: spring-framework (大规模, ~9200 Java 文件)
# ---------------------------------------------------------------------------

class TestSFIntegration:
    """使用 spring-framework 开源项目做集成测试"""

    @pytest.fixture
    def repo(self):
        if not os.path.isdir(_SF_REPO):
            pytest.skip("spring-framework test-repo not available")
        return _SF_REPO

    @pytest.mark.asyncio
    async def test_find_catch_in_sf(self, repo):
        """在 SF 中搜索 catch (Exception"""
        result = await search_code_by_body_pattern(
            pattern=r"catch\s*\(\s*\w*Exception",
            repository_path=repo,
            max_results=50,
        )
        assert result["total_matches"] >= 1
        for r in result["results"]:
            assert r["containing_method"]

    @pytest.mark.asyncio
    async def test_find_system_out_println(self, repo):
        """在 SF 中搜索 System.out.println"""
        result = await search_code_by_body_pattern(
            pattern=r"System\.out\.println",
            repository_path=repo,
            max_results=50,
        )
        assert result["total_matches"] >= 1
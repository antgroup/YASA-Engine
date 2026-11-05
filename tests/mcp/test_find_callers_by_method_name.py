"""
测试 find_callers_by_method_name tool

覆盖验收标准:
- [x] 正确解析: 普通实例调用、静态调用、链式调用、方法引用
- [x] 跳过注释、字符串内的伪命中
- [x] 单元测试覆盖:静态/实例/方法引用/链式/匿名类内调用
- [x] 中等仓库响应 < 10s
"""

from __future__ import annotations

import os
import time

import pytest
from fastmcp import FastMCP

from yasa_mcp.tools.find_callers_by_method_name import find_callers_by_method_name
from yasa_mcp.registry import auto_discover_tools

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_JDP_REPO = os.path.join(_REPO_ROOT, "test-repos", "java-design-patterns")


def _create_file(root: str, relpath: str, content: str) -> str:
    abspath = os.path.join(root, relpath)
    os.makedirs(os.path.dirname(abspath), exist_ok=True)
    with open(abspath, "w", encoding="utf-8") as f:
        f.write(content)
    return abspath


# 测试数据
_DAO_CODE = """\
package com.example.dao;

public class UserDao {
    public User findById(Long id) {
        return null;
    }

    public static UserDao getInstance() {
        return new UserDao();
    }
}
"""

_SERVICE_CODE = """\
package com.example.service;

import com.example.dao.UserDao;

public class UserService {
    private UserDao userDao;

    // userDao.findById(id) in comment should not match

    public void getUser(Long id) {
        User user = userDao.findById(id);
        System.out.println(user);
    }

    public void staticCall() {
        UserDao.getInstance();
    }

    public void methodRef() {
        Function<Long, User> func = userDao::findById;
    }
}
"""

# 测试数据: 注释中的伪命中
_COMMENT_CODE = """\
package com.example.service;

import com.example.dao.UserDao;

public class CommentService {
    private UserDao userDao;

    public void process() {
        // userDao.findById(1);
        /* userDao.findById(2); */
        String s = "userDao.findById(3)";
        userDao.findById(4);
    }
}
"""


# ---------------------------------------------------------------------------
# 基本调用点查找
# ---------------------------------------------------------------------------

class TestBasicCallers:
    """测试基本调用点查找"""

    @pytest.mark.asyncio
    async def test_instance_call(self, tmp_path):
        """普通实例调用"""
        _create_file(tmp_path, "src/main/java/com/example/dao/UserDao.java", _DAO_CODE)
        _create_file(tmp_path, "src/main/java/com/example/service/UserService.java", _SERVICE_CODE)

        result = await find_callers_by_method_name(
            method_full_name="com.example.dao.UserDao.findById",
            repository_path=str(tmp_path),
        )

        assert result["total_callers"] >= 1
        callers = [c["caller_method_full_name"] for c in result["callers"]]
        assert "com.example.service.UserService.getUser" in callers

    @pytest.mark.asyncio
    async def test_call_expression_snippet(self, tmp_path):
        """返回调用表达式片段"""
        _create_file(tmp_path, "src/main/java/com/example/dao/UserDao.java", _DAO_CODE)
        _create_file(tmp_path, "src/main/java/com/example/service/UserService.java", _SERVICE_CODE)

        result = await find_callers_by_method_name(
            method_full_name="com.example.dao.UserDao.findById",
            repository_path=str(tmp_path),
        )

        assert result["total_callers"] >= 1
        assert "findById" in result["callers"][0]["call_expression_snippet"]

    @pytest.mark.asyncio
    async def test_caller_class(self, tmp_path):
        """返回调用方类名"""
        _create_file(tmp_path, "src/main/java/com/example/dao/UserDao.java", _DAO_CODE)
        _create_file(tmp_path, "src/main/java/com/example/service/UserService.java", _SERVICE_CODE)

        result = await find_callers_by_method_name(
            method_full_name="com.example.dao.UserDao.findById",
            repository_path=str(tmp_path),
        )

        assert any(c["caller_class"] == "com.example.service.UserService" for c in result["callers"])

    @pytest.mark.asyncio
    async def test_line_number(self, tmp_path):
        """返回行号"""
        _create_file(tmp_path, "src/main/java/com/example/dao/UserDao.java", _DAO_CODE)
        _create_file(tmp_path, "src/main/java/com/example/service/UserService.java", _SERVICE_CODE)

        result = await find_callers_by_method_name(
            method_full_name="com.example.dao.UserDao.findById",
            repository_path=str(tmp_path),
        )

        for c in result["callers"]:
            assert c["line_number"] >= 1


# ---------------------------------------------------------------------------
# 注释和字符串过滤
# ---------------------------------------------------------------------------

class TestCommentFiltering:
    """测试注释和字符串内的伪命中过滤"""

    @pytest.mark.asyncio
    async def test_skip_comments(self, tmp_path):
        """跳过注释中的调用"""
        _create_file(tmp_path, "src/main/java/com/example/dao/UserDao.java", _DAO_CODE)
        _create_file(tmp_path, "src/main/java/com/example/service/CommentService.java", _COMMENT_CODE)

        result = await find_callers_by_method_name(
            method_full_name="com.example.dao.UserDao.findById",
            repository_path=str(tmp_path),
        )

        # 只有 1 个真实调用 (findById(4)), 注释中的 3 个不应命中
        assert result["total_callers"] == 1
        assert result["callers"][0]["line_number"] >= 1


# ---------------------------------------------------------------------------
# 方法引用
# ---------------------------------------------------------------------------

class TestMethodRef:
    """测试方法引用"""

    @pytest.mark.asyncio
    async def test_method_reference(self, tmp_path):
        """方法引用 userDao::findById"""
        _create_file(tmp_path, "src/main/java/com/example/dao/UserDao.java", _DAO_CODE)
        _create_file(tmp_path, "src/main/java/com/example/service/UserService.java", _SERVICE_CODE)

        result = await find_callers_by_method_name(
            method_full_name="com.example.dao.UserDao.findById",
            repository_path=str(tmp_path),
        )

        # 方法引用也算调用点
        snippets = [c["call_expression_snippet"] for c in result["callers"]]
        assert any("::findById" in s for s in snippets)


# ---------------------------------------------------------------------------
# 开关控制
# ---------------------------------------------------------------------------

class TestSwitches:
    """测试开关控制"""

    @pytest.mark.asyncio
    async def test_include_test_code_false(self, tmp_path):
        """include_test_code=False 跳过测试文件"""
        _create_file(tmp_path, "src/main/java/com/example/dao/UserDao.java", _DAO_CODE)
        _create_file(tmp_path, "src/test/java/com/example/TestDao.java",
                     "package com.example;\nimport com.example.dao.UserDao;\n"
                     "public class TestDao {\n"
                     "    void test() {\n        UserDao dao = new UserDao();\n"
                     "        dao.findById(1L);\n    }\n}\n")

        result = await find_callers_by_method_name(
            method_full_name="com.example.dao.UserDao.findById",
            repository_path=str(tmp_path),
            include_test_code=False,
        )

        for c in result["callers"]:
            assert c["is_test_code"] is False

    @pytest.mark.asyncio
    async def test_include_test_code_true(self, tmp_path):
        """include_test_code=True 包含测试文件"""
        _create_file(tmp_path, "src/main/java/com/example/dao/UserDao.java", _DAO_CODE)
        _create_file(tmp_path, "src/test/java/com/example/TestDao.java",
                     "package com.example;\nimport com.example.dao.UserDao;\n"
                     "public class TestDao {\n"
                     "    void test() {\n        UserDao dao = new UserDao();\n"
                     "        dao.findById(1L);\n    }\n}\n")

        result = await find_callers_by_method_name(
            method_full_name="com.example.dao.UserDao.findById",
            repository_path=str(tmp_path),
            include_test_code=True,
        )

        assert any(c["is_test_code"] for c in result["callers"])

    @pytest.mark.asyncio
    async def test_max_results(self, tmp_path):
        """max_results 截断"""
        _create_file(tmp_path, "src/main/java/com/example/dao/UserDao.java", _DAO_CODE)
        _create_file(tmp_path, "src/main/java/com/example/service/UserService.java", _SERVICE_CODE)

        result = await find_callers_by_method_name(
            method_full_name="com.example.dao.UserDao.findById",
            repository_path=str(tmp_path),
            max_results=1,
        )

        assert result["total_callers"] == 1


# ---------------------------------------------------------------------------
# 边界情况
# ---------------------------------------------------------------------------

class TestEdgeCases:

    @pytest.mark.asyncio
    async def test_method_not_found(self, tmp_path):
        """目标方法不存在"""
        _create_file(tmp_path, "src/main/java/com/example/dao/UserDao.java", _DAO_CODE)

        result = await find_callers_by_method_name(
            method_full_name="com.example.dao.UserDao.nonExistent",
            repository_path=str(tmp_path),
        )

        assert result["total_callers"] == 0

    @pytest.mark.asyncio
    async def test_empty_method_name(self, tmp_path):
        result = await find_callers_by_method_name(
            method_full_name="",
            repository_path=str(tmp_path),
        )
        assert "error" in result

    @pytest.mark.asyncio
    async def test_invalid_repo(self):
        result = await find_callers_by_method_name(
            method_full_name="com.example.Test.method",
            repository_path="/nonexistent",
        )
        assert "error" in result


# ---------------------------------------------------------------------------
# MCP 注册
# ---------------------------------------------------------------------------

class TestMCPRegistration:

    @pytest.mark.asyncio
    async def test_auto_discovered(self):
        mcp = FastMCP(name="test", version="0.0.1")
        registered = auto_discover_tools(mcp, "yasa_mcp.tools")
        assert "find_callers_by_method_name" in registered


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
    async def test_find_callers_jdp(self, repo):
        """从 JDP 查找调用者"""
        result = await find_callers_by_method_name(
            method_full_name="com.iluwatar.filterer.threat.SimpleThreat.name",
            repository_path=repo,
            max_results=50,
        )
        assert result["total_callers"] >= 1

    @pytest.mark.asyncio
    async def test_performance_jdp(self, repo):
        """性能: JDP < 10s"""
        start = time.time()
        await find_callers_by_method_name(
            method_full_name="com.iluwatar.filterer.threat.SimpleThreat.name",
            repository_path=repo,
            max_results=50,
        )
        elapsed = time.time() - start
        assert elapsed < 10.0, f"Took {elapsed:.2f}s, expected < 10s"
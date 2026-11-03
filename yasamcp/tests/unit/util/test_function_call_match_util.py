"""Tests for function_call_match_util."""

import re

import pytest

from yasa_mcp.util.function_call_match_util import (
    build_multiline_call_pattern,
    build_multiline_prefix_pattern,
)


class TestBuildMultilineCallPattern:
    """build_multiline_call_pattern 的单元测试。"""

    def test_simple_call(self):
        pattern = build_multiline_call_pattern("a.b(x)")
        assert re.search(pattern, "a.b(x)")
        assert re.search(pattern, "a.b(\nx)")
        assert re.search(pattern, "a\n.b(x)")
        assert re.search(pattern, "a .b( x )")

    def test_multiline_args(self):
        """参数跨行：docService.parseDesc(desc, operatorVOList)"""
        call = "docService.parseDescExtractYuqQueDocInfo(desc, operatorVOList)"
        pattern = build_multiline_call_pattern(call)

        # 单行
        assert re.search(pattern, "docService.parseDescExtractYuqQueDocInfo(desc, operatorVOList)")
        # 参数跨行
        assert re.search(pattern, "docService.parseDescExtractYuqQueDocInfo(\n        desc, operatorVOList)")
        assert re.search(pattern, "docService.parseDescExtractYuqQueDocInfo(\n        desc,\n        operatorVOList)")
        # 方法名后换行
        assert re.search(pattern, "docService.parseDescExtractYuqQueDocInfo\n(desc, operatorVOList)")
        # receiver 后换行
        assert re.search(pattern, "docService\n    .parseDescExtractYuqQueDocInfo(desc, operatorVOList)")

    def test_no_dot(self):
        """无 receiver 的调用"""
        pattern = build_multiline_call_pattern("process(data)")
        assert re.search(pattern, "process(data)")
        assert re.search(pattern, "process(\ndata)")
        assert re.search(pattern, "process( data )")

    def test_chained_call(self):
        """链式调用：a.b.c(x, y)"""
        pattern = build_multiline_call_pattern("a.b.c(x, y)")
        assert re.search(pattern, "a.b.c(x, y)")
        assert re.search(pattern, "a\n.b\n.c(\nx,\ny)")
        assert re.search(pattern, "a .b .c( x , y )")

    def test_empty_input(self):
        assert build_multiline_call_pattern("") == ""
        assert build_multiline_call_pattern("  ") == ""

    def test_no_false_positive_on_different_method(self):
        """不应该匹配不同方法名"""
        pattern = build_multiline_call_pattern("a.foo(x)")
        assert not re.search(pattern, "a.bar(x)")

    def test_special_chars_escaped(self):
        """特殊字符正确转义"""
        pattern = build_multiline_call_pattern("obj.method(arr[0])")
        assert re.search(pattern, "obj.method(arr[0])")
        # [ 被转义不应匹配其他
        assert not re.search(pattern, "obj.method(arrX0])")


class TestBuildMultilinePrefixPattern:
    """build_multiline_prefix_pattern 的单元测试。"""

    def test_dotted_prefix(self):
        """有 . 的前缀"""
        pattern = build_multiline_prefix_pattern("docService.parseDesc(arg)")
        assert re.search(pattern, "docService.parseDesc(")
        assert re.search(pattern, "docService\n.parseDesc(")
        assert re.search(pattern, "docService .parseDesc (")

    def test_simple_prefix(self):
        """无 . 的前缀"""
        pattern = build_multiline_prefix_pattern("process(data)")
        assert re.search(pattern, "process(")
        assert re.search(pattern, "process (")
        assert re.search(pattern, "process\n(")
        # word boundary: 不应匹配 xprocess(
        assert not re.search(pattern, "xprocess(")

    def test_chained_prefix(self):
        """多级链式调用"""
        pattern = build_multiline_prefix_pattern("a.b.c(x)")
        assert re.search(pattern, "a.b.c(")
        assert re.search(pattern, "a\n.b\n.c(")
        assert re.search(pattern, "a.b.c (")

    def test_no_parens(self):
        """无括号的输入"""
        pattern = build_multiline_prefix_pattern("someFunc")
        assert re.search(pattern, "someFunc(")
        assert not re.search(pattern, "xsomeFunc(")

    def test_empty_input(self):
        assert build_multiline_prefix_pattern("") == ""
        assert build_multiline_prefix_pattern("  ") == ""

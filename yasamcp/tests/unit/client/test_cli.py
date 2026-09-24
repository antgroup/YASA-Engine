"""yasamcp CLI 单元测试。

测试范围：
1. CLI 本身的 --version / -v / --help 功能
2. 每个子命令都有 --help 且返回正常
3. 每个子命令的每个参数都有非空 help 描述
"""

from __future__ import annotations

import re

import pytest
from click.testing import CliRunner

from yasa_mcp.bin.yasa_client import cli


@pytest.fixture
def runner():
    return CliRunner()


# 所有对外暴露的子命令
SUBCOMMANDS = [
    "init", "search", "class", "func",
    "keywords", "callees", "callers", "callgraph", "api", "server",
]


# ---------------------------------------------------------------------------
# CLI 本身：--version / -v / --help
# ---------------------------------------------------------------------------

class TestCLIVersion:
    """--version / -v 输出测试"""

    def test_version_long(self, runner):
        result = runner.invoke(cli, ["--version"])
        assert result.exit_code == 0
        assert "YASA-MCP" in result.output
        assert "Version" in result.output

    def test_version_short(self, runner):
        result = runner.invoke(cli, ["-v"])
        assert result.exit_code == 0
        assert "YASA-MCP" in result.output
        assert "Version" in result.output

    def test_version_format(self, runner):
        """版本行格式：Version   : x.y.z (build YYYYMMDD, commit xxxxxxx)"""
        result = runner.invoke(cli, ["-v"])
        assert result.exit_code == 0
        assert re.search(r"Version\s*:\s*\d+\.\d+\.\d+", result.output)


class TestCLIHelp:
    """根命令 --help 测试"""

    def test_root_help(self, runner):
        result = runner.invoke(cli, ["--help"])
        assert result.exit_code == 0
        assert "Usage:" in result.output
        assert "Commands:" in result.output

    def test_root_help_lists_all_subcommands(self, runner):
        result = runner.invoke(cli, ["--help"])
        assert result.exit_code == 0
        for cmd in SUBCOMMANDS:
            assert cmd in result.output

    def test_root_description(self, runner):
        result = runner.invoke(cli, ["--help"])
        assert result.exit_code == 0
        assert "yasamcp" in result.output.lower()


# ---------------------------------------------------------------------------
# 每个子命令：--help 正常、一句话介绍、每个参数都有 help
# ---------------------------------------------------------------------------

class TestSubcommandHelp:
    """每个子命令都有 --help，有描述，且每个参数 help 非空"""

    @pytest.mark.parametrize("subcmd", SUBCOMMANDS)
    def test_subcommand_has_help(self, runner, subcmd):
        result = runner.invoke(cli, [subcmd, "--help"])
        assert result.exit_code == 0
        assert "Usage:" in result.output
        assert "-h, --help" in result.output

    @pytest.mark.parametrize("subcmd", SUBCOMMANDS)
    def test_subcommand_has_description(self, runner, subcmd):
        """每个子命令的 help 输出中第二行应有一句话介绍（非空 docstring）"""
        result = runner.invoke(cli, [subcmd, "--help"])
        assert result.exit_code == 0
        lines = [line.strip() for line in result.output.splitlines() if line.strip()]
        # Usage 行之后应至少有一行描述
        # 找到 Usage 行，后面那行应该是描述
        usage_idx = next(i for i, line in enumerate(lines) if line.startswith("Usage:"))
        assert usage_idx + 1 < len(lines), f"{subcmd} 缺少描述"
        description = lines[usage_idx + 1]
        assert len(description) > 2, f"{subcmd} 描述为空"

    @pytest.mark.parametrize("subcmd", SUBCOMMANDS)
    def test_subcommand_params_have_help(self, runner, subcmd):
        """每个子命令的参数（排除 -h/--help）都有非空 help 描述"""
        from click import Context
        # 通过 click 内省直接获取参数对象，而非解析 help 文本
        ctx = Context(cli, info_name=subcmd)
        cmd = cli.commands.get(subcmd)
        assert cmd is not None, f"子命令 {subcmd} 不存在"
        from click import Argument
        for param in cmd.params:
            # Argument（位置参数）没有 help 属性，只检查 Option
            if isinstance(param, Argument):
                continue
            help_text = getattr(param, "help", None) or ""
            assert help_text.strip(), f"{subcmd} 的参数 '{param.name}' 缺少 help 描述"

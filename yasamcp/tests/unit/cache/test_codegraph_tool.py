from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from yasa_mcp.config import global_config
from yasa_mcp.core.exceptions import InvalidToolError, ToolTimeoutError
from yasa_mcp.tools.codegraph.codegraph_bin_layout import CodeGraphBinaryLayout
from yasa_mcp.tools.codegraph.codegraph_tool import CodeGraphTool


def _tool(tmp_path: Path) -> CodeGraphTool:
    binary = tmp_path / "bin" / "codegraph"
    binary.parent.mkdir(parents=True)
    binary.write_text("#!/bin/sh\n")
    layout = CodeGraphBinaryLayout(root_path=tmp_path)
    with patch("yasa_mcp.tools.codegraph.codegraph_tool.command_util.check_binary_available", return_value=True):
        return CodeGraphTool(layout)


def test_status_parses_json_object(tmp_path):
    tool = _tool(tmp_path)
    result = SimpleNamespace(returncode=0, stdout='{"initialized": true}', stderr="")

    with patch("yasa_mcp.tools.codegraph.codegraph_tool.command_util.run_binary", return_value=result) as run_binary:
        status = tool.status(tmp_path / "project")

    assert status == {"initialized": True}
    run_binary.assert_called_once_with(tool.binary, ["status", tmp_path / "project", "-j"], 120)


def test_status_raises_on_invalid_json(tmp_path):
    tool = _tool(tmp_path)
    result = SimpleNamespace(returncode=0, stdout="not-json", stderr="")

    with patch("yasa_mcp.tools.codegraph.codegraph_tool.command_util.run_binary", return_value=result):
        with pytest.raises(InvalidToolError, match="failed to parse codegraph status JSON"):
            tool.status(tmp_path / "project")


def test_cli_failure_raises_invalid_tool_error(tmp_path):
    tool = _tool(tmp_path)
    result = SimpleNamespace(returncode=1, stdout="", stderr="boom")

    with patch("yasa_mcp.tools.codegraph.codegraph_tool.command_util.run_binary", return_value=result):
        with pytest.raises(InvalidToolError, match=r"returncode=1.*stderr_tail='boom'"):
            tool.init_project(tmp_path / "project")


@pytest.mark.parametrize(
    ("method_name", "command"),
    [("init_project", "init"), ("sync_project", "sync")],
)
def test_prepare_command_uses_global_timeout_by_default(tmp_path, method_name, command):
    tool = _tool(tmp_path)
    project_path = tmp_path / "project"
    result = SimpleNamespace(returncode=0, stdout="", stderr="")

    with patch(
        "yasa_mcp.tools.codegraph.codegraph_tool.command_util.run_binary",
        return_value=result,
    ) as run_binary:
        getattr(tool, method_name)(project_path)

    run_binary.assert_called_once_with(
        tool.binary,
        [command, project_path],
        global_config.prepare_timeout,
    )


def test_run_uses_global_timeout_by_default(tmp_path):
    tool = _tool(tmp_path)
    result = SimpleNamespace(returncode=0, stdout="", stderr="")

    with patch(
        "yasa_mcp.tools.codegraph.codegraph_tool.command_util.run_binary",
        return_value=result,
    ) as run_binary:
        tool._run(["status", tmp_path / "project", "-j"])

    run_binary.assert_called_once_with(
        tool.binary,
        ["status", tmp_path / "project", "-j"],
        global_config.prepare_timeout,
    )


def test_prepare_command_explicit_timeout_overrides_global_config(tmp_path):
    tool = _tool(tmp_path)
    project_path = tmp_path / "project"
    result = SimpleNamespace(returncode=0, stdout="", stderr="")

    with patch(
        "yasa_mcp.tools.codegraph.codegraph_tool.command_util.run_binary",
        return_value=result,
    ) as run_binary:
        tool.init_project(project_path, timeout=42)

    run_binary.assert_called_once_with(tool.binary, ["init", project_path], 42)


def test_signal_termination_is_included_in_failure(tmp_path):
    tool = _tool(tmp_path)
    result = SimpleNamespace(
        returncode=-9,
        stdout="Scanning files...\nParsing code...\nResolving refs...\n",
        stderr="",
    )

    with patch(
        "yasa_mcp.tools.codegraph.codegraph_tool.command_util.run_binary",
        return_value=result,
    ):
        with pytest.raises(InvalidToolError) as exc_info:
            tool.init_project(tmp_path / "project")

    message = str(exc_info.value)
    assert "returncode=-9" in message
    assert "termination_signal=SIGKILL(9)" in message
    assert "Resolving refs" in message


def test_timeout_is_rethrown_with_codegraph_diagnostics(tmp_path):
    tool = _tool(tmp_path)

    with patch(
        "yasa_mcp.tools.codegraph.codegraph_tool.command_util.run_binary",
        side_effect=ToolTimeoutError("Run command timed out"),
    ):
        with pytest.raises(ToolTimeoutError) as exc_info:
            tool.sync_project(tmp_path / "project", timeout=17)

    message = str(exc_info.value)
    assert "codegraph command timed out" in message
    assert "args=['sync'," in message
    assert "timeout=17s" in message

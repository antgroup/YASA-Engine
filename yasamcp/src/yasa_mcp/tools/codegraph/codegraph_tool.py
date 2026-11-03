from __future__ import annotations

import json
import logging
import signal
import time
from pathlib import Path
from typing import Any

from yasa_mcp.config import global_config
from yasa_mcp.core import exceptions
from yasa_mcp.core.models import ToolProtocol
from yasa_mcp.tools.codegraph.codegraph_bin_layout import CodeGraphBinaryLayout
from yasa_mcp.util import command_util, log_util

logger = logging.getLogger(__name__)
_DIAGNOSTIC_OUTPUT_LIMIT = 4_000


def _format_output_tail(output: str | None) -> str:
    text = output or ""
    if len(text) <= _DIAGNOSTIC_OUTPUT_LIMIT:
        return repr(text)
    omitted = len(text) - _DIAGNOSTIC_OUTPUT_LIMIT
    return f"<omitted {omitted} chars>{text[-_DIAGNOSTIC_OUTPUT_LIMIT:]!r}"


def _format_returncode(returncode: int) -> str:
    if returncode >= 0:
        return f"returncode={returncode}"
    signal_number = -returncode
    try:
        signal_name = signal.Signals(signal_number).name
    except ValueError:
        signal_name = "UNKNOWN"
    return (
        f"returncode={returncode}, "
        f"termination_signal={signal_name}({signal_number})"
    )


class CodeGraphTool(ToolProtocol):
    """Thin wrapper around the CodeGraph CLI."""

    def __init__(self, codegraph_layout: CodeGraphBinaryLayout):
        self.codegraph_layout = codegraph_layout
        self.initialized = command_util.binary_exists(self.binary)

    @property
    def binary(self) -> Path:
        return self.codegraph_layout.codegraph_bin

    def check_available(self) -> bool:
        return command_util.check_binary_available(self.binary, 60)

    def _run(
        self,
        args: list[str | Path],
        timeout: int = global_config.prepare_timeout,
    ) -> str:
        started_at = time.perf_counter()
        try:
            result = command_util.run_binary(self.binary, args, timeout)
        except exceptions.ToolTimeoutError as exc:
            elapsed = time.perf_counter() - started_at
            message = (
                "codegraph command timed out: "
                f"binary={self.binary}, args={args!r}, timeout={timeout}s, "
                f"elapsed={elapsed:.3f}s, error={exc}"
            )
            log_util.error(message, logger=logger)
            raise exceptions.ToolTimeoutError(message) from exc
        if result.returncode != 0:
            elapsed = time.perf_counter() - started_at
            message = (
                "codegraph command failed: "
                f"binary={self.binary}, args={args!r}, timeout={timeout}s, "
                f"elapsed={elapsed:.3f}s, {_format_returncode(result.returncode)}, "
                f"stderr_tail={_format_output_tail(result.stderr)}, "
                f"stdout_tail={_format_output_tail(result.stdout)}"
            )
            log_util.error(message, logger=logger)
            raise exceptions.InvalidToolError(message)
        return result.stdout or ""

    def init_project(
        self,
        project_path: Path,
        timeout: int = global_config.prepare_timeout,
    ) -> None:
        self._run(["init", project_path], timeout)

    def sync_project(
        self,
        project_path: Path,
        timeout: int = global_config.prepare_timeout,
    ) -> None:
        self._run(["sync", project_path], timeout)

    def status(self, project_path: Path, timeout: int = 120) -> dict[str, Any]:
        stdout = self._run(["status", project_path, "-j"], timeout)
        try:
            status = json.loads(stdout)
        except json.JSONDecodeError as exc:
            message = f"failed to parse codegraph status JSON: {exc}; stdout={stdout!r}"
            log_util.error(message, logger=logger)
            raise exceptions.InvalidToolError(message) from exc
        if not isinstance(status, dict):
            raise exceptions.InvalidToolError(f"codegraph status JSON is not an object: {status!r}")
        return status

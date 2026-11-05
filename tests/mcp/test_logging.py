"""
测试日志输出

覆盖需求:
- NFR-3.3: 单元测试覆盖日志输出格式
- FR-6.1: 框架提供统一日志器，支持 debug/info/warn/error 四级
- FR-6.2: 日志级别通过 --log-level 参数控制，默认 info
- FR-6.3: stdio 模式下日志输出到 stderr（不干扰 stdout 上的 MCP 通信）
- FR-6.4: 日志格式包含时间戳、级别、模块名、消息
"""

from __future__ import annotations

import logging
import pytest

from yasa_mcp.logging_config import setup_logging, get_logger


class TestLogOutput:
    """测试日志输出目标"""

    def test_log_output_to_stderr_not_stdout(self, capsys):
        """stdio 模式日志应输出到 stderr，不在 stdout"""
        setup_logging("debug", "stdio")
        logger = get_logger("test_module")
        logger.info("test message for stderr")

        captured = capsys.readouterr()
        assert "test message for stderr" in captured.err
        assert "test message for stderr" not in captured.out

    def test_log_output_to_stderr_in_http_mode(self, capsys):
        """http 模式日志同样输出到 stderr"""
        setup_logging("debug", "http")
        logger = get_logger("test_http")
        logger.info("http mode log")

        captured = capsys.readouterr()
        assert "http mode log" in captured.err

    def test_no_duplicate_handlers(self, capsys):
        """多次调用 setup_logging 不应产生重复 handler"""
        setup_logging("info", "stdio")
        setup_logging("info", "stdio")
        setup_logging("info", "stdio")

        logger = get_logger("dup_test")
        logger.info("single output")

        captured = capsys.readouterr()
        # 消息应只出现一次
        assert captured.err.count("single output") == 1


class TestLogFormat:
    """测试日志格式 (FR-6.4)"""

    def test_log_contains_level(self, capsys):
        """日志格式应包含级别"""
        setup_logging("debug", "stdio")
        logger = get_logger("format_test")
        logger.info("hello world")

        captured = capsys.readouterr()
        log_line = captured.err.strip()
        assert "[INFO]" in log_line

    def test_log_contains_module_name(self, capsys):
        """日志格式应包含模块名"""
        setup_logging("debug", "stdio")
        logger = get_logger("my.module")
        logger.warning("warn message")

        captured = capsys.readouterr()
        assert "yasa_mcp.my.module" in captured.err

    def test_log_contains_message(self, capsys):
        """日志格式应包含消息内容"""
        setup_logging("debug", "stdio")
        logger = get_logger("msg_test")
        logger.error("critical error occurred")

        captured = capsys.readouterr()
        assert "critical error occurred" in captured.err

    def test_log_contains_timestamp(self, capsys):
        """日志格式应包含时间戳"""
        setup_logging("debug", "stdio")
        logger = get_logger("time_test")
        logger.info("timestamped message")

        captured = capsys.readouterr()
        log_line = captured.err.strip()
        # 时间戳格式: 2026-07-21 10:30:00
        import re
        assert re.search(r"\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}", log_line), \
            f"Timestamp not found in log line: {log_line}"


class TestLogLevelFilter:
    """测试日志级别过滤 (FR-6.1, FR-6.2)"""

    def test_warn_level_filters_debug(self, capsys):
        """WARN 级别下 DEBUG 日志不应输出"""
        setup_logging("warn", "stdio")
        logger = get_logger("filter_test")
        logger.debug("debug should be hidden")
        logger.warning("warn should be visible")

        captured = capsys.readouterr()
        assert "debug should be hidden" not in captured.err
        assert "warn should be visible" in captured.err

    def test_error_level_filters_info_and_debug(self, capsys):
        """ERROR 级别下 INFO 和 DEBUG 日志不应输出"""
        setup_logging("error", "stdio")
        logger = get_logger("error_filter")
        logger.debug("debug hidden")
        logger.info("info hidden")
        logger.error("error visible")

        captured = capsys.readouterr()
        assert "debug hidden" not in captured.err
        assert "info hidden" not in captured.err
        assert "error visible" in captured.err

    def test_debug_level_shows_all(self, capsys):
        """DEBUG 级别下所有级别日志都应输出"""
        setup_logging("debug", "stdio")
        logger = get_logger("all_levels")
        logger.debug("d")
        logger.info("i")
        logger.warning("w")
        logger.error("e")

        captured = capsys.readouterr()
        assert "d" in captured.err
        assert "i" in captured.err
        assert "w" in captured.err
        assert "e" in captured.err

    def test_default_level_is_info(self, capsys):
        """默认日志级别应为 INFO"""
        setup_logging()  # 使用默认值
        logger = get_logger("default_test")
        logger.debug("should be hidden by default")
        logger.info("should be visible by default")

        captured = capsys.readouterr()
        assert "should be hidden by default" not in captured.err
        assert "should be visible by default" in captured.err


class TestGetLogger:
    """测试 get_logger 辅助函数"""

    def test_get_logger_adds_namespace(self):
        """get_logger 应自动添加 yasa_mcp 前缀"""
        logger = get_logger("custom")
        assert logger.name == "yasa_mcp.custom"

    def test_get_logger_preserves_full_name(self):
        """get_logger 对已有 yasa_mcp 前缀的名称不重复添加"""
        logger = get_logger("yasa_mcp.already.full")
        assert logger.name == "yasa_mcp.already.full"

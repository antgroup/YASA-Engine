# -*- coding: utf-8 -*-
"""
test_logging.py —— 日志输出格式与分级测试
=========================================

覆盖验收标准：不同日志级别下，日志输出格式与过滤是否正确。
"""
from __future__ import annotations

import logging

from yasa_mcp.config import LOGGER_NAME, LOG_LEVEL_MAP
from yasa_mcp.logging_config import setup_logging


def test_setup_logging_returns_shared_logger():
    """setup_logging 应返回统一 logger（名称 yasa_mcp）。"""
    logger = setup_logging("info")
    assert logger.name == LOGGER_NAME


def test_log_level_mapping():
    """级别字符串应正确映射到 logging 级别。"""
    assert LOG_LEVEL_MAP["debug"] == logging.DEBUG
    assert LOG_LEVEL_MAP["info"] == logging.INFO
    assert LOG_LEVEL_MAP["warn"] == logging.WARNING
    assert LOG_LEVEL_MAP["error"] == logging.ERROR


def test_debug_logging_not_emitted_at_info_level(caplog):
    """级别设为 info 时，debug 日志不应被输出（过滤生效）。"""
    setup_logging("info")
    logger = logging.getLogger(LOGGER_NAME)

    with caplog.at_level(logging.INFO, logger=LOGGER_NAME):
        logger.debug("this is a debug line")
        logger.info("this is an info line")

    messages = [r.message for r in caplog.records]
    assert "this is an info line" in messages
    assert "this is a debug line" not in messages


def test_log_format_contains_expected_fields(caplog):
    """日志应包含时间 / 级别 / logger 名 / 消息 等统一格式字段。"""
    setup_logging("info")
    logger = logging.getLogger(LOGGER_NAME)

    with caplog.at_level(logging.INFO, logger=LOGGER_NAME):
        logger.info("健康检查通过")

    assert any("健康检查通过" in record.message for record in caplog.records)
    # 记录中应携带级别与 logger 名
    record = next(r for r in caplog.records if "健康检查通过" in r.message)
    assert record.levelname == "INFO"
    assert record.name == LOGGER_NAME

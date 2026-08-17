# -*- coding: utf-8 -*-
"""
logging_config.py —— 统一日志配置
=================================

提供分级日志初始化函数 setup_logging()，全项目共用 LOGGER_NAME
（yasa_mcp）对应的 logger，输出统一格式，便于调试与运维。
"""
from __future__ import annotations

import logging

from yasa_mcp.config import LOG_LEVEL_MAP, LOGGER_NAME

# 统一日志格式：时间 级别 模块: 消息
LOG_FORMAT = "%(asctime)s [%(levelname)s] %(name)s: %(message)s"


def setup_logging(level: str = "info") -> logging.Logger:
    """
    初始化项目统一 logger，并设置指定日志级别。

    Args:
        level: 日志级别字符串，可选 debug / info / warn / error。

    Returns:
        配置完成后的统一 logger（yasa_mcp）。
    """
    log_level = LOG_LEVEL_MAP.get(level, logging.INFO)

    logger = logging.getLogger(LOGGER_NAME)
    logger.setLevel(log_level)

    # 避免重复添加 handler（测试多次调用 setup_logging 时保持幂等）
    if not any(isinstance(h, logging.StreamHandler) for h in logger.handlers):
        handler = logging.StreamHandler()
        handler.setFormatter(logging.Formatter(LOG_FORMAT))
        logger.addHandler(handler)

    # 防止日志向更上层的 root logger 重复传播
    logger.propagate = False

    return logger

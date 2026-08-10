# -*- coding: utf-8 -*-
"""
test_config.py —— 配置加载与环境变量强校验测试
==============================================
"""
from __future__ import annotations

import os

import pytest

from yasa_mcp.config import (
    ConfigError,
    ENV_LOG_LEVEL,
    ENV_PORT,
    ENV_REPO_ROOT,
    ENV_TRANSPORT,
    ServerConfig,
    validate_repo_root,
)


def test_missing_repo_root_raises_config_error(monkeypatch):
    """未设置 YASA_MCP_REPO_ROOT -> 抛 ConfigError。"""
    monkeypatch.delenv(ENV_REPO_ROOT, raising=False)
    with pytest.raises(ConfigError):
        validate_repo_root()


def test_empty_repo_root_raises_config_error(monkeypatch):
    """YASA_MCP_REPO_ROOT 为空字符串 -> 抛 ConfigError。"""
    monkeypatch.setenv(ENV_REPO_ROOT, "   ")
    with pytest.raises(ConfigError):
        validate_repo_root()


def test_non_existent_repo_root_raises_config_error(monkeypatch, tmp_path):
    """YASA_MCP_REPO_ROOT 指向不存在/非目录路径 -> 抛 ConfigError。"""
    missing = str(tmp_path / "does-not-exist")
    monkeypatch.setenv(ENV_REPO_ROOT, missing)
    with pytest.raises(ConfigError):
        validate_repo_root()


def test_valid_repo_root_returns_abs_path(monkeypatch, tmp_path):
    """合法目录 -> 返回规范化绝对路径。"""
    monkeypatch.setenv(ENV_REPO_ROOT, str(tmp_path))
    result = validate_repo_root()
    assert result == os.path.abspath(str(tmp_path))


def test_from_env_uses_defaults(monkeypatch, tmp_path):
    """只配置合法 REPO_ROOT，其余走默认值。"""
    monkeypatch.setenv(ENV_REPO_ROOT, str(tmp_path))
    monkeypatch.delenv(ENV_TRANSPORT, raising=False)
    monkeypatch.delenv(ENV_LOG_LEVEL, raising=False)
    monkeypatch.delenv(ENV_PORT, raising=False)

    config = ServerConfig.from_env()
    assert config.transport == "stdio"
    assert config.log_level == "info"
    assert config.port == 8765
    assert config.repo_root == os.path.abspath(str(tmp_path))


def test_from_env_cli_overrides_env(monkeypatch, tmp_path):
    """命令行参数优先级应高于环境变量。"""
    monkeypatch.setenv(ENV_REPO_ROOT, str(tmp_path))
    monkeypatch.setenv(ENV_TRANSPORT, "http")
    monkeypatch.setenv(ENV_PORT, "9999")

    config = ServerConfig.from_env(transport="stdio", port=8765)
    # CLI 显式传入的 stdio 覆盖环境变量的 http
    assert config.transport == "stdio"
    # CLI 显式传入的 8765 覆盖环境变量的 9999
    assert config.port == 8765


def test_from_env_invalid_transport_raises(monkeypatch, tmp_path):
    """非法 transport -> 抛 ConfigError。"""
    monkeypatch.setenv(ENV_REPO_ROOT, str(tmp_path))
    monkeypatch.setenv(ENV_TRANSPORT, "carrier-pigeon")
    with pytest.raises(ConfigError):
        ServerConfig.from_env()


def test_from_env_invalid_log_level_raises(monkeypatch, tmp_path):
    """非法 log_level -> 抛 ConfigError。"""
    monkeypatch.setenv(ENV_REPO_ROOT, str(tmp_path))
    monkeypatch.setenv(ENV_LOG_LEVEL, "loud")
    with pytest.raises(ConfigError):
        ServerConfig.from_env()


def test_from_env_invalid_port_raises(monkeypatch, tmp_path):
    """非法端口 -> 抛 ConfigError。"""
    monkeypatch.setenv(ENV_REPO_ROOT, str(tmp_path))
    monkeypatch.setenv(ENV_PORT, "not-a-number")
    with pytest.raises(ConfigError):
        ServerConfig.from_env()

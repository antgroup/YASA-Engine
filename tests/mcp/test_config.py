"""
测试配置管理

覆盖需求:
- FR-1.2: 支持命令行参数配置启动行为
- FR-1.3: 支持环境变量配置（至少 YASA_MCP_REPO_ROOT）
- FR-2.4: 传输模式通过 --transport 参数切换，默认 stdio
- FR-5.2: 框架自身异常有明确错误提示并优雅退出
"""

from __future__ import annotations

import os
import sys
import tempfile

import pytest

from yasa_mcp.config import ServerConfig, parse_config


class TestServerConfig:
    """测试 ServerConfig dataclass"""

    def test_default_values(self):
        """默认值应正确"""
        config = ServerConfig(repo_root="/tmp")
        assert config.transport == "stdio"
        assert config.port == 8765
        assert config.log_level == "info"

    def test_frozen(self):
        """ServerConfig 应为不可变"""
        config = ServerConfig(repo_root="/tmp")
        with pytest.raises(Exception):
            config.transport = "http"  # type: ignore


class TestParseConfig:
    """测试 parse_config"""

    def test_default_transport_is_stdio(self, temp_repo_root):
        """默认传输模式应为 stdio"""
        config = parse_config([])
        assert config.transport == "stdio"

    def test_transport_http(self, temp_repo_root):
        """--transport http 应被正确解析"""
        config = parse_config(["--transport", "http"])
        assert config.transport == "http"

    def test_port_argument(self, temp_repo_root):
        """--port 应被正确解析"""
        config = parse_config(["--transport", "http", "--port", "9999"])
        assert config.port == 9999

    def test_default_port(self, temp_repo_root):
        """默认端口应为 8765"""
        config = parse_config(["--transport", "http"])
        assert config.port == 8765

    def test_log_level_argument(self, temp_repo_root):
        """--log-level 应被正确解析"""
        for level in ["debug", "info", "warn", "error"]:
            config = parse_config(["--log-level", level])
            assert config.log_level == level

    def test_default_log_level(self, temp_repo_root):
        """默认日志级别应为 info"""
        config = parse_config([])
        assert config.log_level == "info"

    def test_reads_repo_root_from_env(self, temp_repo_root):
        """YASA_MCP_REPO_ROOT 环境变量应被读取"""
        config = parse_config([])
        assert config.repo_root == temp_repo_root

    def test_invalid_transport_choice(self, temp_repo_root):
        """无效的 transport 值应报错"""
        with pytest.raises(SystemExit):
            parse_config(["--transport", "invalid"])

    def test_invalid_log_level_choice(self, temp_repo_root):
        """无效的 log-level 值应报错"""
        with pytest.raises(SystemExit):
            parse_config(["--log-level", "verbose"])

    def test_missing_repo_root_exits(self, monkeypatch):
        """缺少 YASA_MCP_REPO_ROOT 应优雅退出 (FR-5.2)"""
        monkeypatch.delenv("YASA_MCP_REPO_ROOT", raising=False)
        with pytest.raises(SystemExit):
            parse_config([])

    def test_nonexistent_repo_root_exits(self, monkeypatch):
        """不存在的 repo_root 路径应优雅退出 (FR-5.2)"""
        monkeypatch.setenv("YASA_MCP_REPO_ROOT", "/nonexistent/path/that/does/not/exist")
        with pytest.raises(SystemExit):
            parse_config([])

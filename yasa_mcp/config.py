# -*- coding: utf-8 -*-
"""
config.py —— 配置加载与环境变量强制校验
=======================================

职责：
    1. 集中管理所有环境变量名常量，避免字符串散落各处；
    2. 强制校验必填环境变量 YASA_MCP_REPO_ROOT，为空直接抛异常；
    3. 提供 ServerConfig 数据类，统一承载服务运行配置；
    4. 提供分级日志初始化函数 setup_logging。

优先级约定：命令行参数 > 环境变量 > 默认值。
"""
from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field
from typing import List, Optional

# ---------------------------------------------------------------------------
# 环境变量名常量
# 后续新增配置项时，只需在此追加常量，并在 from_env() 中同步读取逻辑即可。
# ---------------------------------------------------------------------------
ENV_REPO_ROOT = "YASA_MCP_REPO_ROOT"    # 必填：待分析的代码仓库根目录
ENV_LOG_LEVEL = "YASA_MCP_LOG_LEVEL"    # 可选：日志级别，默认 info
ENV_PORT       = "YASA_MCP_PORT"        # 可选：HTTP 端口，默认 8765
ENV_TRANSPORT  = "YASA_MCP_TRANSPORT"   # 可选：传输模式，默认 stdio

# 合法取值集合（供命令行 / 环境变量双重校验）
VALID_TRANSPORTS = ("stdio", "http")
VALID_LOG_LEVELS = ("debug", "info", "warn", "error")

# 日志级别字符串 -> logging 级别 映射表
LOG_LEVEL_MAP = {
    "debug": logging.DEBUG,
    "info":  logging.INFO,
    "warn":  logging.WARNING,
    "error": logging.ERROR,
}

# 项目统一 logger 名称：所有模块共享同一个 logger，便于分级管理
LOGGER_NAME = "yasa_mcp"


class ConfigError(Exception):
    """配置错误：环境变量缺失 / 非法时抛出，由命令行入口层捕获并友好提示。"""


# ---------------------------------------------------------------------------
# 强制校验
# ---------------------------------------------------------------------------
def validate_repo_root() -> str:
    """
    强制校验环境变量 YASA_MCP_REPO_ROOT（脚手架必做动作）。

    规则：
        - 未设置或为空值  -> 直接抛出 ConfigError，提示用户先配置；
        - 指向的路径不存在 / 不是目录 -> 抛出 ConfigError。
    通过后返回规范化后的绝对路径。
    """
    raw = os.environ.get(ENV_REPO_ROOT, "").strip()
    if not raw:
        raise ConfigError(
            f"[YASA-MCP] 环境变量 {ENV_REPO_ROOT} 未配置或为空！\n"
            f"请先设置该环境变量，指向待分析的代码仓库根目录，例如：\n"
            f"  Windows   : set {ENV_REPO_ROOT}=D:\\path\\to\\repo\n"
            f"  Mac/Linux : export {ENV_REPO_ROOT}=/path/to/repo"
        )

    # 归一化为绝对路径，兼容 Windows 反斜杠 / 正斜杠写法
    root = os.path.abspath(raw)
    if not os.path.isdir(root):
        raise ConfigError(
            f"[YASA-MCP] 环境变量 {ENV_REPO_ROOT} 指向的路径不存在或不是目录：{root}"
        )
    return root


# ---------------------------------------------------------------------------
# 配置对象
# ---------------------------------------------------------------------------
@dataclass
class ServerConfig:
    """
    服务运行配置（纯数据类，无业务逻辑）。

    优先级：命令行参数 > 环境变量 > 默认值。
    """

    server_name: str = "yasa-mcp"          # 服务名（MCP server name）
    version: str = "0.1.0"                 # 服务版本号
    repo_root: str = ""                    # 仓库根目录（必填，由校验保证）
    transport: str = "stdio"               # 传输模式：stdio / http
    port: int = 8765                       # HTTP 模式监听端口
    log_level: str = "info"                # 日志级别
    transports_supported: List[str] = field(  # 声明的传输能力（ping 固定返回使用）
        default_factory=lambda: ["stdio", "streamable-http"]
    )

    @classmethod
    def from_env(
        cls,
        transport: Optional[str] = None,
        port: Optional[int] = None,
        log_level: Optional[str] = None,
    ) -> "ServerConfig":
        """
        从「命令行参数 + 环境变量」构建配置。

        参数（由 __main__.py 传入命令行解析结果）：
            transport : 命令行 --transport
            port      : 命令行 --port
            log_level : 命令行 --log-level
        """
        # 1) 必填项强制校验（为空/非法直接抛 ConfigError）
        repo_root = validate_repo_root()

        # 2) 传输模式：命令行 > 环境变量 > 默认 stdio
        t = (transport or os.environ.get(ENV_TRANSPORT, "stdio")).strip().lower()
        if t not in VALID_TRANSPORTS:
            raise ConfigError(
                f"[YASA-MCP] 非法传输模式 '{t}'，可选值：{', '.join(VALID_TRANSPORTS)}"
            )

        # 3) 端口：命令行 > 环境变量 > 默认 8765
        raw_port = os.environ.get(ENV_PORT, "8765") if port is None else str(port)
        try:
            p = int(raw_port)
        except (TypeError, ValueError):
            raise ConfigError(f"[YASA-MCP] 非法端口号 '{raw_port}'，应为整数。")
        if not (0 < p < 65536):
            raise ConfigError(f"[YASA-MCP] 端口号越界（1-65535）：{p}")

        # 4) 日志级别：命令行 > 环境变量 > 默认 info
        lv = (log_level or os.environ.get(ENV_LOG_LEVEL, "info")).strip().lower()
        if lv not in VALID_LOG_LEVELS:
            raise ConfigError(
                f"[YASA-MCP] 非法日志级别 '{lv}'，可选值：{', '.join(VALID_LOG_LEVELS)}"
            )

        return cls(
            repo_root=repo_root,
            transport=t,
            port=p,
            log_level=lv,
        )


def get_config() -> ServerConfig:
    """便捷入口：仅读取环境变量构建配置（无命令行覆盖，常用于测试/脚本）。"""
    return ServerConfig.from_env()


# ---------------------------------------------------------------------------
# 分级日志
# ---------------------------------------------------------------------------
def setup_logging(log_level: str = "info") -> logging.Logger:
    """
    初始化统一 logger（分级日志系统）。

    特点：
        - 全程只创建一次 StreamHandler，避免重复打印；
        - 级别由 log_level 控制（debug/info/warn/error）；
        - 所有模块通过 logging.getLogger(LOGGER_NAME) 拿到同一个 logger。
    """
    level = LOG_LEVEL_MAP.get((log_level or "info").lower(), logging.INFO)

    logger = logging.getLogger(LOGGER_NAME)
    logger.setLevel(level)
    logger.propagate = False  # 关闭向上传递，避免与根 logger 重复输出

    if not logger.handlers:  # 已初始化过则不再重复添加
        handler = logging.StreamHandler()
        handler.setFormatter(
            logging.Formatter(
                fmt="[%(asctime)s][%(levelname)s][%(name)s] %(message)s",
                datefmt="%Y-%m-%d %H:%M:%S",
            )
        )
        logger.addHandler(handler)

    return logger

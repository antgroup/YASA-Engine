"""
统一错误码与异常定义

所有框架级异常继承 YasaMCPError，提供统一的 to_dict() 序列化方法，
用于生成结构化的 MCP 错误响应。
"""

from __future__ import annotations


class YasaMCPError(Exception):
    """框架基础异常"""

    code: str = "UNKNOWN_ERROR"  # 保底措施
    message: str = "An unknown error occurred"  # 保底

    def __init__(self, message: str | None = None, **extra):
        self.message = message or self.message
        self.extra = extra
        super().__init__(self.message)

    def to_dict(self) -> dict:
        """序列化为结构化错误字典"""
        result = {
            "error": True,
            "code": self.code,
            "message": self.message,
        }
        if self.extra:
            result.update(self.extra)
        return result


class ConfigError(YasaMCPError):
    """配置错误（如缺少环境变量、端口无效等）"""

    code = "CONFIG_ERROR"
    message = "Configuration error"


class ValidationError(YasaMCPError):
    """参数校验失败"""

    code = "VALIDATION_ERROR"
    message = "Parameter validation failed"


class ToolExecutionError(YasaMCPError):
    """Tool 执行过程中发生异常"""

    code = "TOOL_EXECUTION_ERROR"
    message = "Tool execution failed"


class ToolNotFoundError(YasaMCPError):
    """请求的 tool 未注册"""

    code = "TOOL_NOT_FOUND"
    message = "Requested tool is not registered"

# 还可以添加
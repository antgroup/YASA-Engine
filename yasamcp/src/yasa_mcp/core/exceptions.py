"""自定义异常类"""


class YasaMcpError(Exception):
    """Yasa MCP 基础异常"""
    pass


class ContextNotInitializedError(YasaMcpError):
    """上下文未初始化异常"""
    pass


class ProjectNotFoundError(YasaMcpError):
    """项目未找到异常"""
    pass


class InvalidParameterError(YasaMcpError):
    """参数无效异常"""
    pass

class InvalidToolError(YasaMcpError):
    """工具无效异常"""
    pass


class InvalidCacheError(YasaMcpError):
    """缓存无效异常"""
    pass

class FileNotFoundError(YasaMcpError):
    """文件未找到异常"""
    pass


class PlatformNotSupportedError(YasaMcpError):
    """平台不支持异常"""
    pass


class PathNotAbsoluteError(YasaMcpError):
    """路径不是绝对路径异常"""
    pass


class LanguageNotSupportedError(YasaMcpError):
    """语言不支持异常"""
    pass


class ToolTimeoutError(YasaMcpError):
    """工具超时异常"""
    pass

class ToolError(YasaMcpError):
    """工具异常"""
    pass

class UnknownError(YasaMcpError):
    """未知异常"""
    pass
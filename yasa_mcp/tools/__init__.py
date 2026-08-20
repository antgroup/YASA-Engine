"""tools 包: 所有 MCP Tool 实现放在此目录下"""

# 此文件存在以确保 Python 将 tools 识别为包。
# auto_discover_tools() 会扫描此目录下所有 .py 模块，
# 找到使用 @mcp_tool 装饰的函数并自动注册。

# 显式导入 ping 模块，确保在包被 import 时 ping tool 即被加载
from yasa_mcp.tools import ping  # noqa: F401

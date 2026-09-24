import logging
from pathlib import Path
from typing import Any, Dict

from yasa_mcp.core.enums import Tool
from yasa_mcp.core.models import ToolProtocol
from yasa_mcp.core.exceptions import InvalidToolError
from yasa_mcp.layout.binary_layout import BinaryLayout
from yasa_mcp.util import log_util
from yasa_mcp.tools.ripgrep.ripgrep_tool import RipgrepTool
from yasa_mcp.tools.scc.scc_tool import SccTool
from yasa_mcp.tools.yasa.yasa_tool import YasaTool
from yasa_mcp.tools.codegraph.codegraph_tool import CodeGraphTool

logger = logging.getLogger(__name__)


class YasaMcpRuntime:
    """Yasa 运行时环境：进程级单例，工具按需懒加载。

    初始化时不跑 native binary ``--version``，避免普通查询在每次进程启动时
    为 5 个二进制各花数秒校验。工具实例仅在首次 ``get_tool`` 时按需创建
    （廉价存在检测），并缓存于 ``tools`` 字典。

    runtime 是进程级单例，不与单个 init 任务绑定：binary_path 变更时
    ``init_runtime`` 会重建单例，兼容 init -b 覆盖已启动的单例。
    """

    def __init__(self, binary_path: Path):
        self.binary_path = binary_path
        self.binary_layout = BinaryLayout.from_root(binary_path)
        self.tools: Dict[Tool, Any] = {}
        bl = self.binary_layout
        # Tool → ToolProtocol 直接映射，不再有 BinaryLayout 中间层。
        self._tool_instances: Dict[Tool, ToolProtocol] = {
            Tool.YASA: YasaTool(bl.yasa),
            Tool.RIPGREP: RipgrepTool(bl.ripgrep),
            Tool.CODEGRAPH: CodeGraphTool(bl.codegraph),
            Tool.SCC: SccTool(bl.scc),
        }
        log_util.info(
            f"YasaRuntime ready (binary={binary_path}, lazy tools, no eager version checks).",
            logger=logger,
        )

    def get_tool(self, name: Tool) -> ToolProtocol:
        tool = self.tools.get(name)
        if tool is not None:
            return tool
        tool = self._tool_instances.get(name)
        if tool is None:
            raise InvalidToolError(f"Tool: '{name.value}' not registered.")
        # 未登记为 initialized（二进制不存在等）时不缓存，下次访问可重试。
        if not getattr(tool, "initialized", False):
            raise InvalidToolError(f"Tool: '{name.value}' not available (binary missing or not initialized).")
        self.tools[name] = tool
        return tool


# 全局 Runtime 单例
_runtime: YasaMcpRuntime | None = None


def init_runtime(binary_path: Path) -> YasaMcpRuntime:
    """初始化（或 binary_path 变更时重建）runtime 单例。

    同一 binary_path 时幂等返回既有单例；binary_path 变了则重建，兼容
    init -b 覆盖一个已启动进程的单例（如 server 常驻后 init 切换 binary）。
    """
    global _runtime
    if _runtime is None or _runtime.binary_path != binary_path:
        _runtime = YasaMcpRuntime(binary_path)
    return _runtime


def get_runtime() -> YasaMcpRuntime | None:
    return _runtime

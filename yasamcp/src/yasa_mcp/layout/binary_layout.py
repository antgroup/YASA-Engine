from pathlib import Path

from pydantic import BaseModel

from yasa_mcp.core import exceptions
from yasa_mcp.tools.yasa.yasa_bin_layout import YasaBinaryLayout
from yasa_mcp.tools.ripgrep.ripgrep_bin_layout import RipGrepBinaryLayout
from yasa_mcp.tools.scc.scc_bin_layout import SccBinaryLayout
from yasa_mcp.tools.codegraph.codegraph_bin_layout import CodeGraphBinaryLayout
from yasa_mcp.util.path_util import validate_path
from yasa_mcp.util.platform_util import detect_platform

class BinaryLayout(BaseModel):
    """顶层二进制布局

    - 输入一个 bin 根目录（不含平台），例如: /path/to/bin
    - 自动根据当前平台选择子目录: darwin-aarch64 / linux-x86-64 等
    - 再在平台目录下拆分出 yasa / ripgrep / codegraph / scc 工具的根路径
    - 具体工具内部结构由各自的 *BinaryLayout* 负责
    """

    # bin 根目录（不含平台）
    root_path: Path

    # 平台目录名，例如 darwin-aarch64 / linux-x86-64
    platform: str

    # 各工具的二进制布局
    yasa: YasaBinaryLayout
    ripgrep: RipGrepBinaryLayout
    codegraph: CodeGraphBinaryLayout
    scc: SccBinaryLayout

    @property
    def platform_root(self) -> Path:
        """当前平台对应的子目录路径"""
        return self.root_path / self.platform

    @property
    def yasa_root(self) -> Path:
        """Yasa 工具根目录（传给 YasaTool 的路径）"""
        return self.yasa.root_path

    @property
    def ripgrep_root(self) -> Path:
        """Ripgrep 工具根目录（传给 RipgrepTool 的路径）"""
        return self.ripgrep.root_path

    @property
    def codegraph_root(self) -> Path:
        """CodeGraph 工具根目录（传给 CodeGraphTool 的路径）"""
        return self.codegraph.root_path

    @property
    def scc_root(self) -> Path:
        """SCC 工具根目录（传给 SccTool 的路径）"""
        return self.scc.root_path

    @classmethod
    def from_root(cls, root: Path) -> "BinaryLayout":
        """根据 bin 根目录创建二进制布局

        Args:
            root: bin 根目录（不包含平台），例如 /opt/yasa-mcp/bin
        """
        root_path = validate_path(root)

        # 按当前平台选择子目录
        platform = detect_platform()
        platform_root = validate_path(root_path / platform)

        # 为每个工具构造子布局
        yasa_root = platform_root / "yasa"
        ripgrep_root = platform_root / "ripgrep"
        codegraph_root = platform_root / "codegraph"
        scc_root = platform_root / "scc"

        yasa_layout = YasaBinaryLayout(root_path=yasa_root)
        ripgrep_layout = RipGrepBinaryLayout(root_path=ripgrep_root)
        codegraph_layout = CodeGraphBinaryLayout(root_path=codegraph_root)
        scc_layout = SccBinaryLayout(root_path=scc_root)

        return cls(
            root_path=root_path,
            platform=platform,
            yasa=yasa_layout,
            ripgrep=ripgrep_layout,
            codegraph=codegraph_layout,
            scc=scc_layout,
        )

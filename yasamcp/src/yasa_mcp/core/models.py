from typing import TYPE_CHECKING, Protocol, runtime_checkable
from pathlib import Path
from pydantic import BaseModel
from typing import Any

if TYPE_CHECKING:
    from yasa_mcp.repository.shared_analysis_duckdb import SharedDuckDBReadPool


@runtime_checkable
class LocationProtocol(Protocol):
    """定义location接口，以转换不同工具的location"""

    file_path: Path
    start_line: int
    start_column: int
    end_line: int
    end_column: int

    def to_string(self) -> str:
        return f"{self.file_path}:{self.start_line}:{self.start_column}:{self.end_line}:{self.end_column}"

    def contains(self, line: int, column: int = None) -> bool:
        """判断给定的位置是否在当前location范围内"""
        if line < self.start_line or line > self.end_line:
            return False

        if column is None:
            return True

        # 在起始行，需要检查列号
        if line == self.start_line and column < self.start_column:
            return False

        # 在结束行，需要检查列号
        if line == self.end_line and column > self.end_column:
            return False

        return True

    def overlaps(self, other: 'LocationProtocol') -> bool:
        """判断两个location是否有重叠"""
        if self.file_path != other.file_path:
            return False

        # 如果一个范围在另一个范围之前或之后，则不重叠
        # self 在 other 之前：self.end < other.start
        if self.end_line < other.start_line:
            return False
        if self.end_line == other.start_line and self.end_column < other.start_column:
            return False

        # self 在 other 之后：self.start > other.end
        if self.start_line > other.end_line:
            return False
        if self.start_line == other.end_line and self.start_column > other.end_column:
            return False

        return True

    def __hash__(self):
        return self.to_string()

    def __eq__(self, other: 'LocationProtocol') -> bool:
        return self.to_string() == other.to_string()


class ToolProtocol(Protocol):
    """定义工具接口"""

    def check_available(self, ) -> bool:
        ...


class ToolContext(Protocol):
    """定义工具上下文接口"""


class ReadPoolAware(Protocol):
    """显式声明工具上下文可接收共享 DuckDB 只读连接池。"""

    def set_read_pool(self, read_pool: "SharedDuckDBReadPool") -> None:
        ...

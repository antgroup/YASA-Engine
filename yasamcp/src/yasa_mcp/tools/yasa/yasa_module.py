from enum import Enum
from typing import Any

from pydantic import BaseModel, computed_field, model_validator, field_validator, ValidationInfo
import os
from pathlib import Path

from yasa_mcp.core import exceptions
from yasa_mcp.util import file_util, path_util
from yasa_mcp.config import global_config
from yasa_mcp.core.models import LocationProtocol


class Position(BaseModel):
    line: int
    column: int = 0  # YASA 对 @dataclass 等自动生成的 __init__ 可能输出 column=null，默认为 0

    @field_validator("column", mode="before")
    @classmethod
    def column_null_to_zero(cls, v):
        return v if v is not None else 0


class Location(BaseModel):
    """
    注意：不再继承 LocationProtocol，避免与 Pydantic BaseModel 的元类冲突。
    通过“结构化类型”，只要实现了 LocationProtocol 中定义的属性/方法，
    就能被当作 LocationProtocol 使用。
    """

    start: Position
    end: Position
    sourcefile: str

    @field_validator("sourcefile", mode="before")
    @classmethod
    def make_path_relative(cls, v: Any, info: ValidationInfo) -> str:
        """
        在验证前运行，将 sourcefile 转换为相对路径。
        'v' 是从 JSON 中读取的原始 sourcefile 字符串。
        """
        # 1. 检查上下文中是否传入了 'project_path'
        if not info.context or "project_path" not in info.context:
            # 如果没有提供项目根目录，直接返回原始值
            return v

        project_root = info.context["project_path"]
        if not isinstance(project_root, Path):
            return v

        return str(path_util.get_relative_path_by_appname(v, project_root))

    @property
    def file_path(self) -> Path:
        return Path(self.sourcefile)

    @property
    def start_line(self) -> int:
        return self.start.line

    @property
    def start_column(self) -> int:
        return self.start.column

    @property
    def end_line(self) -> int:
        return self.end.line

    @property
    def end_column(self) -> int:
        return self.end.column

    # ---- LocationProtocol 接口实现（复用协议里的默认逻辑，避免重复代码）----
    def to_string(self) -> str:
        return LocationProtocol.to_string(self)  # type: ignore[call-arg]

    def contains(self, line: int, column: int = None) -> bool:
        # 直接调用 LocationProtocol 上的实现，只传入 self
        return LocationProtocol.contains(self, line, column)  # type: ignore[call-arg]

    def overlaps(self, other: LocationProtocol) -> bool:
        return LocationProtocol.overlaps(self, other)  # type: ignore[call-arg]

    def __hash__(self):
        return LocationProtocol.__hash__(self)

    def __eq__(self, other):
        return LocationProtocol.__eq__(self, other)


class FuncDef(BaseModel):
    loc: Location | str
    name: str

    def get_id(self):
        if isinstance(self.loc, str):
            return self.loc
        return f"{self.loc.sourcefile}#{self.loc.start.line}"


class Node(BaseModel):
    id: str
    funcDef: FuncDef | str
    fullName: str


class CallSite(BaseModel):
    loc: Location | None

    @model_validator(mode='before')
    @classmethod
    def check_empty_loc(cls, data):
        """
        在验证前检查传入的数据。
        如果 'loc' 是一个空字典 {}，就将其转换为 None。
        """
        # 确保传入的是一个字典
        if isinstance(data, dict):
            # 检查 'loc' 键是否存在并且其值是空字典
            if 'loc' in data and data['loc'] == {}:
                # 步骤2: 将空字典替换为 None
                data['loc'] = None
        return data

    def get_id(self):
        """
        获取callsite id
        """
        return f"{self.loc.sourcefile}#{self.loc.start.line}:{self.loc.start.column}:{self.loc.end.line}:{self.loc.end.column}"


class Edge(BaseModel):
    id: str
    sourceNodeId: str
    targetNodeId: str
    callSite: CallSite | None


class CallGraph(BaseModel):
    nodes: dict[str, Node]
    edges: dict[str, Edge]

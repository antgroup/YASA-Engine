import uuid
from pathlib import Path
from typing import Generic, Literal, Protocol, TypeVar, runtime_checkable

from pydantic import BaseModel, Field, HttpUrl, ValidationError

from yasa_mcp.core import exceptions
from yasa_mcp.tools.yasa import yasa_module
from yasa_mcp.core.models import LocationProtocol
from yasa_mcp.core.cache_status import CacheStatus

class Location(BaseModel):
    file_path: Path
    start_line: int
    start_column: int
    end_line: int
    end_column: int

    @classmethod
    def from_string(cls, location_str: str) -> "Location":
        try:
            file_path, start_line, start_column, end_line, end_column = location_str.split(":")
            return cls(
                file_path=Path(file_path),
                start_line=int(start_line),
                start_column=int(start_column),
                end_line=int(end_line),
                end_column=int(end_column),
            )
        except Exception:
            raise exceptions.InvalidParameterError(
                f"location格式错误，正确格式为 <文件路径>:<起始行>:<起始列>:<结束行>:<结束列>, 当前为: {location_str}"
            )

    @classmethod
    def default(cls):
        return cls(
            file_path=Path("default"),
            start_line=0,
            start_column=0,
            end_line=0,
            end_column=0
        )

    @classmethod
    def from_protocol(cls, loc: LocationProtocol):
        return cls(
            file_path=loc.file_path,
            start_line=loc.start_line,
            start_column=loc.start_column,
            end_line=loc.end_line,
            end_column=loc.end_column
        )

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


class GetCallGraphInput(BaseModel):
    function_fqn: str
    function_signature: str
    file_path: str
    line: int
    depth: int
    fuzzy_match: bool
    detail_level: str


class Caller(BaseModel):
    function_fqn: str
    function_signature: str
    file_path: str
    line: int


class CallSite(BaseModel):
    file_path: str
    line: int
    content: str


class Callee(BaseModel):
    call_site: CallSite
    function_fqn: str
    function_signature: str
    location: Location
    content: str
    has_cycle: bool
    callees: list["Callee"]


T = TypeVar("T")


class YasaMcpResults(BaseModel, Generic[T]):
    """所有 MCP 工具的统一返回包装"""
    results: list[T] = []
    truncated: bool = False
    total_count: int = 0


class QuerySymbolResult(BaseModel):
    """Uniform cached CodeGraph symbol result used by ``search_symbol``."""

    model_config = {"frozen": True}

    kind: str
    name: str
    qualified_name: str
    language: str
    location: Location | None = None
    content: str = ""


class GetCallGraphOutput(BaseModel):
    caller: Caller
    callees: list[Callee]


class GetFunctionDefByFunctionCallOutput(BaseModel):
    caller: Caller
    call_site: CallSite
    function_fqn: str
    function_signature: str
    location: Location
    content: str
    callType: Literal["local", "remote"] = "local"
    extinfo: dict = Field(default_factory=dict)


class GetFunctionReferenceOutput(BaseModel):
    call_site: CallSite
    function_fqn: str
    location: Location
    content: str


class MethodInfo(BaseModel):
    """类内方法摘要信息"""
    name: str
    function_signature: str
    line: int


class GetClassDefOutput(BaseModel):
    class_fqn: str
    file_path: str
    location: Location | None = None
    content: str
    methods: list[MethodInfo] = []


class GetFunctionDefInput(BaseModel):
    function_fqn: str
    function_signature: str
    fuzzy_match: bool


class ParameterAnnotation(BaseModel):
    annotation: str
    parameter_name: str = ""

class GetFunctionDefOutput(BaseModel):
    function_fqn: str
    function_signature: str
    file_path: str
    location: Location | None = None
    content: str
    function_annotations: list[str] = []
    parameter_annotations: list[ParameterAnnotation] = []


class GetFileContentByKeywordInput(BaseModel):
    keyword: str


class MatchSnippet(BaseModel):
    """匹配片段：summary 模式包含 line + 上下文片段；full 模式包含完整文件内容（line 为空）"""
    line: int | None = None
    content: str


class GetFileContentByKeywordOutput(BaseModel):
    file_path: str
    matches: list[MatchSnippet] = []



class ClassDef(BaseModel):
    class_fqn: str
    location: Location
    total_lines: int

    def match_location(self, location: Location) -> bool:
        if not self.location.source_file == location.source_file:
            return False
        if not self.location.start_line == location.start_line:
            return False
        return True


# 用于构造yasa和uql的中间数据
class FunctionDef(BaseModel):
    node_id: str
    function_fqn: str
    function_signature: str
    location: Location



class ImportResult(BaseModel):
    module: str
    names: list[str]
    line: int
    resolved_file_path: str


class RouterDef(BaseModel):
    api_name: str
    framework: str = ""
    full_name: str = ""
    signature: str = ""
    filepath: str
    location: Location
    content: str = ""

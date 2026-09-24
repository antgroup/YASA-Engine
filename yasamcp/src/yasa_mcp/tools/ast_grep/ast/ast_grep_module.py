"""Data models for ast-grep analysis results."""

from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class Location:
    """Source code location."""
    file_path: Path
    start_line: int
    start_column: int
    end_line: int
    end_column: int

    def to_string(self) -> str:
        return f"{self.file_path}:{self.start_line}:{self.start_column}:{self.end_line}:{self.end_column}"


@dataclass
class FuncInfo:
    """Function definition information."""
    name: str
    fqn: str
    signature: str
    location: Location
    content: str = ""
    annotations: list[str] = field(default_factory=list)
    parameter_annotations: list[dict[str, str]] = field(default_factory=list)


@dataclass
class ClassInfo:
    """Class definition information."""
    name: str
    fqn: str
    location: Location
    content: str = ""
    methods: list["MethodSummary"] = field(default_factory=list)
    # CHA 扩展
    superclass_name: str | None = None
    interface_names: list[str] = field(default_factory=list)
    is_abstract: bool = False
    is_interface: bool = False


@dataclass
class MethodSummary:
    """Brief method info within a class."""
    name: str
    signature: str
    line: int


@dataclass
class CallInfo:
    """Function call site information."""
    caller_fqn: str
    callee_name: str
    location: Location
    content: str = ""

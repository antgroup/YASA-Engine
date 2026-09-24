from __future__ import annotations

from dataclasses import dataclass
from typing import Mapping

from yasa_mcp.repository.query.codegraph.query_models import (
    ClassRecord,
    FunctionRecord,
    NodeRecord,
)
from yasa_mcp.util.codegraph_param_util import CodeGraphParamUtil


@dataclass(frozen=True)
class CodeGraphNodeRow:
    id: str
    kind: str
    name: str
    qualified_name: str
    signature: str | None
    return_type: str | None
    file_path: str
    start_line: int
    start_column: int
    end_line: int
    end_column: int
    language: str = ""
    score: float = 0.0

    @classmethod
    def from_mapping(cls, row: Mapping[str, object]) -> "CodeGraphNodeRow":
        signature = row.get("signature")
        return_type = row.get("return_type")
        start_line = int(row.get("start_line") or 0)
        return cls(
            id=str(row.get("id") or ""),
            kind=str(row.get("kind") or ""),
            name=str(row.get("name") or ""),
            qualified_name=str(row.get("qualified_name") or ""),
            signature=str(signature) if signature is not None else None,
            return_type=str(return_type) if return_type is not None else None,
            file_path=str(row.get("file_path") or ""),
            start_line=start_line,
            start_column=int(row.get("start_column") or 0),
            end_line=int(row.get("end_line") or start_line),
            end_column=int(row.get("end_column") or 0),
            language=str(row.get("language") or ""),
            score=float(row.get("score") or 0.0),
        )

    def to_symbol_dict(self) -> dict[str, object]:
        """转换为 service 使用的稳定符号投影，避免 repository 泄漏 sqlite.Row。"""
        return {
            "id": self.id, "kind": self.kind, "name": self.name,
            "qualified_name": self.qualified_name, "signature": self.signature,
            "file_path": self.file_path, "language": self.language,
            "start_line": self.start_line, "start_column": self.start_column,
            "end_line": self.end_line, "end_column": self.end_column,
            "score": self.score,
        }

    def to_function_dict(self) -> FunctionRecord:
        return {
            "function_fqn": self.qualified_name,
            "function_signature": CodeGraphParamUtil.build_method_signature(
                self.name, self.signature, self.return_type
            ),
            "short_name": self.name,
            "file_path": self.file_path,
            "start_line": self.start_line,
            "start_column": self.start_column,
            "end_line": self.end_line,
            "end_column": self.end_column,
        }

    def to_class_dict(self) -> ClassRecord:
        return {
            "class_fqn": self.qualified_name,
            "short_name": self.name,
            "file_path": self.file_path,
            "start_line": self.start_line,
            "start_column": self.start_column,
            "end_line": self.end_line,
            "end_column": self.end_column,
        }

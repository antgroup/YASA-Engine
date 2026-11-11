from __future__ import annotations

from dataclasses import dataclass

from yasa_mcp.repository.query.codegraph.query_models import (
    InterfaceImplementationRecord,
    NodeRecord,
)
from yasa_mcp.util.codegraph_param_util import CodeGraphParamUtil


@dataclass(frozen=True)
class CodeGraphInterfaceImplementationRow:
    interface_id: str
    interface_name: str
    interface_fqn: str
    implementation_class_id: str
    implementation_class_name: str
    implementation_class_fqn: str
    implementation_method_id: str
    implementation_method_name: str
    implementation_method_fqn: str
    signature: str | None
    return_type: str | None
    language: str
    file_path: str
    start_line: int
    start_column: int
    end_line: int
    end_column: int
    implements_metadata: str
    implements_provenance: str
    implementation_class_file_path: str = ""
    implementation_class_start_line: int = 0
    implementation_class_start_column: int = 0
    implementation_class_end_line: int = 0
    implementation_class_end_column: int = 0
    implementation_class_language: str = ""

    @classmethod
    def from_mapping(cls, row: NodeRecord) -> "CodeGraphInterfaceImplementationRow":
        signature = row.get("signature")
        return_type = row.get("return_type")
        start_line = int(row.get("start_line") or 0)
        return cls(
            interface_id=str(row.get("interface_id") or ""),
            interface_name=str(row.get("interface_name") or ""),
            interface_fqn=str(row.get("interface_qualified_name") or ""),
            implementation_class_id=str(row.get("implementation_class_id") or ""),
            implementation_class_name=str(row.get("implementation_class_name") or ""),
            implementation_class_fqn=str(
                row.get("implementation_class_qualified_name") or ""
            ),
            implementation_method_id=str(row.get("implementation_method_id") or ""),
            implementation_method_name=str(
                row.get("implementation_method_name") or ""
            ),
            implementation_method_fqn=str(
                row.get("implementation_method_qualified_name") or ""
            ),
            signature=str(signature) if signature is not None else None,
            return_type=str(return_type) if return_type is not None else None,
            language=str(row.get("language") or ""),
            file_path=str(row.get("file_path") or ""),
            start_line=start_line,
            start_column=int(row.get("start_column") or 0),
            end_line=int(row.get("end_line") or start_line),
            end_column=int(row.get("end_column") or 0),
            implements_metadata=str(row.get("implements_metadata") or ""),
            implements_provenance=str(row.get("implements_provenance") or ""),
            implementation_class_file_path=str(row.get("implementation_class_file_path") or ""),
            implementation_class_start_line=int(row.get("implementation_class_start_line") or 0),
            implementation_class_start_column=int(row.get("implementation_class_start_column") or 0),
            implementation_class_end_line=int(row.get("implementation_class_end_line") or 0),
            implementation_class_end_column=int(row.get("implementation_class_end_column") or 0),
            implementation_class_language=str(row.get("implementation_class_language") or ""),
        )

    def to_record(self) -> InterfaceImplementationRecord:
        return {
            "interface_id": self.interface_id,
            "interface_name": self.interface_name,
            "interface_fqn": self.interface_fqn,
            "implementation_class_id": self.implementation_class_id,
            "implementation_class_name": self.implementation_class_name,
            "implementation_class_fqn": self.implementation_class_fqn,
            "implementation_method_id": self.implementation_method_id,
            "function_fqn": self.implementation_method_fqn,
            "function_signature": CodeGraphParamUtil.build_method_signature(
                self.implementation_method_name, self.signature, self.return_type
            ),
            "short_name": self.implementation_method_name,
            "language": self.language,
            "file_path": self.file_path,
            "start_line": self.start_line,
            "start_column": self.start_column,
            "end_line": self.end_line,
            "end_column": self.end_column,
            "implements_metadata": self.implements_metadata,
            "implements_provenance": self.implements_provenance,
            "implementation_class_file_path": self.implementation_class_file_path,
            "implementation_class_start_line": self.implementation_class_start_line,
            "implementation_class_start_column": self.implementation_class_start_column,
            "implementation_class_end_line": self.implementation_class_end_line,
            "implementation_class_end_column": self.implementation_class_end_column,
            "implementation_class_language": self.implementation_class_language,
        }

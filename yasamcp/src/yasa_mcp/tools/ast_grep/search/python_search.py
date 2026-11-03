"""Python-specific AST search implementation."""

import logging
from pathlib import Path

from yasa_mcp.tools.ast_grep.ast.ast_grep_module import (
    ClassInfo,
    FuncInfo,
    Location,
    MethodSummary,
)
from yasa_mcp.tools.ast_grep.ast.ast_parser import (
    find_child_by_kind,
    node_location,
    node_text,
    parse_file,
)
from yasa_mcp.tools.ast_grep.util.fqn_builder import build_python_fqn
from yasa_mcp.tools.ast_grep.search.rule_engine import RuleEngine
from yasa_mcp.tools.ast_grep.search.base import SearchBase

logger = logging.getLogger(__name__)


class PythonSearch(SearchBase):
    """Python language AST search using ast-grep-py."""

    def __init__(self, rule_engine: RuleEngine):
        super().__init__(rule_engine)

    @property
    def language(self) -> str:
        return "python"

    def extract_function_defs(
        self, file_path: Path, project_path: Path | None = None
    ) -> list[FuncInfo]:
        sg_root = parse_file(file_path, self.language)
        if sg_root is None:
            return []

        rule = self.rule_engine.get_rule("function_definition")
        root = sg_root.root()
        matches = root.find_all(config=rule)

        results: list[FuncInfo] = []
        for match in matches:
            fqn = self.build_fqn(match, file_path, project_path)
            sig = self.build_signature(match)
            loc = node_location(match, file_path)
            content = node_text(match)
            name = self._extract_func_name(match)
            annotations = self._extract_annotations(match)
            param_annotations = self._extract_parameter_annotations(match)

            results.append(
                FuncInfo(
                    name=name,
                    fqn=fqn,
                    signature=sig,
                    location=loc,
                    content=content,
                    annotations=annotations,
                    parameter_annotations=param_annotations,
                )
            )
        return results

    def extract_class_info(
        self, file_path: Path, class_name: str, project_path: Path | None = None
    ) -> ClassInfo | None:
        results = self.extract_all_class_info(file_path, class_name, project_path)
        return results[0] if results else None

    def extract_all_class_info(
        self, file_path: Path, class_name: str, project_path: Path | None = None
    ) -> list[ClassInfo]:
        """Extract all class definitions matching class_name from a file."""
        sg_root = parse_file(file_path, self.language)
        if sg_root is None:
            return []

        rule = self.rule_engine.get_rule("class_pattern", class_name=class_name)
        root = sg_root.root()
        matches = root.find_all(config=rule)

        results: list[ClassInfo] = []
        for match in matches:
            fqn = self.build_fqn(match, file_path, project_path)
            loc = node_location(match, file_path)
            content = node_text(match)
            methods = self._extract_class_methods(sg_root, class_name, file_path)

            results.append(ClassInfo(
                name=class_name,
                fqn=fqn,
                location=loc,
                content=content,
                methods=methods,
            ))
        return results

    def build_fqn(self, node, file_path: Path, project_path: Path | None = None) -> str:
        return build_python_fqn(
            node,
            str(file_path),
            str(project_path) if project_path else None,
        )

    def build_signature(self, node) -> str:
        """Build Python function signature (e.g., 'def foo(self, x: int) -> str')."""
        # For decorated_definition, find inner function_definition
        func_node = node
        if node.kind() == "decorated_definition":
            func_node = find_child_by_kind(node, "function_definition")
            if func_node is None:
                return node_text(node).split("\n")[0]

        # Build from parts: def name(params) -> return_type
        name_node = find_child_by_kind(func_node, "identifier")
        params_node = find_child_by_kind(func_node, "parameters")
        return_type_node = find_child_by_kind(func_node, "type")

        parts = ["def"]
        if name_node:
            parts.append(name_node.text())
        if params_node:
            parts[-1] += params_node.text()
        else:
            parts[-1] += "()"
        if return_type_node:
            parts.append("->")
            parts.append(return_type_node.text())

        return " ".join(parts)

    def _extract_func_name(self, node) -> str:
        """Extract function name from function/decorated node."""
        func_node = node
        if node.kind() == "decorated_definition":
            func_node = find_child_by_kind(node, "function_definition")
            if func_node is None:
                return ""
        name_node = find_child_by_kind(func_node, "identifier")
        return name_node.text() if name_node else ""

    def _extract_annotations(self, node) -> list[str]:
        """Extract decorator annotations from a decorated_definition."""
        if node.kind() != "decorated_definition":
            return []
        annotations = []
        for child in node.children():
            if child.kind() == "decorator":
                annotations.append(node_text(child))
        return annotations

    def _extract_parameter_annotations(self, node) -> list[dict[str, str]]:
        """Extract parameter type annotations from function parameters."""
        func_node = node
        if node.kind() == "decorated_definition":
            func_node = find_child_by_kind(node, "function_definition")
            if func_node is None:
                return []

        params_node = find_child_by_kind(func_node, "parameters")
        if params_node is None:
            return []

        result = []
        for child in params_node.children():
            if child.kind() == "typed_parameter":
                name_node = find_child_by_kind(child, "identifier")
                type_node = find_child_by_kind(child, "type")
                if name_node and type_node:
                    result.append({
                        "parameter_name": name_node.text(),
                        "annotation": type_node.text(),
                    })
        return result

    def _extract_class_methods(self, sg_root, class_name: str, file_path: Path) -> list[MethodSummary]:
        """Extract method summaries from a class."""
        if not self.rule_engine.has_rule("class_method_pattern"):
            return []

        rule = self.rule_engine.get_rule("class_method_pattern", class_name=class_name)
        root = sg_root.root()
        matches = root.find_all(config=rule)

        methods = []
        for match in matches:
            name = self._extract_func_name(match)
            sig = self.build_signature(match)
            loc = node_location(match, file_path)
            methods.append(MethodSummary(name=name, signature=sig, line=loc.start_line))

        return methods

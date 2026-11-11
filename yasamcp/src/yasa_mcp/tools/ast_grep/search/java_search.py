"""Java-specific AST search implementation."""

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
    find_children_by_kind,
    node_location,
    node_text,
    parse_file,
)
from yasa_mcp.tools.ast_grep.util.fqn_builder import build_java_fqn, find_java_package
from yasa_mcp.tools.ast_grep.search.rule_engine import RuleEngine
from yasa_mcp.tools.ast_grep.search.base import SearchBase

_SUPER_NAME_KINDS = frozenset({"superclass", "super_interfaces", "extends_interfaces"})

logger = logging.getLogger(__name__)


class JavaSearch(SearchBase):
    """Java language AST search using ast-grep-py."""

    def __init__(self, rule_engine: RuleEngine):
        super().__init__(rule_engine)

    @property
    def language(self) -> str:
        return "java"

    def extract_function_defs(
        self, file_path: Path, project_path: Path | None = None
    ) -> list[FuncInfo]:
        sg_root = parse_file(file_path, self.language)
        if sg_root is None:
            return []

        rule = self.rule_engine.get_rule("method")
        root = sg_root.root()
        matches = root.find_all(config=rule)

        package_name = find_java_package(root)

        results: list[FuncInfo] = []
        for match in matches:
            fqn = build_java_fqn(match, package_name)
            sig = self.build_signature(match)
            loc = node_location(match, file_path)
            content = node_text(match)
            name = self._extract_method_name(match)
            annotations = self._extract_annotations(match)

            results.append(
                FuncInfo(
                    name=name,
                    fqn=fqn,
                    signature=sig,
                    location=loc,
                    content=content,
                    annotations=annotations,
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
            package_name = find_java_package(root)
            fqn = build_java_fqn(match, package_name)
            loc = node_location(match, file_path)
            content = node_text(match)
            methods = self._extract_class_methods(sg_root, class_name, file_path)
            superclass_name, interface_names, is_abstract, is_interface = (
                self._extract_class_hierarchy_info(match)
            )

            results.append(ClassInfo(
                name=class_name,
                fqn=fqn,
                location=loc,
                content=content,
                methods=methods,
                superclass_name=superclass_name,
                interface_names=interface_names,
                is_abstract=is_abstract,
                is_interface=is_interface,
            ))
        return results

    def build_fqn(self, node, file_path: Path, project_path: Path | None = None) -> str:
        sg_root = parse_file(file_path, self.language)
        if sg_root is None:
            return ""
        package_name = find_java_package(sg_root.root())
        return build_java_fqn(node, package_name)

    def build_signature(self, node) -> str:
        """Build Java method signature.

        Example: 'public String getName(int id)'
        """
        kind = node.kind()
        if kind not in ("method_declaration", "constructor_declaration"):
            return node_text(node).split("\n")[0].split("{")[0].strip()

        parts: list[str] = []

        # Modifiers (public, static, etc.)
        modifiers = find_child_by_kind(node, "modifiers")
        if modifiers:
            parts.append(node_text(modifiers))

        # Return type (not present for constructors)
        if kind == "method_declaration":
            # In Java tree-sitter, type comes before the identifier
            for child in node.children():
                child_kind = child.kind()
                if child_kind == "identifier":
                    break
                if child_kind not in ("modifiers", "marker_annotation", "annotation"):
                    if child_kind != "{":
                        type_text = node_text(child)
                        if type_text and type_text not in ("public", "private", "protected", "static", "final", "abstract"):
                            parts.append(type_text)
                            break

        # Name
        name_node = find_child_by_kind(node, "identifier")
        if name_node:
            parts.append(name_node.text())

        # Parameters
        params_node = find_child_by_kind(node, "formal_parameters")
        if params_node:
            parts[-1] += node_text(params_node)
        else:
            parts[-1] += "()"

        return " ".join(parts)

    def _extract_method_name(self, node) -> str:
        """Extract method name from method_declaration or constructor_declaration."""
        name_node = find_child_by_kind(node, "identifier")
        return name_node.text() if name_node else ""

    def _extract_annotations(self, node) -> list[str]:
        """Extract Java annotations (e.g., @Override, @GetMapping)."""
        annotations = []
        modifiers = find_child_by_kind(node, "modifiers")
        if modifiers:
            for child in modifiers.children():
                if child.kind() in ("marker_annotation", "annotation"):
                    annotations.append(node_text(child))
        return annotations

    def _extract_class_methods(self, sg_root, class_name: str, file_path: Path) -> list[MethodSummary]:
        """Extract method summaries from a Java class."""
        if not self.rule_engine.has_rule("class_method_pattern"):
            return []

        rule = self.rule_engine.get_rule("class_method_pattern", class_name=class_name)
        root = sg_root.root()
        matches = root.find_all(config=rule)

        methods = []
        for match in matches:
            name = self._extract_method_name(match)
            sig = self.build_signature(match)
            loc = node_location(match, file_path)
            methods.append(MethodSummary(name=name, signature=sig, line=loc.start_line))

        return methods

    @staticmethod
    def _extract_class_hierarchy_info(
        class_node,
    ) -> tuple[str | None, list[str], bool, bool]:
        """Extract inheritance metadata from a class/interface AST node.

        Returns (superclass_name, interface_names, is_abstract, is_interface).
        """
        is_interface = class_node.kind() == "interface_declaration"

        is_abstract = False
        superclass_name: str | None = None
        interface_names: list[str] = []

        for child in class_node.children():
            kind = child.kind()

            if kind == "modifiers":
                for mod in child.children():
                    if mod.text() == "abstract":
                        is_abstract = True

            elif kind == "superclass":
                for sub in child.children():
                    if sub.kind() == "type_identifier":
                        superclass_name = sub.text()
                        break
                    if sub.kind() == "generic_type":
                        tid = find_child_by_kind(sub, "type_identifier")
                        if tid:
                            superclass_name = tid.text()
                        break

            elif kind in ("super_interfaces", "extends_interfaces"):
                for sub in child.children():
                    if sub.kind() == "type_list":
                        for t in sub.children():
                            if t.kind() == "type_identifier":
                                interface_names.append(t.text())
                            elif t.kind() == "generic_type":
                                tid = find_child_by_kind(t, "type_identifier")
                                if tid:
                                    interface_names.append(tid.text())
                    elif sub.kind() == "type_identifier":
                        interface_names.append(sub.text())
                    elif sub.kind() == "generic_type":
                        tid = find_child_by_kind(sub, "type_identifier")
                        if tid:
                            interface_names.append(tid.text())

        return superclass_name, interface_names, is_abstract, is_interface

    def find_subclasses(
        self, file_path: Path, parent_class_name: str, project_path: Path | None = None
    ) -> list[ClassInfo]:
        """Find subclasses/implementors of parent_class_name in a single file.

        Uses the class_extend_class rule to match class/interface declarations
        that extend or implement the given parent class name.
        """
        if not self.rule_engine.has_rule("class_extend_class"):
            return []

        sg_root = parse_file(file_path, self.language)
        if sg_root is None:
            return []

        rule = self.rule_engine.get_rule("class_extend_class", class_name=parent_class_name)
        root = sg_root.root()
        matches = root.find_all(config=rule)
        package_name = find_java_package(root)

        results: list[ClassInfo] = []
        for match in matches:
            name_node = find_child_by_kind(match, "identifier")
            if not name_node:
                continue
            cls_name = name_node.text()
            fqn = build_java_fqn(match, package_name)
            loc = node_location(match, file_path)
            content = node_text(match)
            superclass_name, interface_names, is_abstract, is_interface = (
                self._extract_class_hierarchy_info(match)
            )

            results.append(ClassInfo(
                name=cls_name,
                fqn=fqn,
                location=loc,
                content=content,
                superclass_name=superclass_name,
                interface_names=interface_names,
                is_abstract=is_abstract,
                is_interface=is_interface,
            ))
        return results

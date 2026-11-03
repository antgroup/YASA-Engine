"""JavaScript 与 TypeScript AST 检索实现。"""

import re
from pathlib import Path

from yasa_mcp.tools.ast_grep.ast.ast_grep_module import ClassInfo, FuncInfo, MethodSummary
from yasa_mcp.tools.ast_grep.ast.ast_parser import find_child_by_kind, node_location, node_text, parse_file
from yasa_mcp.tools.ast_grep.search.base import SearchBase
from yasa_mcp.tools.ast_grep.util.fqn_builder import build_javascript_fqn

_FUNCTION_KINDS = {"function_declaration", "function_expression", "arrow_function", "method_definition"}
_CLASS_KINDS = {"class", "class_declaration", "interface_declaration"}
_BODY_KINDS = {"statement_block", "class_body"}


class JavaScriptSearch(SearchBase):
    """使用 ast-grep 提取具名 JavaScript/TypeScript 定义。"""

    @property
    def language(self) -> str:
        return "javascript"

    def parser_language(self, file_path: Path) -> str:
        """仅 .ts 文件使用 TypeScript grammar；JSX/TSX 在上游后缀过滤中排除。"""
        return "typescript" if file_path.suffix == ".ts" else self.language

    def extract_function_defs(
        self, file_path: Path, project_path: Path | None = None
    ) -> list[FuncInfo]:
        root = self._parse_root(file_path)
        if root is None:
            return []

        rule = self.rule_engine.get_rule("function_definition")
        matches = root.find_all(config=rule)

        results: list[FuncInfo] = []
        seen: set[tuple[str, int, int, str]] = set()
        for node in matches:
            if not self._is_addressable_function(node):
                continue
            name = self._function_name(node)
            if not name:
                continue

            loc = node_location(node, file_path)
            key = (str(loc.file_path), loc.start_line, loc.start_column, name)
            if key in seen:
                continue
            seen.add(key)

            results.append(FuncInfo(
                name=name,
                fqn=self.build_fqn(node, file_path, project_path),
                signature=self.build_signature(node),
                location=loc,
                content=node_text(node),
            ))

        results.sort(key=lambda fn: (str(fn.location.file_path), fn.location.start_line, fn.location.start_column, fn.name))
        return results

    def find_functions_by_name(
        self, file_path: Path, func_name: str, project_path: Path | None = None
    ) -> list[FuncInfo]:
        return [
            func for func in self.extract_function_defs(file_path, project_path)
            if func.name == func_name
        ]

    def extract_class_info(
        self, file_path: Path, class_name: str, project_path: Path | None = None
    ) -> ClassInfo | None:
        results = self.extract_all_class_info(file_path, class_name, project_path)
        return results[0] if results else None

    def extract_all_class_info(
        self, file_path: Path, class_name: str, project_path: Path | None = None
    ) -> list[ClassInfo]:
        root = self._parse_root(file_path)
        if root is None:
            return []

        rule = self.rule_engine.get_rule("class_pattern")
        matches = list(root.find_all(config=rule))
        if self.parser_language(file_path) == "typescript":
            matches.extend(root.find_all(config={"rule": {"kind": "interface_declaration"}}))
        matches.extend(root.find_all(config={"rule": {"kind": "class"}}))

        results: list[ClassInfo] = []
        seen: set[tuple[str, int, int, str]] = set()
        for node in matches:
            name = self._class_name(node)
            if name != class_name:
                continue
            loc = node_location(node, file_path)
            key = (str(loc.file_path), loc.start_line, loc.start_column, name)
            if key in seen:
                continue
            seen.add(key)
            superclass_name, interface_names, is_interface = self._class_hierarchy(node)
            results.append(ClassInfo(
                name=name,
                fqn=self.build_fqn(node, file_path, project_path),
                location=loc,
                content=node_text(node),
                methods=self._class_methods(node, file_path),
                superclass_name=superclass_name,
                interface_names=interface_names,
                is_interface=is_interface,
            ))

        results.sort(key=lambda cls: (str(cls.location.file_path), cls.location.start_line, cls.fqn))
        return results

    def build_fqn(self, node, file_path: Path, project_path: Path | None = None) -> str:
        return build_javascript_fqn(
            node, str(file_path), str(project_path) if project_path else None,
        )

    def build_signature(self, node) -> str:
        """构建稳定的 UQL 风格 JavaScript/TypeScript 函数签名。"""
        name = self._function_name(node)
        params = self._params_text(node)
        return f"{name}{params}"

    def _parse_root(self, file_path: Path):
        parsed = parse_file(file_path, self.parser_language(file_path))
        return parsed.root() if parsed is not None else None

    def _is_addressable_function(self, node) -> bool:
        kind = node.kind()
        if kind == "method_definition":
            return self._has_body(node)
        if kind == "function_declaration":
            return self._direct_name(node) != "" and self._has_body(node)
        if kind in ("arrow_function", "function_expression"):
            return (self._direct_name(node) or self._binding_name(node)) != "" and self._has_body(node)
        return False

    def _has_body(self, node) -> bool:
        if node.kind() == "arrow_function":
            # 表达式体箭头函数也是有效函数定义。
            return True
        return any(child.kind() in _BODY_KINDS for child in node.children())

    def _function_name(self, node) -> str:
        kind = node.kind()
        if kind == "function_declaration":
            return self._direct_name(node)
        if kind == "method_definition":
            return self._direct_name(node, "property_identifier", "identifier", "private_property_identifier")
        if kind in ("arrow_function", "function_expression"):
            return self._direct_name(node) or self._binding_name(node)
        return ""

    def _class_name(self, node) -> str:
        name = self._direct_name(node, "identifier", "type_identifier")
        if name:
            return name
        parent = node.parent()
        if parent and parent.kind() == "assignment_expression":
            return self._assignment_left_name(parent)
        if parent and parent.kind() == "field_definition":
            return self._direct_name(parent, "property_identifier", "identifier")
        return ""

    @staticmethod
    def _direct_name(node, *kinds: str) -> str:
        if not kinds:
            kinds = ("identifier", "type_identifier")
        for child in node.children():
            if child.kind() in kinds:
                return child.text()
        return ""

    def _binding_name(self, node) -> str:
        parent = node.parent()
        if parent is None:
            return ""
        if parent.kind() in ("variable_declarator", "assignment_expression"):
            return self._assignment_left_name(parent)
        return ""

    @staticmethod
    def _assignment_left_name(node) -> str:
        for child in node.children():
            kind = child.kind()
            if kind in ("identifier", "property_identifier"):
                return child.text()
            if kind == "member_expression":
                names = [
                    grand.text()
                    for grand in child.children()
                    if grand.kind() in ("identifier", "property_identifier")
                ]
                if names:
                    return names[-1]
        return ""

    def _params_text(self, node) -> str:
        params = find_child_by_kind(node, "formal_parameters")
        if params is None and node.kind() == "arrow_function":
            # 单参数箭头函数：`value => value`。
            for child in node.children():
                if child.kind() in ("identifier", "required_parameter"):
                    return f"({self._normalize_param_text(child.text())})"
        if params is None:
            return "()"
        return self._normalize_params(params.text())

    def _return_type_text(self, node) -> str:
        type_node = find_child_by_kind(node, "type_annotation")
        if type_node is None:
            return ""
        text = type_node.text().strip()
        if not text:
            return ""
        return text if text.startswith(":") else f": {text}"

    def _normalize_params(self, params_text: str) -> str:
        if not params_text.startswith("(") or not params_text.endswith(")"):
            return params_text
        inner = params_text[1:-1].strip()
        if not inner:
            return "()"
        params = [self._normalize_param_text(part) for part in self._split_top_level_commas(inner)]
        return "(" + ", ".join(p for p in params if p) + ")"

    @staticmethod
    def _normalize_param_text(text: str) -> str:
        text = " ".join(text.strip().split())
        # 去掉 TypeScript/JS 参数装饰器（如 `@HTTPParam()`）；它们是注解，
        # 不属于 UQL 风格函数签名。
        text = re.sub(r"^(?:@\w+(?:\([^)]*\))?\s*)+", "", text)
        text = re.sub(r"\s*:\s*", ": ", text)
        text = re.sub(r"\s*=\s*", " = ", text)
        text = text.replace(" | ", "|")
        return text

    @staticmethod
    def _split_top_level_commas(text: str) -> list[str]:
        parts: list[str] = []
        buf: list[str] = []
        depth = 0
        pairs = {"(": ")", "[": "]", "{": "}", "<": ">"}
        closing = set(pairs.values())
        for ch in text:
            if ch in pairs:
                depth += 1
            elif ch in closing and depth > 0:
                depth -= 1
            if ch == "," and depth == 0:
                parts.append("".join(buf).strip())
                buf = []
            else:
                buf.append(ch)
        if buf:
            parts.append("".join(buf).strip())
        return parts

    def _class_methods(self, class_node, file_path: Path) -> list[MethodSummary]:
        body = find_child_by_kind(class_node, "class_body") or find_child_by_kind(class_node, "object_type")
        if body is None:
            return []
        methods: list[MethodSummary] = []
        for child in body.children():
            if child.kind() != "method_definition" or not self._has_body(child):
                continue
            name = self._function_name(child)
            if name:
                methods.append(MethodSummary(
                    name=name,
                    signature=self.build_signature(child),
                    line=node_location(child, file_path).start_line,
                ))
        methods.sort(key=lambda m: m.line)
        return methods

    def _class_hierarchy(self, class_node) -> tuple[str | None, list[str], bool]:
        superclass_name: str | None = None
        interface_names: list[str] = []
        is_interface = class_node.kind() == "interface_declaration"

        heritage = find_child_by_kind(class_node, "class_heritage")
        if heritage is None:
            return superclass_name, interface_names, is_interface

        for child in heritage.children():
            kind = child.kind()
            if kind == "extends_clause":
                name = self._first_type_name(child)
                if name:
                    superclass_name = name
            elif kind == "implements_clause":
                interface_names.extend(self._all_type_names(child))
        return superclass_name, interface_names, is_interface

    @staticmethod
    def _first_type_name(node) -> str:
        names = JavaScriptSearch._all_type_names(node)
        return names[0] if names else ""

    @staticmethod
    def _all_type_names(node) -> list[str]:
        names: list[str] = []
        for child in node.children():
            if child.kind() in ("identifier", "type_identifier"):
                names.append(child.text())
            elif child.kind() in ("generic_type", "nested_type_identifier"):
                for grand in child.children():
                    if grand.kind() in ("identifier", "type_identifier"):
                        names.append(grand.text())
                        break
        return names

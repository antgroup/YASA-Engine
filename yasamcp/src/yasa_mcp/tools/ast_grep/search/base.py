"""Abstract base class for language-specific AST search."""

from abc import ABC, abstractmethod
from pathlib import Path

from ast_grep_py import SgRoot

from yasa_mcp.tools.ast_grep.ast.ast_grep_module import (
    ClassInfo,
    FuncInfo,
    Location,
    MethodSummary,
)
from yasa_mcp.tools.ast_grep.ast.ast_parser import node_location, node_text, parse_file
from yasa_mcp.tools.ast_grep.search.rule_engine import RuleEngine


class SearchBase(ABC):
    """Abstract base for language-specific AST search operations.

    Subclasses must implement:
    - language property
    - extract_function_defs: extract all function definitions from a file
    - extract_class_info: extract class definition with methods
    - build_fqn: construct FQN for a matched node
    - build_signature: construct function signature string
    """

    def __init__(self, rule_engine: RuleEngine):
        self.rule_engine = rule_engine

    @property
    @abstractmethod
    def language(self) -> str:
        """ast-grep language identifier (e.g., 'python', 'java')."""
        ...

    @abstractmethod
    def extract_function_defs(
        self, file_path: Path, project_path: Path | None = None
    ) -> list[FuncInfo]:
        """Extract all function definitions from a file.

        Args:
            file_path: Source file to parse
            project_path: Project root for FQN construction

        Returns:
            List of FuncInfo for each function/method in the file
        """
        ...

    @abstractmethod
    def extract_class_info(
        self, file_path: Path, class_name: str, project_path: Path | None = None
    ) -> ClassInfo | None:
        """Extract class definition information.

        Args:
            file_path: Source file to parse
            class_name: Target class name
            project_path: Project root for FQN construction

        Returns:
            ClassInfo or None if class not found
        """
        ...

    @abstractmethod
    def build_fqn(self, node, file_path: Path, project_path: Path | None = None) -> str:
        """Build fully qualified name for a matched node.

        Args:
            node: Matched SgNode
            file_path: Source file path
            project_path: Project root

        Returns:
            FQN string
        """
        ...

    @abstractmethod
    def build_signature(self, node) -> str:
        """Build function signature string from AST node.

        Args:
            node: Function/method SgNode

        Returns:
            Signature string (e.g., "def foo(self, x: int) -> str")
        """
        ...

    # ---- Common methods (shared across languages) ----

    def find_functions_by_name(
        self, file_path: Path, func_name: str, project_path: Path | None = None
    ) -> list[FuncInfo]:
        """Find functions matching a name in a file.

        Args:
            file_path: Source file to search
            func_name: Function name to match
            project_path: Project root for FQN construction

        Returns:
            List of matching FuncInfo
        """
        sg_root = parse_file(file_path, self.language)
        if sg_root is None:
            return []

        rule = self.rule_engine.get_rule("method_pattern", method_name=func_name)
        root = sg_root.root()
        matches = root.find_all(config=rule)

        results: list[FuncInfo] = []
        for match in matches:
            fqn = self.build_fqn(match, file_path, project_path)
            sig = self.build_signature(match)
            loc = node_location(match, file_path)
            content = node_text(match)
            results.append(
                FuncInfo(
                    name=func_name,
                    fqn=fqn,
                    signature=sig,
                    location=loc,
                    content=content,
                )
            )
        return results

    def find_class_by_name(
        self, file_path: Path, class_name: str, project_path: Path | None = None
    ) -> ClassInfo | None:
        """Find a class by name in a file.

        Args:
            file_path: Source file to search
            class_name: Class name to match
            project_path: Project root for FQN construction

        Returns:
            ClassInfo or None
        """
        return self.extract_class_info(file_path, class_name, project_path)

    def find_all_classes_by_name(
        self, file_path: Path, class_name: str, project_path: Path | None = None
    ) -> list[ClassInfo]:
        """Find all classes matching a name in a file.

        Args:
            file_path: Source file to search
            class_name: Class name to match
            project_path: Project root for FQN construction

        Returns:
            List of ClassInfo
        """
        if hasattr(self, 'extract_all_class_info'):
            return self.extract_all_class_info(file_path, class_name, project_path)
        # Fallback for subclasses that don't implement extract_all_class_info
        result = self.extract_class_info(file_path, class_name, project_path)
        return [result] if result else []

    def find_functions_by_code_snippet(
        self, file_path: Path, snippet: str, project_path: Path | None = None
    ) -> list[FuncInfo]:
        """Find functions containing a code snippet.

        Extracts all function defs and checks if snippet is in their content.

        Args:
            file_path: Source file to search
            snippet: Code snippet to match
            project_path: Project root for FQN construction

        Returns:
            List of FuncInfo whose content contains the snippet
        """
        all_funcs = self.extract_function_defs(file_path, project_path)
        return [f for f in all_funcs if snippet in f.content]

    def find_subclasses(
        self, file_path: Path, parent_class_name: str, project_path: Path | None = None
    ) -> list[ClassInfo]:
        """Find subclasses/implementors of a parent class in a file.

        Default implementation returns empty list. Language-specific
        subclasses (e.g. JavaSearch) override this with AST-based matching.
        """
        return []

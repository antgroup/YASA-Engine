"""AstSearchClient — language-aware dispatcher for AST search operations.

Routes search requests to the appropriate language-specific SearchBase implementation.
"""

import logging
from pathlib import Path

from yasa_mcp.tools.ast_grep.ast.ast_grep_module import ClassInfo, FuncInfo
from yasa_mcp.tools.ast_grep.search.rule_engine import RuleEngine
from yasa_mcp.tools.ast_grep.search.base import SearchBase
from yasa_mcp.tools.ast_grep.search.java_search import JavaSearch
from yasa_mcp.tools.ast_grep.search.javascript_search import JavaScriptSearch
from yasa_mcp.tools.ast_grep.search.python_search import PythonSearch

logger = logging.getLogger(__name__)

# Module-level path to rules directory
_RULES_DIR = Path(__file__).parent.parent / "rules"


class AstSearchClient:
    """Dispatches AST search operations to language-specific implementations.

    Usage:
        client = AstSearchClient()
        funcs = client.extract_function_defs("python", file_path, project_path)
        cls = client.find_class_by_name("java", file_path, "MyService", project_path)
    """

    def __init__(self, rules_dir: Path | None = None):
        """Initialize with language-specific rule engines and search instances.

        Args:
            rules_dir: Override path to rules/ directory. Defaults to module's rules/ dir.
        """
        base_rules_dir = rules_dir or _RULES_DIR

        # Create per-language rule engines and search instances
        self._search_map: dict[str, SearchBase] = {}
        self._init_language("python", base_rules_dir / "python", PythonSearch)
        self._init_language("java", base_rules_dir / "java", JavaSearch)
        self._init_language("javascript", base_rules_dir / "javascript", JavaScriptSearch)

    def _init_language(self, language: str, rules_path: Path, search_cls: type) -> None:
        """Initialize a language search instance."""
        engine = RuleEngine(rules_path)
        self._search_map[language] = search_cls(engine)

    def get_search(self, language: str) -> SearchBase | None:
        """Get the SearchBase instance for a language.

        Args:
            language: Language identifier ("python", "java")

        Returns:
            SearchBase instance or None if language not supported
        """
        return self._search_map.get(language)

    @property
    def supported_languages(self) -> list[str]:
        """List of supported language identifiers."""
        return list(self._search_map.keys())

    # ---- Dispatched operations ----

    def extract_function_defs(
        self, language: str, file_path: Path, project_path: Path | None = None
    ) -> list[FuncInfo]:
        """Extract all function definitions from a file.

        Args:
            language: Language identifier
            file_path: Source file path
            project_path: Project root for FQN construction

        Returns:
            List of FuncInfo, empty if language not supported
        """
        search = self.get_search(language)
        if search is None:
            logger.warning(f"Unsupported language for ast-grep search: {language}")
            return []
        return search.extract_function_defs(file_path, project_path)

    def find_functions_by_name(
        self, language: str, file_path: Path, func_name: str, project_path: Path | None = None
    ) -> list[FuncInfo]:
        """Find functions matching a name in a file.

        Args:
            language: Language identifier
            file_path: Source file path
            func_name: Function name to match
            project_path: Project root for FQN construction

        Returns:
            List of matching FuncInfo
        """
        search = self.get_search(language)
        if search is None:
            return []
        return search.find_functions_by_name(file_path, func_name, project_path)

    def find_class_by_name(
        self, language: str, file_path: Path, class_name: str, project_path: Path | None = None
    ) -> ClassInfo | None:
        """Find a class by name in a file.

        Args:
            language: Language identifier
            file_path: Source file path
            class_name: Class name to match
            project_path: Project root for FQN construction

        Returns:
            ClassInfo or None
        """
        search = self.get_search(language)
        if search is None:
            return None
        return search.find_class_by_name(file_path, class_name, project_path)

    def find_all_classes_by_name(
        self, language: str, file_path: Path, class_name: str, project_path: Path | None = None
    ) -> list[ClassInfo]:
        """Find all classes matching a name in a file.

        Args:
            language: Language identifier
            file_path: Source file path
            class_name: Class name to match
            project_path: Project root for FQN construction

        Returns:
            List of ClassInfo
        """
        search = self.get_search(language)
        if search is None:
            return []
        return search.find_all_classes_by_name(file_path, class_name, project_path)

    def find_functions_by_code_snippet(
        self, language: str, file_path: Path, snippet: str, project_path: Path | None = None
    ) -> list[FuncInfo]:
        """Find functions containing a code snippet.

        Args:
            language: Language identifier
            file_path: Source file path
            snippet: Code snippet to search for
            project_path: Project root for FQN construction

        Returns:
            List of matching FuncInfo
        """
        search = self.get_search(language)
        if search is None:
            return []
        return search.find_functions_by_code_snippet(file_path, snippet, project_path)

    def find_subclasses(
        self, language: str, file_path: Path, parent_class_name: str, project_path: Path | None = None
    ) -> list[ClassInfo]:
        """Find subclasses/implementors of a parent class in a file.

        Args:
            language: Language identifier
            file_path: Source file path
            parent_class_name: Parent class name to search for
            project_path: Project root for FQN construction

        Returns:
            List of ClassInfo for matching subclasses
        """
        search = self.get_search(language)
        if search is None:
            return []
        return search.find_subclasses(file_path, parent_class_name, project_path)

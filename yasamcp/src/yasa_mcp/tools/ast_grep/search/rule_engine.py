"""YAML rule engine for ast-grep pattern matching.

Loads YAML rule templates from disk and supports parameter substitution
for dynamic pattern generation.
"""

import json
import logging
from pathlib import Path

import yaml

logger = logging.getLogger(__name__)


class RuleEngine:
    """Loads ast-grep YAML rules and provides parameterized rule generation.

    Rules are stored as JSON string templates. Parameters like {method_name}
    are substituted at query time via get_rule().
    """

    def __init__(self, rules_dir: Path):
        self._templates: dict[str, str] = {}
        self._load_rules(rules_dir)

    def _load_rules(self, rules_dir: Path) -> None:
        """Load all .yml files from the rules directory."""
        if not rules_dir.exists():
            logger.warning(f"Rules directory not found: {rules_dir}")
            return

        for yml_file in sorted(rules_dir.glob("*.yml")):
            try:
                with open(yml_file, "rb") as f:
                    data = yaml.safe_load(f)
                if not data or "name" not in data or "rule" not in data:
                    logger.warning(f"Skipping invalid rule file: {yml_file}")
                    continue
                # Store rule wrapped in {"rule": ...} for ast-grep-py config format
                self._templates[data["name"]] = json.dumps(
                    {"rule": data["rule"]}, ensure_ascii=False
                )
            except Exception as e:
                logger.warning(f"Failed to load rule {yml_file}: {e}")

    def get_rule(self, name: str, **params: str) -> dict:
        """Get a rule by name with parameter substitution.

        Args:
            name: Rule template name (e.g., "method_pattern")
            **params: Parameters to substitute (e.g., method_name="foo")

        Returns:
            Dictionary suitable for ast-grep-py SgRoot.find(rule=...)

        Raises:
            KeyError: If rule name not found
        """
        if name not in self._templates:
            raise KeyError(f"Rule not found: {name}. Available: {list(self._templates.keys())}")

        template = self._templates[name]
        for key, value in params.items():
            template = template.replace(f"{{{key}}}", value)
        return json.loads(template)

    def has_rule(self, name: str) -> bool:
        """Check if a rule template exists."""
        return name in self._templates

    @property
    def rule_names(self) -> list[str]:
        """List all available rule names."""
        return list(self._templates.keys())

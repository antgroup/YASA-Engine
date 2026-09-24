from enum import Enum

from yasa_mcp.core import exceptions

# 语言别名映射：支持多种名称识别同一语言（key 统一小写）
_LANGUAGE_ALIASES: dict[str, str] = {
    "go": "golang",
    "js": "javascript",
}


class Language(str, Enum):
    JAVA = "java"
    PYTHON = "python"
    GO = "golang"
    JAVASCRIPT = "javascript"
    PHP = "php"

    @classmethod
    def try_parse(cls, value: str) -> "Language | None":
        """尝试将字符串解析为 Language，忽略大小写，支持别名。解析失败返回 None。"""
        normalized = value.strip().lower()
        normalized = _LANGUAGE_ALIASES.get(normalized, normalized)
        try:
            return cls(normalized)
        except ValueError:
            return None

    @classmethod
    def from_string(cls, value: str) -> "Language":
        result = cls.try_parse(value)
        if result is None:
            raise exceptions.LanguageNotSupportedError(f"暂不支持语言: {value}")
        return result


class CallgraphAlgorithm(str, Enum):
    CHA = "CHA"
    DEFAULT = "DEFAULT"  # 默认即为模拟执行方式


class Mode(str, Enum):
    FULL = "full"  # 全量模式
    INCREMENTAL = "incremental"  # 增量模式


class Tool(str, Enum):
    """当前支持的工具"""
    YASA = "yasa"
    CODEGRAPH = "codegraph"
    RIPGREP = "ripgrep"
    AST_GREP = "ast_grep"
    SCC = "scc"

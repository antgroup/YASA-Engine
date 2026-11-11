from pathlib import Path
from pydantic import BaseModel
from yasa_mcp.core.enums import Language
from yasa_mcp.core import exceptions
from functools import cached_property
from yasa_mcp.util.path_util import validate_path


class YasaBinaryLayout(BaseModel):
    root_path: Path

    @cached_property
    def yasa_bin(self) -> Path:
        return validate_path(self.root_path / "yasa")

    @cached_property
    def uast_bins(self) -> dict[str, Path]:
        return {
            Language.GO: validate_path(self.root_path / "deps" / "uast4go"),
            Language.PYTHON: validate_path(self.root_path / "deps" / "uast4py")
        }

    def get_uast_bin(self, language: Language):
        if language not in self.uast_bins:
            raise exceptions.FileNotFoundError(f"UAST binary for {language} is not found")
        return self.uast_bins[language]

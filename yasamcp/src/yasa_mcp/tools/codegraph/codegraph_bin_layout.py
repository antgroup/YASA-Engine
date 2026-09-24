from functools import cached_property
from pathlib import Path

from pydantic import BaseModel

from yasa_mcp.util.path_util import validate_path


class CodeGraphBinaryLayout(BaseModel):
    root_path: Path

    @cached_property
    def codegraph_bin(self) -> Path:
        return validate_path(self.root_path / "bin" / "codegraph")

from pydantic import BaseModel
from pathlib import Path
from functools import cached_property
from yasa_mcp.util.path_util import validate_path


class SccBinaryLayout(BaseModel):
    root_path: Path

    @cached_property
    def scc_bin(self) -> Path:
        return validate_path(self.root_path / "scc")

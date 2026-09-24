from pydantic import BaseModel
import os

from yasa_mcp.core import exceptions
from pathlib import Path


class FileLineResult(BaseModel):
    file_path: Path
    line: int
    content: str = ""

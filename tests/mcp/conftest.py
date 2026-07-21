"""
测试 fixtures 和 path 配置
"""

import sys
import os
import tempfile

import pytest

# 确保项目根目录在 sys.path 中
_project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if _project_root not in sys.path:
    sys.path.insert(0, _project_root)


@pytest.fixture
def temp_repo_root():
    """创建一个临时目录作为 YASA_MCP_REPO_ROOT"""
    with tempfile.TemporaryDirectory() as tmpdir:
        old_env = os.environ.get("YASA_MCP_REPO_ROOT")
        os.environ["YASA_MCP_REPO_ROOT"] = tmpdir
        yield tmpdir
        if old_env is not None:
            os.environ["YASA_MCP_REPO_ROOT"] = old_env
        else:
            os.environ.pop("YASA_MCP_REPO_ROOT", None)

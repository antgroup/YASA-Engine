# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec for yasa-mcp CLI (mac arm64, onedir)
# 仅打包 Python 侧，native binary 由 -b/--bin 外部指定

import os
import sys
from pathlib import Path

# spec 在 script/ 下，repo root 是 parent
REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(SPEC), '..'))
SRC_DIR = os.path.join(REPO_ROOT, 'src')

block_cipher = None

# 收集 fastmcp 及其依赖的 package metadata，避免运行时 importlib.metadata.version 失败
from PyInstaller.utils.hooks import copy_metadata
import glob as _glob
_metadata = copy_metadata('fastmcp')
for _p in ('anyio', 'pydantic', 'pydantic_core', 'starlette', 'sse-starlette', 'httpx', 'click'):
    try:
        _metadata += copy_metadata(_p)
    except Exception:
        pass

# 收集 repository 下的 SQL mapper 文件，保证打包后在 __file__ 相对路径下可加载
_sql_dir = os.path.join(SRC_DIR, 'yasa_mcp', 'repository', 'mapper', 'codegraph')
for _f in _glob.glob(os.path.join(_sql_dir, '*.sql')):
    _rel = os.path.relpath(_f, os.path.join(SRC_DIR, 'yasa_mcp'))
    _metadata.append((os.path.normpath(_f), os.path.join('yasa_mcp', os.path.dirname(_rel))))

a = Analysis(
    [os.path.join(SRC_DIR, 'yasa_mcp', 'bin', 'yasa_client.py')],
    pathex=[SRC_DIR],
    binaries=[],
    datas=_metadata,
    hiddenimports=[
        'duckdb',
        'pyarrow',
        'ast_grep_py',
        'fastmcp',
        'click',
        'pydantic',
        'orjson',
        'anyio',
        'anyio._backends._asyncio',
        'yasa_mcp',
        'yasa_mcp.bin',
        'yasa_mcp.bin.yasa_client',
        'yasa_mcp.bin.formatter',
        'yasa_mcp.server',
        'yasa_mcp.service',
        'yasa_mcp.repository',
        'yasa_mcp.core',
        'yasa_mcp.layout',
        'yasa_mcp.config',
        'yasa_mcp.tools',
        'yasa_mcp.util',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        # ── yasamcp 不使用的数据科学/可视化大库(pandas/matplotlib 传递依赖) ──
        'numpy',
        'pandas',
        'matplotlib',
        'seaborn',
        'contourpy',
        'kiwisolver',
        'PIL',
        'Pillow',
        # ── pandas/pyarrow 可选大数据依赖 ──
        'scipy',
        'numba',
        'numexpr',
        'bottleneck',
        'xarray',
        'fsspec',
        's3fs',
        'gcsfs',
        # ── 测试/调试/Notebook ──
        'pytest',
        'IPython',
        'ipykernel',
        'notebook',
        'jupyter',
    ],
    noarchive=False,
    optimize=0,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='yasamcp',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch='arm64',
    contents_directory='lib',
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='yasamcp',
)

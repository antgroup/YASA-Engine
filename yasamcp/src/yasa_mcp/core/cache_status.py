"""项目缓存检查结果与运行时 readiness 状态。"""

from enum import Enum, IntFlag


class CacheStatus(Enum):
    """磁盘缓存检查结果；数值保持现有 server/service 契约。"""

    NO_UPDATE = 0
    INCREMENTAL_UPDATE = 1
    FULL_UPDATE = 2
    CACHE_L1_OK = 101
    CACHE_L2_OK = 102
    CACHE_L3_OK = 103


class CacheStatusMask(IntFlag):
    """Bitmask for cache readiness state.

    Runtime states:
        NONE = 0b000  — no project loaded
        REPO = 0b001  — repo cloned, ast-grep + ripgrep available
        LIGHT = 0b011 — lightweight cache ready (REPO | LIGHT)
        ALL = 0b111   — full DuckDB cache ready (REPO | LIGHT | ALL)
    """

    NONE = 0b000
    REPO = 0b001
    LIGHT = 0b011
    ALL = 0b111

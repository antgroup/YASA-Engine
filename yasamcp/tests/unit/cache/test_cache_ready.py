"""Unit tests for CacheStatusMask and YasaMcpContext cache state management."""

import pytest

from yasa_mcp.core.cache_status import CacheStatusMask
from yasa_mcp.core.context import YasaMcpContext


# ============================================================================
# CacheStatusMask enum tests
# ============================================================================


class TestCacheStatusMaskValues:
    """Verify CacheStatusMask bitmask values and relationships."""

    def test_none_is_zero(self):
        assert CacheStatusMask.NONE == 0

    def test_repo_value(self):
        assert CacheStatusMask.REPO == 0b001

    def test_light_value(self):
        assert CacheStatusMask.LIGHT == 0b011

    def test_all_value(self):
        assert CacheStatusMask.ALL == 0b111

    def test_repo_is_subset_of_light(self):
        assert CacheStatusMask.LIGHT & CacheStatusMask.REPO == CacheStatusMask.REPO

    def test_light_is_subset_of_all(self):
        assert CacheStatusMask.ALL & CacheStatusMask.LIGHT == CacheStatusMask.LIGHT

    def test_repo_is_subset_of_all(self):
        assert CacheStatusMask.ALL & CacheStatusMask.REPO == CacheStatusMask.REPO

    def test_none_has_no_bits(self):
        assert not (CacheStatusMask.NONE & CacheStatusMask.REPO)
        assert not (CacheStatusMask.NONE & CacheStatusMask.LIGHT)
        assert not (CacheStatusMask.NONE & CacheStatusMask.ALL)


class TestCacheStatusMaskBitOps:
    """Verify bitwise operations on CacheStatusMask."""

    def test_or_none_repo(self):
        result = CacheStatusMask.NONE | CacheStatusMask.REPO
        assert result == CacheStatusMask.REPO

    def test_or_repo_all(self):
        result = CacheStatusMask.REPO | CacheStatusMask.ALL
        assert result == CacheStatusMask.ALL

    def test_or_preserves_type(self):
        result = CacheStatusMask(CacheStatusMask.NONE | CacheStatusMask.REPO)
        assert isinstance(result, CacheStatusMask)

    def test_and_all_repo(self):
        result = CacheStatusMask.ALL & CacheStatusMask.REPO
        assert result == CacheStatusMask.REPO

    def test_and_repo_all_not_equal_all(self):
        """REPO & ALL != ALL — REPO does not satisfy ALL."""
        result = CacheStatusMask.REPO & CacheStatusMask.ALL
        assert result != CacheStatusMask.ALL


# ============================================================================
# YasaMcpContext default state tests
# ============================================================================


class TestContextDefaultState:
    """Verify YasaMcpContext initializes with correct default cache state."""

    def test_default_cache_status_is_none(self):
        ctx = YasaMcpContext()
        assert ctx.cache_status == CacheStatusMask.NONE

    def test_get_cache_status_returns_none_by_default(self):
        ctx = YasaMcpContext()
        assert ctx.get_cache_status() == CacheStatusMask.NONE

    def test_is_cache_ready_false_for_repo_by_default(self):
        ctx = YasaMcpContext()
        assert not ctx.is_cache_ready(CacheStatusMask.REPO)

    def test_is_cache_ready_false_for_all_by_default(self):
        ctx = YasaMcpContext()
        assert not ctx.is_cache_ready(CacheStatusMask.ALL)

    def test_is_cache_ready_true_for_none(self):
        """NONE requires no bits, so any state satisfies it."""
        ctx = YasaMcpContext()
        assert ctx.is_cache_ready(CacheStatusMask.NONE)


# ============================================================================
# update_cache_status tests
# ============================================================================


class TestUpdateCacheReady:
    """Verify update_cache_status (OR operation) behavior."""

    def test_update_from_none_to_repo(self):
        ctx = YasaMcpContext()
        ctx.update_cache_status(CacheStatusMask.REPO)
        assert ctx.cache_status == CacheStatusMask.REPO

    def test_update_from_repo_to_all(self):
        ctx = YasaMcpContext()
        ctx.update_cache_status(CacheStatusMask.REPO)
        ctx.update_cache_status(CacheStatusMask.ALL)
        assert ctx.cache_status == CacheStatusMask.ALL

    def test_update_is_idempotent(self):
        ctx = YasaMcpContext()
        ctx.update_cache_status(CacheStatusMask.REPO)
        ctx.update_cache_status(CacheStatusMask.REPO)
        assert ctx.cache_status == CacheStatusMask.REPO

    def test_update_preserves_existing_bits(self):
        """OR operation should not clear existing bits."""
        ctx = YasaMcpContext()
        ctx.update_cache_status(CacheStatusMask.ALL)
        ctx.update_cache_status(CacheStatusMask.REPO)
        assert ctx.cache_status == CacheStatusMask.ALL

    def test_update_from_none_directly_to_all(self):
        ctx = YasaMcpContext()
        ctx.update_cache_status(CacheStatusMask.ALL)
        assert ctx.cache_status == CacheStatusMask.ALL

    def test_update_to_light(self):
        ctx = YasaMcpContext()
        ctx.update_cache_status(CacheStatusMask.LIGHT)
        assert ctx.cache_status == CacheStatusMask.LIGHT
        assert ctx.is_cache_ready(CacheStatusMask.REPO)
        assert not ctx.is_cache_ready(CacheStatusMask.ALL)


# ============================================================================
# reset_cache_status tests
# ============================================================================


class TestResetCacheReady:
    """Verify reset_cache_status (direct assignment) behavior."""

    def test_reset_all_to_repo(self):
        ctx = YasaMcpContext()
        ctx.update_cache_status(CacheStatusMask.ALL)
        ctx.reset_cache_status(CacheStatusMask.REPO)
        assert ctx.cache_status == CacheStatusMask.REPO

    def test_reset_all_to_none(self):
        ctx = YasaMcpContext()
        ctx.update_cache_status(CacheStatusMask.ALL)
        ctx.reset_cache_status(CacheStatusMask.NONE)
        assert ctx.cache_status == CacheStatusMask.NONE

    def test_reset_clears_higher_bits(self):
        """Reset to REPO should clear ALL bits."""
        ctx = YasaMcpContext()
        ctx.update_cache_status(CacheStatusMask.ALL)
        ctx.reset_cache_status(CacheStatusMask.REPO)
        assert not ctx.is_cache_ready(CacheStatusMask.ALL)
        assert ctx.is_cache_ready(CacheStatusMask.REPO)

    def test_reset_to_same_value(self):
        ctx = YasaMcpContext()
        ctx.update_cache_status(CacheStatusMask.REPO)
        ctx.reset_cache_status(CacheStatusMask.REPO)
        assert ctx.cache_status == CacheStatusMask.REPO


# ============================================================================
# get_cache_status tests
# ============================================================================


class TestGetCacheReady:
    """Verify get_cache_status returns current state correctly."""

    def test_returns_none_initially(self):
        ctx = YasaMcpContext()
        assert ctx.get_cache_status() == CacheStatusMask.NONE

    def test_returns_repo_after_update(self):
        ctx = YasaMcpContext()
        ctx.update_cache_status(CacheStatusMask.REPO)
        assert ctx.get_cache_status() == CacheStatusMask.REPO

    def test_returns_all_after_full_update(self):
        ctx = YasaMcpContext()
        ctx.update_cache_status(CacheStatusMask.ALL)
        assert ctx.get_cache_status() == CacheStatusMask.ALL

    def test_reflects_reset(self):
        ctx = YasaMcpContext()
        ctx.update_cache_status(CacheStatusMask.ALL)
        ctx.reset_cache_status(CacheStatusMask.REPO)
        assert ctx.get_cache_status() == CacheStatusMask.REPO


# ============================================================================
# is_cache_ready tests
# ============================================================================


class TestIsCacheReady:
    """Verify is_cache_ready checks all required bits."""

    def test_none_state_does_not_satisfy_repo(self):
        ctx = YasaMcpContext()
        assert not ctx.is_cache_ready(CacheStatusMask.REPO)

    def test_none_state_does_not_satisfy_all(self):
        ctx = YasaMcpContext()
        assert not ctx.is_cache_ready(CacheStatusMask.ALL)

    def test_repo_state_satisfies_repo(self):
        ctx = YasaMcpContext()
        ctx.update_cache_status(CacheStatusMask.REPO)
        assert ctx.is_cache_ready(CacheStatusMask.REPO)

    def test_repo_state_does_not_satisfy_all(self):
        """REPO only has bit 0, ALL requires bits 0+1+2."""
        ctx = YasaMcpContext()
        ctx.update_cache_status(CacheStatusMask.REPO)
        assert not ctx.is_cache_ready(CacheStatusMask.ALL)

    def test_repo_state_does_not_satisfy_light(self):
        """REPO only has bit 0, LIGHT requires bits 0+1."""
        ctx = YasaMcpContext()
        ctx.update_cache_status(CacheStatusMask.REPO)
        assert not ctx.is_cache_ready(CacheStatusMask.LIGHT)

    def test_all_state_satisfies_repo(self):
        ctx = YasaMcpContext()
        ctx.update_cache_status(CacheStatusMask.ALL)
        assert ctx.is_cache_ready(CacheStatusMask.REPO)

    def test_all_state_satisfies_light(self):
        ctx = YasaMcpContext()
        ctx.update_cache_status(CacheStatusMask.ALL)
        assert ctx.is_cache_ready(CacheStatusMask.LIGHT)

    def test_all_state_satisfies_all(self):
        ctx = YasaMcpContext()
        ctx.update_cache_status(CacheStatusMask.ALL)
        assert ctx.is_cache_ready(CacheStatusMask.ALL)

    def test_light_state_satisfies_repo(self):
        ctx = YasaMcpContext()
        ctx.update_cache_status(CacheStatusMask.LIGHT)
        assert ctx.is_cache_ready(CacheStatusMask.REPO)

    def test_light_state_does_not_satisfy_all(self):
        ctx = YasaMcpContext()
        ctx.update_cache_status(CacheStatusMask.LIGHT)
        assert not ctx.is_cache_ready(CacheStatusMask.ALL)


# ============================================================================
# State transition lifecycle tests
# ============================================================================


class TestCacheStateLifecycle:
    """End-to-end lifecycle scenarios matching project_service.py flows."""

    def test_full_build_lifecycle(self):
        """Simulate generate_project_cache flow: NONE → REPO → ALL."""
        ctx = YasaMcpContext()
        assert ctx.get_cache_status() == CacheStatusMask.NONE

        # init_tools completes
        ctx.update_cache_status(CacheStatusMask.REPO)
        assert ctx.is_cache_ready(CacheStatusMask.REPO)
        assert not ctx.is_cache_ready(CacheStatusMask.ALL)

        # cache build completes
        ctx.update_cache_status(CacheStatusMask.ALL)
        assert ctx.is_cache_ready(CacheStatusMask.REPO)
        assert ctx.is_cache_ready(CacheStatusMask.ALL)

    def test_incremental_build_lifecycle(self):
        """Simulate incremental update flow: NONE → REPO (reset) → ALL."""
        ctx = YasaMcpContext()

        # incremental mode: reset to REPO
        ctx.reset_cache_status(CacheStatusMask.REPO)
        assert ctx.is_cache_ready(CacheStatusMask.REPO)
        assert not ctx.is_cache_ready(CacheStatusMask.ALL)

        # incremental build completes
        ctx.update_cache_status(CacheStatusMask.ALL)
        assert ctx.is_cache_ready(CacheStatusMask.ALL)

    def test_cache_load_lifecycle(self):
        """Simulate build_yasa_mcp_context_from_cache flow: NONE → REPO → ALL."""
        ctx = YasaMcpContext()

        # init_tools
        ctx.update_cache_status(CacheStatusMask.REPO)
        assert ctx.is_cache_ready(CacheStatusMask.REPO)

        # cache loaded
        ctx.update_cache_status(CacheStatusMask.ALL)
        assert ctx.is_cache_ready(CacheStatusMask.ALL)

    def test_incremental_resets_all_to_repo(self):
        """Simulate: full build completes → incremental update begins → ALL drops to REPO."""
        ctx = YasaMcpContext()
        ctx.update_cache_status(CacheStatusMask.ALL)
        assert ctx.is_cache_ready(CacheStatusMask.ALL)

        # incremental update starts
        ctx.reset_cache_status(CacheStatusMask.REPO)
        assert ctx.is_cache_ready(CacheStatusMask.REPO)
        assert not ctx.is_cache_ready(CacheStatusMask.ALL)

        # incremental completes
        ctx.update_cache_status(CacheStatusMask.ALL)
        assert ctx.is_cache_ready(CacheStatusMask.ALL)


# ============================================================================
# Service routing logic tests
# ============================================================================


class TestServiceRoutingLogic:
    """Verify the routing conditions used in code_search_service / callgraph_service."""

    def test_none_state_returns_empty(self):
        """NONE: not (cache_status & REPO) is True → should return empty."""
        ctx = YasaMcpContext()
        assert not (ctx.cache_status & CacheStatusMask.REPO)

    def test_repo_state_routes_to_realtime(self):
        """REPO: (cache_status & REPO) is True, not (cache_status & ALL) is True → realtime."""
        ctx = YasaMcpContext()
        ctx.update_cache_status(CacheStatusMask.REPO)
        assert ctx.cache_status & CacheStatusMask.REPO
        assert not (ctx.cache_status & CacheStatusMask.ALL) == CacheStatusMask.ALL

    def test_all_state_routes_to_duckdb(self):
        """ALL: (cache_status & REPO) is True, (cache_status & ALL) == ALL → DuckDB."""
        ctx = YasaMcpContext()
        ctx.update_cache_status(CacheStatusMask.ALL)
        assert ctx.cache_status & CacheStatusMask.REPO
        assert (ctx.cache_status & CacheStatusMask.ALL) == CacheStatusMask.ALL

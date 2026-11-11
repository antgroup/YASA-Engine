"""Shared normalization helpers for AI-friendly selector parameters."""

from __future__ import annotations

from collections.abc import Iterable


def normalize_selector(value: str | Iterable[str] | None) -> tuple[str, ...]:
    """Return a stable, trimmed, de-duplicated selector tuple.

    Selectors are intentionally normalized at the service boundary.  The helper does
    not interpret regexes or paths; it only removes empty values and preserves first
    occurrence order so query builders can safely bind every value as a parameter.
    """

    if value is None:
        return ()
    values = (value,) if isinstance(value, str) else value
    normalized: list[str] = []
    seen: set[str] = set()
    for item in values:
        if not isinstance(item, str):
            raise TypeError("selector values must be strings")
        item = item.strip()
        if not item or item in seen:
            continue
        seen.add(item)
        normalized.append(item)
    return tuple(normalized)

"""Agent runtime service stubs for collaboration and execution helpers."""

from __future__ import annotations

from typing import Any


def resolve_runtime_context(project_id: str, role: str) -> dict[str, Any]:
    """Return normalized runtime context for command/task execution."""
    return {
        "project_id": project_id,
        "role": role,
    }


def is_codex_ready() -> bool:
    """Codex path availability guard for phase-1 execution policy."""
    return True
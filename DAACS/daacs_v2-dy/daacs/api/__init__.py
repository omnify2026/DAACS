"""
DAACS API Package
Lazy imports to avoid circular dependency with server.py
"""
from typing import Any

__all__ = ["app", "projects"]


def __getattr__(name: str) -> Any:
    """Lazy import to avoid circular dependency."""
    if name == "app":
        from ..server import app
        return app
    if name == "projects":
        from ..server_state import projects
        return projects
    raise AttributeError(f"module '{__name__}' has no attribute '{name}'")

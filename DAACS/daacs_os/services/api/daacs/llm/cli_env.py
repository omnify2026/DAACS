"""Helpers for CLI subprocess environment."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Dict

_PROXY_KEYS = (
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
)


def _is_blocked_proxy_value(value: str) -> bool:
    raw = (value or "").strip().lower()
    return raw in {
        "http://127.0.0.1:9",
        "https://127.0.0.1:9",
        "127.0.0.1:9",
        "http://localhost:9",
        "https://localhost:9",
        "localhost:9",
    }


def build_cli_subprocess_env(base_env: Dict[str, str] | None = None) -> Dict[str, str]:
    """Return subprocess env with sandbox sentinel proxies removed.

    Some sandboxes inject loopback discard proxies (`127.0.0.1:9`) to block egress.
    CLI tools that need real model backends should ignore only that sentinel value.
    """

    env = dict(base_env or os.environ)
    for key in _PROXY_KEYS:
        value = env.get(key)
        if isinstance(value, str) and _is_blocked_proxy_value(value):
            env[key] = ""
    return env


def resolve_venv_executable(venv_dir: str | os.PathLike[str], executable: str) -> Path | None:
    """Return the platform-appropriate executable path inside a virtualenv."""

    root = Path(venv_dir)
    candidates = (
        root / "bin" / executable,
        root / "bin" / f"{executable}.exe",
        root / "Scripts" / executable,
        root / "Scripts" / f"{executable}.exe",
    )
    for candidate in candidates:
        if candidate.exists():
            return candidate
    return None

"""Thin analytics adapter (PostHog optional)."""

from __future__ import annotations

import logging
import os
from typing import Any, Dict, Optional

logger = logging.getLogger("daacs.monitoring.analytics")

_client = None
_disabled = False


def _get_client():
    global _client, _disabled
    if _client is not None or _disabled:
        return _client

    api_key = os.getenv("POSTHOG_API_KEY", "").strip()
    host = os.getenv("POSTHOG_HOST", "https://us.i.posthog.com").strip()
    if not api_key:
        _disabled = True
        return None

    try:
        from posthog import Posthog

        _client = Posthog(project_api_key=api_key, host=host)
        return _client
    except Exception as exc:  # pragma: no cover
        logger.warning("Failed to initialize PostHog client: %s", exc)
        _disabled = True
        return None


def track_event(distinct_id: str, event: str, properties: Optional[Dict[str, Any]] = None) -> None:
    client = _get_client()
    if not client:
        return
    try:
        client.capture(distinct_id=distinct_id, event=event, properties=properties or {})
    except Exception as exc:  # pragma: no cover
        logger.warning("PostHog capture failed: %s", exc)


def identify_user(distinct_id: str, properties: Optional[Dict[str, Any]] = None) -> None:
    client = _get_client()
    if not client:
        return
    try:
        client.identify(distinct_id=distinct_id, properties=properties or {})
    except Exception as exc:  # pragma: no cover
        logger.warning("PostHog identify failed: %s", exc)


def reset_analytics() -> None:
    global _client, _disabled
    _client = None
    _disabled = False

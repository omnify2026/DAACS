"""Rate limit helpers with Redis-first storage and in-memory fallback."""

from __future__ import annotations

import asyncio
import logging
import os
import time
from threading import Lock
from typing import Dict, List, Optional, Tuple

from redis.asyncio import Redis

logger = logging.getLogger("daacs.rate_limit")

_redis_client: Redis | None = None
_redis_loop: asyncio.AbstractEventLoop | None = None
_redis_lock = asyncio.Lock()
_memory_events: Dict[str, List[float]] = {}
_memory_lock = Lock()


def _redis_url() -> str:
    explicit = os.getenv("REDIS_URL", "").strip()
    if explicit:
        return explicit

    host = os.getenv("REDIS_HOST", "localhost").strip() or "localhost"
    port = os.getenv("REDIS_PORT", "6379").strip() or "6379"
    password = os.getenv("REDIS_PASSWORD", "").strip()
    if password:
        return f"redis://:{password}@{host}:{port}/0"
    return f"redis://{host}:{port}/0"


def _fail_closed() -> bool:
    env_value = os.getenv("DAACS_RATE_LIMIT_FAIL_CLOSED", "").strip().lower()
    if env_value in {"1", "true", "yes", "on"}:
        return True
    env = os.getenv("DAACS_ENV", "dev").strip().lower()
    return env in {"prod", "production"}


async def _get_redis_client() -> Redis:
    global _redis_client, _redis_loop
    current_loop = asyncio.get_running_loop()
    if _redis_client is not None and _redis_loop is current_loop:
        return _redis_client

    async with _redis_lock:
        if _redis_client is not None and _redis_loop is current_loop:
            return _redis_client

        if _redis_client is not None and _redis_loop is not None and _redis_loop is not current_loop:
            try:
                await _redis_client.aclose()
            except Exception:
                pass
            _redis_client = None
            _redis_loop = None

        client = Redis.from_url(_redis_url(), encoding="utf-8", decode_responses=True)
        await client.ping()
        _redis_client = client
        _redis_loop = current_loop
        return _redis_client


def _memory_rate_limit(key: str, limit: int, window_seconds: int) -> Tuple[bool, int | None]:
    now = time.time()
    window = max(1, window_seconds)

    with _memory_lock:
        events = _memory_events.get(key, [])
        cutoff = now - window
        events = [ts for ts in events if ts > cutoff]

        if len(events) >= limit:
            retry_after = max(1, int(window - (now - events[0])))
            _memory_events[key] = events
            return False, retry_after

        events.append(now)
        _memory_events[key] = events
        return True, None


async def check_rate_limit(
    key: str,
    limit: int,
    window_seconds: int,
) -> Tuple[bool, int | None]:
    """Return (allowed, retry_after_seconds)."""
    safe_limit = max(1, int(limit))
    safe_window = max(1, int(window_seconds))
    redis_key = f"rl:{key}"

    try:
        client = await _get_redis_client()
        count = await client.incr(redis_key)
        if count == 1:
            await client.expire(redis_key, safe_window)
        if count > safe_limit:
            ttl = await client.ttl(redis_key)
            retry_after = safe_window if ttl is None or int(ttl) <= 0 else int(ttl)
            return False, max(1, retry_after)
        return True, None
    except Exception as exc:
        if _fail_closed():
            logger.error("Rate limit backend unavailable (fail-closed): %s", exc)
            raise RuntimeError("Rate limit backend unavailable") from exc
        logger.warning("Rate limit backend unavailable, using memory fallback: %s", exc)
        return _memory_rate_limit(redis_key, safe_limit, safe_window)

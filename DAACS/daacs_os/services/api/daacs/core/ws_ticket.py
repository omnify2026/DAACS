"""Short-lived one-time tickets for WebSocket authentication.

Redis-backed storage is preferred to keep behavior consistent across workers.
If Redis is unavailable, a process-local fallback is used.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import secrets
import time
import uuid
from threading import Lock
from typing import Dict, Optional, Tuple

from redis.asyncio import Redis

logger = logging.getLogger("daacs.ws_ticket")

_tickets: Dict[str, Tuple[uuid.UUID, str, float]] = {}
_lock = Lock()

_redis_client: Redis | None = None
_redis_lock = asyncio.Lock()


def _cleanup_expired(now: float) -> None:
    expired = [ticket for ticket, (_, _, exp) in _tickets.items() if exp <= now]
    for ticket in expired:
        _tickets.pop(ticket, None)


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


async def _get_redis_client() -> Redis:
    global _redis_client
    if _redis_client is not None:
        return _redis_client

    async with _redis_lock:
        if _redis_client is not None:
            return _redis_client
        client = Redis.from_url(_redis_url(), encoding="utf-8", decode_responses=True)
        await client.ping()
        _redis_client = client
        return _redis_client


def _ticket_key(ticket: str) -> str:
    return f"ws_ticket:{ticket}"


def _store_ticket_in_memory(ticket: str, user_id: uuid.UUID, project_id: str, ttl_seconds: int) -> None:
    now = time.time()
    exp = now + max(1, ttl_seconds)
    with _lock:
        _cleanup_expired(now)
        _tickets[ticket] = (user_id, project_id, exp)


def _consume_ticket_from_memory(ticket: str, project_id: str) -> Optional[uuid.UUID]:
    now = time.time()
    with _lock:
        _cleanup_expired(now)
        payload = _tickets.pop(ticket, None)
    if payload is None:
        return None
    user_id, bound_project_id, exp = payload
    if exp <= now:
        return None
    if bound_project_id != project_id:
        return None
    return user_id


async def issue_ws_ticket(user_id: uuid.UUID, project_id: str, ttl_seconds: int = 30) -> str:
    ttl = max(1, int(ttl_seconds))
    ticket = f"wst_{secrets.token_urlsafe(24)}"
    payload = json.dumps({"uid": str(user_id), "pid": project_id})
    try:
        client = await _get_redis_client()
        await client.setex(_ticket_key(ticket), ttl, payload)
        return ticket
    except Exception as exc:
        logger.warning("WS ticket Redis backend unavailable, using memory fallback: %s", exc)
        _store_ticket_in_memory(ticket, user_id, project_id, ttl)
        return ticket


async def consume_ws_ticket(ticket: str, project_id: str) -> Optional[uuid.UUID]:
    if not ticket:
        return None

    try:
        client = await _get_redis_client()
        key = _ticket_key(ticket)
        async with client.pipeline(transaction=True) as pipe:
            pipe.get(key)
            pipe.delete(key)
            value, _deleted = await pipe.execute()
        if not value:
            return None
        payload = json.loads(value)
        if payload.get("pid") != project_id:
            return None
        try:
            return uuid.UUID(str(payload.get("uid")))
        except (ValueError, TypeError):
            return None
    except Exception as exc:
        logger.warning("WS ticket Redis backend unavailable during consume, using memory fallback: %s", exc)
        return _consume_ticket_from_memory(ticket, project_id)

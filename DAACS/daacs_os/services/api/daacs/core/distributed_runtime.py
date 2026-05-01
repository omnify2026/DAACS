"""Distributed runtime helpers for multi-instance API operation.

Provides:
1) Project runtime ownership via Redis keys with TTL.
2) Lightweight RPC over Redis lists (request/response).
"""

from __future__ import annotations

import asyncio
import inspect
import json
import logging
import os
import socket
import uuid
from typing import Any, Awaitable, Callable, Dict, Optional

from redis.asyncio import Redis

logger = logging.getLogger("daacs.core.distributed_runtime")

_OWNER_KEY_PREFIX = "daacs:runtime:owner"
_RPC_REQ_PREFIX = "daacs:runtime:rpc:req"
_RPC_RES_PREFIX = "daacs:runtime:rpc:res"
_RPC_RES_TTL_SECONDS = 90

_redis_client: Redis | None = None
_redis_loop: asyncio.AbstractEventLoop | None = None
_redis_lock = asyncio.Lock()

_rpc_handler: Optional[Callable[[Dict[str, Any]], Awaitable[Any] | Any]] = None
_rpc_server_task: asyncio.Task | None = None
_rpc_stop_event: asyncio.Event | None = None

_instance_id = (
    os.getenv("DAACS_INSTANCE_ID", "").strip()
    or f"{socket.gethostname()}-{os.getpid()}-{uuid.uuid4().hex[:8]}"
)


def _is_enabled() -> bool:
    raw = os.getenv("DAACS_DISTRIBUTED_RUNTIME_ENABLED", "").strip().lower()
    if raw in {"1", "true", "yes", "on"}:
        return True
    if raw in {"0", "false", "no", "off"}:
        return False
    env = os.getenv("DAACS_ENV", "dev").strip().lower()
    return env in {"prod", "production"}


def is_enabled() -> bool:
    return _is_enabled()


_OWNER_REFRESH_LUA = """
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2]))
end
return 0
"""

_OWNER_RELEASE_LUA = """
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
"""


def instance_id() -> str:
    return _instance_id


def owner_ttl_seconds() -> int:
    raw = os.getenv("DAACS_OWNER_TTL_SECONDS", "90").strip()
    try:
        return max(20, int(raw))
    except ValueError:
        return 90


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


async def get_redis_client() -> Redis:
    global _redis_client, _redis_loop
    current_loop = asyncio.get_running_loop()
    if _redis_client is not None and _redis_loop is current_loop:
        return _redis_client

    async with _redis_lock:
        if _redis_client is not None and _redis_loop is current_loop:
            return _redis_client

        # Redis asyncio clients are loop-bound. Recreate the client when tests
        # or workers switch event loops in the same process.
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


def owner_key(project_id: str) -> str:
    return f"{_OWNER_KEY_PREFIX}:{project_id}"


def rpc_request_queue(target_instance: str) -> str:
    return f"{_RPC_REQ_PREFIX}:{target_instance}"


def rpc_response_queue(request_id: str) -> str:
    return f"{_RPC_RES_PREFIX}:{request_id}"


async def get_project_owner(project_id: str) -> Optional[str]:
    if not _is_enabled():
        return instance_id()
    try:
        client = await get_redis_client()
        owner = await client.get(owner_key(project_id))
        return owner or None
    except Exception as exc:
        logger.warning("Owner lookup failed for project=%s: %s", project_id, exc)
        return None


async def claim_project_owner(
    project_id: str,
    owner: Optional[str] = None,
    ttl_seconds: Optional[int] = None,
) -> bool:
    owner_value = (owner or instance_id()).strip()
    ttl = max(20, int(ttl_seconds or owner_ttl_seconds()))
    if not _is_enabled():
        return True
    try:
        client = await get_redis_client()
        acquired = await client.set(owner_key(project_id), owner_value, ex=ttl, nx=True)
        return bool(acquired)
    except Exception as exc:
        logger.warning("Owner claim failed for project=%s: %s", project_id, exc)
        return False


async def refresh_project_owner(
    project_id: str,
    owner: Optional[str] = None,
    ttl_seconds: Optional[int] = None,
) -> bool:
    owner_value = (owner or instance_id()).strip()
    ttl = max(20, int(ttl_seconds or owner_ttl_seconds()))
    if not _is_enabled():
        return True
    try:
        client = await get_redis_client()
        updated = await client.eval(_OWNER_REFRESH_LUA, 1, owner_key(project_id), owner_value, ttl)
        return int(updated) == 1
    except Exception as exc:
        logger.warning("Owner refresh failed for project=%s: %s", project_id, exc)
        return False


async def release_project_owner(project_id: str, owner: Optional[str] = None) -> bool:
    owner_value = (owner or instance_id()).strip()
    if not _is_enabled():
        return True
    try:
        client = await get_redis_client()
        removed = await client.eval(_OWNER_RELEASE_LUA, 1, owner_key(project_id), owner_value)
        return int(removed) == 1
    except Exception as exc:
        logger.warning("Owner release failed for project=%s: %s", project_id, exc)
        return False


async def ensure_project_owner(
    project_id: str,
    owner: Optional[str] = None,
    ttl_seconds: Optional[int] = None,
) -> Optional[str]:
    owner_value = (owner or instance_id()).strip()
    if not _is_enabled():
        return owner_value
    existing = await get_project_owner(project_id)
    if existing and existing != owner_value:
        return existing
    if existing == owner_value:
        await refresh_project_owner(project_id, owner=owner_value, ttl_seconds=ttl_seconds)
        return owner_value

    acquired = await claim_project_owner(project_id, owner=owner_value, ttl_seconds=ttl_seconds)
    if acquired:
        return owner_value
    return await get_project_owner(project_id)


async def _await_if_needed(value: Any) -> Any:
    if inspect.isawaitable(value):
        return await value
    return value


async def _rpc_loop() -> None:
    queue_key = rpc_request_queue(instance_id())
    logger.info("Distributed RPC loop started: queue=%s", queue_key)
    while _rpc_stop_event is not None and not _rpc_stop_event.is_set():
        try:
            client = await get_redis_client()
            item = await client.blpop(queue_key, timeout=1)
        except asyncio.CancelledError:
            break
        except Exception as exc:
            logger.warning("RPC loop receive failed: %s", exc)
            await asyncio.sleep(1.0)
            continue

        if not item:
            continue

        _, raw_payload = item
        request_id = ""
        response: Dict[str, Any]
        try:
            payload = json.loads(raw_payload)
            if not isinstance(payload, dict):
                raise ValueError("RPC payload must be object")
            request_id = str(payload.get("request_id") or "")
            if not request_id:
                raise ValueError("RPC request_id missing")
            if _rpc_handler is None:
                raise RuntimeError("RPC handler is not initialized")

            result = await _await_if_needed(_rpc_handler(payload))
            response = {"ok": True, "result": result}
        except Exception as exc:
            response = {"ok": False, "error": str(exc)}

        if request_id:
            try:
                response_key = rpc_response_queue(request_id)
                await client.rpush(response_key, json.dumps(response))
                await client.expire(response_key, _RPC_RES_TTL_SECONDS)
            except Exception as exc:
                logger.warning("RPC response publish failed: %s", exc)

    logger.info("Distributed RPC loop stopped: queue=%s", queue_key)


async def start_rpc_server(
    handler: Callable[[Dict[str, Any]], Awaitable[Any] | Any],
) -> None:
    global _rpc_handler, _rpc_server_task, _rpc_stop_event
    if not _is_enabled():
        _rpc_handler = handler
        return

    _rpc_handler = handler
    if _rpc_server_task is not None and not _rpc_server_task.done():
        return

    _rpc_stop_event = asyncio.Event()
    _rpc_server_task = asyncio.create_task(_rpc_loop())


async def stop_rpc_server() -> None:
    global _rpc_server_task, _rpc_stop_event
    if not _is_enabled():
        _rpc_server_task = None
        _rpc_stop_event = None
        return

    if _rpc_stop_event is not None:
        _rpc_stop_event.set()

    if _rpc_server_task is not None:
        _rpc_server_task.cancel()
        try:
            await _rpc_server_task
        except asyncio.CancelledError:
            pass
    _rpc_server_task = None
    _rpc_stop_event = None


async def rpc_call(
    target_instance: str,
    payload: Dict[str, Any],
    timeout_seconds: float = 10.0,
) -> Any:
    request_id = uuid.uuid4().hex
    response_key = rpc_response_queue(request_id)
    message = {
        "request_id": request_id,
        "from_instance": instance_id(),
        **payload,
    }

    client = await get_redis_client()
    await client.rpush(rpc_request_queue(target_instance), json.dumps(message))

    item = await client.blpop(response_key, timeout=max(1, int(timeout_seconds)))
    if not item:
        raise TimeoutError(f"RPC timeout waiting for {target_instance}")

    _, raw_response = item
    decoded = json.loads(raw_response)
    if not decoded.get("ok"):
        raise RuntimeError(decoded.get("error") or "RPC call failed")
    return decoded.get("result")


__all__ = [
    "instance_id",
    "owner_ttl_seconds",
    "get_redis_client",
    "owner_key",
    "get_project_owner",
    "claim_project_owner",
    "refresh_project_owner",
    "release_project_owner",
    "ensure_project_owner",
    "start_rpc_server",
    "stop_rpc_server",
    "rpc_call",
]

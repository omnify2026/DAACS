"""Project-scoped runtime event fan-out (Redis)."""

import asyncio
import json
import logging
import uuid
from typing import Dict, List

from fastapi import APIRouter, Depends, WebSocket, WebSocketDisconnect
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..agents.protocol import AgentEvent
from ..core import distributed_runtime
from ..core.security import decode_access_token
from ..core.ws_ticket import consume_ws_ticket
from ..db.models import ProjectMembership, User
from ..db.session import get_db

logger = logging.getLogger("daacs.ws.agents")
router = APIRouter()


async def _resolve_ws_user_id(auth_payload: dict, project_id: str) -> uuid.UUID | None:
    ticket = str(auth_payload.get("ticket") or "").strip()
    if ticket:
        return await consume_ws_ticket(ticket, project_id)

    token = str(auth_payload.get("token") or "").strip()
    if not token:
        return None
    decoded = decode_access_token(token)
    if not decoded:
        return None
    subject = decoded.get("sub")
    try:
        return uuid.UUID(str(subject))
    except (TypeError, ValueError):
        return None


async def _has_project_access(db: AsyncSession, user_id: uuid.UUID, project_id: str) -> bool:
    try:
        project_uuid = uuid.UUID(str(project_id))
    except ValueError:
        return False

    user_result = await db.execute(select(User).where(User.id == user_id))
    user = user_result.scalar_one_or_none()
    if user is None or not user.is_active:
        return False

    membership_result = await db.execute(
        select(ProjectMembership).where(
            ProjectMembership.project_id == project_uuid,
            ProjectMembership.user_id == user_id,
        )
    )
    return membership_result.scalar_one_or_none() is not None


class ConnectionManager:
    def __init__(self):
        self._connections: Dict[str, List[object]] = {}
        self._listeners: Dict[str, asyncio.Task] = {}

    @staticmethod
    def _channel(project_id: str) -> str:
        return f"daacs:ws:project:{project_id}"

    async def connect(self, project_id: str, ws: object):
        if project_id not in self._connections:
            self._connections[project_id] = []
        self._connections[project_id].append(ws)

        if distributed_runtime.is_enabled() and project_id not in self._listeners:
            self._listeners[project_id] = asyncio.create_task(self._listen_project(project_id))

        logger.info("Push target registered: project=%s, total=%d", project_id, len(self._connections[project_id]))

    def disconnect(self, project_id: str, ws: object):
        conns = self._connections.get(project_id, [])
        if ws in conns:
            conns.remove(ws)
        if not conns:
            self._connections.pop(project_id, None)
            listener = self._listeners.pop(project_id, None)
            if listener is not None:
                listener.cancel()
        logger.info("Push target removed: project=%s", project_id)

    async def _emit_local_payload(self, project_id: str, payload: Dict):
        conns = list(self._connections.get(project_id, []))
        if not conns:
            return

        sends = []
        for ws in conns:
            send_json = getattr(ws, "send_json", None)
            if callable(send_json):
                sends.append(send_json(payload))
        if not sends:
            return
        results = await asyncio.gather(*sends, return_exceptions=True)

        dead: List[object] = []
        for ws, result in zip(conns, results):
            if isinstance(result, Exception):
                dead.append(ws)
        for ws in dead:
            self.disconnect(project_id, ws)

    async def _listen_project(self, project_id: str):
        if not distributed_runtime.is_enabled():
            return
        channel = self._channel(project_id)
        pubsub = None
        try:
            while True:
                if not self._connections.get(project_id):
                    return
                try:
                    client = await distributed_runtime.get_redis_client()
                    pubsub = client.pubsub()
                    await pubsub.subscribe(channel)
                    while self._connections.get(project_id):
                        msg = await pubsub.get_message(ignore_subscribe_messages=True, timeout=1.0)
                        if not msg or "data" not in msg:
                            await asyncio.sleep(0)
                            continue

                        raw = msg["data"]
                        if isinstance(raw, bytes):
                            raw = raw.decode("utf-8", errors="ignore")

                        payload = json.loads(raw)
                        origin = None
                        if isinstance(payload, dict) and "payload" in payload:
                            origin = payload.get("origin")
                            payload = payload["payload"]
                        if not isinstance(payload, dict):
                            continue
                        if origin == distributed_runtime.instance_id():
                            continue
                        await self._emit_local_payload(project_id, payload)
                    return
                except asyncio.CancelledError:
                    return
                except Exception as exc:
                    logger.warning("Redis listener warning project=%s: %s", project_id, exc)
                    await asyncio.sleep(1.0)
                finally:
                    if pubsub is not None:
                        try:
                            await pubsub.unsubscribe(channel)
                            await pubsub.aclose()
                        except Exception:
                            pass
                        pubsub = None
        finally:
            self._listeners.pop(project_id, None)

    async def broadcast_to_project(self, project_id: str, event: AgentEvent):
        payload = event.model_dump() if hasattr(event, "model_dump") else dict(event)
        await self._emit_local_payload(project_id, payload)
        if not distributed_runtime.is_enabled():
            return
        message = {
            "origin": distributed_runtime.instance_id(),
            "payload": payload,
        }
        try:
            client = await distributed_runtime.get_redis_client()
            await client.publish(self._channel(project_id), json.dumps(message))
        except Exception as exc:
            logger.warning("Event publish fallback to local only project=%s: %s", project_id, exc)

    def get_connection_count(self, project_id: str) -> int:
        return len(self._connections.get(project_id, []))

    async def shutdown(self) -> None:
        listeners = list(self._listeners.values())
        self._listeners.clear()
        self._connections.clear()
        for task in listeners:
            task.cancel()
        for task in listeners:
            try:
                await task
            except asyncio.CancelledError:
                pass


ws_manager = ConnectionManager()


@router.websocket("/ws/agents/{project_id}")
async def agents_websocket(websocket: WebSocket, project_id: str, db: AsyncSession = Depends(get_db)):
    await websocket.accept()

    try:
        auth_payload = await websocket.receive_json()
        if not isinstance(auth_payload, dict) or auth_payload.get("type") != "auth":
            await websocket.close()
            return

        user_id = await _resolve_ws_user_id(auth_payload, project_id)
        if user_id is None or not await _has_project_access(db, user_id, project_id):
            await websocket.close()
            return

        await ws_manager.connect(project_id, websocket)
        try:
            while True:
                message = await websocket.receive_json()
                if isinstance(message, dict) and message.get("type") == "ping":
                    await websocket.send_json({"type": "pong"})
        finally:
            ws_manager.disconnect(project_id, websocket)
    except WebSocketDisconnect:
        ws_manager.disconnect(project_id, websocket)
    except Exception as exc:
        logger.warning("WebSocket closed project=%s err=%s", project_id, exc)
        ws_manager.disconnect(project_id, websocket)
        try:
            await websocket.close()
        except Exception:
            pass

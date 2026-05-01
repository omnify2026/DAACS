from datetime import datetime
from typing import Any, Dict, List

import os
import requests
from fastapi import WebSocket

from .server_state import get_project_workdir, locked_project, logger, nova_executor, projects, projects_lock
from .config import NOVA_WEBHOOK_TIMEOUT_SEC


def get_nova_webhook_url() -> str:
    return os.getenv("NOVA_WEBHOOK_URL", "http://127.0.0.1:5173/api/daacs/events")


def emit_to_nova(project_id: str, event_type: str, data: Dict[str, Any]) -> None:
    """Nova-Canvas 서버로 이벤트를 전송함 (비동기 처리)."""
    url = get_nova_webhook_url()

    def _send():
        try:
            payload = {
                "projectId": project_id,
                "type": event_type,
                "data": data,
            }
            requests.post(url, json=payload, timeout=NOVA_WEBHOOK_TIMEOUT_SEC)
        except (requests.RequestException, OSError):
            # Suppress "Connection refused" spam for local dev without Nova
            pass

    try:
        nova_executor.submit(_send)
    except RuntimeError:
        logger.warning("Failed to submit Nova event", exc_info=True)


class ConnectionManager:
    def __init__(self):
        self.active_connections: Dict[str, List[WebSocket]] = {}

    async def connect(self, project_id: str, websocket: WebSocket):
        await websocket.accept()
        if project_id not in self.active_connections:
            self.active_connections[project_id] = []
        self.active_connections[project_id].append(websocket)

    def disconnect(self, project_id: str, websocket: WebSocket):
        if project_id not in self.active_connections:
            return
        if websocket not in self.active_connections[project_id]:
            return
        self.active_connections[project_id].remove(websocket)
        if not self.active_connections[project_id]:
            del self.active_connections[project_id]

    async def broadcast_log(self, project_id: str, message: str, node: str = "system", level: str = "info"):
        log_entry = {
            "timestamp": datetime.now().isoformat(),
            "node": node,
            "message": message,
            "level": level,
        }

        # Store in memory for REST fetches (/logs)
        with projects_lock:
            p_info = projects.get(project_id)
        if p_info is not None:
            with locked_project(p_info):
                logs = p_info.setdefault("logs", [])
                logs.append(log_entry)
                if len(logs) > 2000:
                    del logs[:-2000]

        if project_id in self.active_connections:
            for connection in self.active_connections[project_id]:
                try:
                    await connection.send_json(log_entry)
                except (RuntimeError, OSError):
                    logger.debug("Failed to send websocket log", exc_info=True)


manager = ConnectionManager()

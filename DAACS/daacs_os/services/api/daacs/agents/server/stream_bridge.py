"""Stream bridge that converts adapter events to websocket AgentEvent payloads."""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Any, Dict, Optional

from ...application.persistence_service import persist_agent_event
from ..protocol import AgentEvent
from .adapters.base import StreamEvent

logger = logging.getLogger("daacs.server.bridge")

_EVENT_TYPE_MAP = {
    "chunk": "AGENT_STREAM_CHUNK",
    "tool_call": "AGENT_TOOL_CALL",
    "tool_result": "AGENT_TOOL_RESULT",
    "message": "AGENT_MESSAGE",
    "session_start": "AGENT_SESSION_STARTED",
    "done": "AGENT_STREAM_DONE",
    "error": "AGENT_ERROR",
}


class StreamBridge:
    """Project-scoped event bridge for streaming agent sessions."""

    def __init__(self, project_id: str, ws_manager):
        self.project_id = project_id
        self._ws_manager = ws_manager
        self._log_count = 0
        self._max_logs = 500

    async def emit(self, event: StreamEvent) -> None:
        """Emit one stream event to websocket clients and persistent event log."""
        if self._log_count >= self._max_logs and event.type == "chunk":
            # Sample chunk spam after threshold to avoid flooding the UI bus.
            if self._log_count % 10 != 0:
                self._log_count += 1
                return

        ws_type = _EVENT_TYPE_MAP.get(event.type, "AGENT_STREAM_CHUNK")
        payload = {
            "content": event.content,
            "stream_type": event.type,
            **event.metadata,
        }
        agent_event = AgentEvent(
            type=ws_type,
            agent_role=event.agent,
            data=payload,
            timestamp=event.timestamp,
        )

        try:
            await self._ws_manager.broadcast_to_project(self.project_id, agent_event)
        except Exception as exc:
            logger.warning("StreamBridge broadcast failed: %s", exc)

        await self._persist_runtime_event(ws_type, event)
        self._log_count += 1

    async def emit_message_sent(self, from_role: str, to_role: str, summary: str) -> None:
        """Emit animation-friendly message sent event to websocket subscribers."""
        event = AgentEvent(
            type="AGENT_MESSAGE_SENT",
            agent_role=from_role,
            data={
                "content": summary,
                "stream_type": "message",
                "from": from_role,
                "to": to_role,
            },
            timestamp=datetime.now().timestamp(),
        )
        try:
            await self._ws_manager.broadcast_to_project(self.project_id, event)
        except Exception as exc:
            logger.warning("StreamBridge message_sent failed: %s", exc)

    async def emit_message_received(self, from_role: str, to_role: str, summary: str) -> None:
        """Emit animation-friendly message received event to websocket subscribers."""
        event = AgentEvent(
            type="AGENT_MESSAGE_RECEIVED",
            agent_role=to_role,
            data={
                "content": summary,
                "stream_type": "message",
                "from": from_role,
                "to": to_role,
            },
            timestamp=datetime.now().timestamp(),
        )
        try:
            await self._ws_manager.broadcast_to_project(self.project_id, event)
        except Exception as exc:
            logger.warning("StreamBridge message_received failed: %s", exc)

    def reset_log_count(self) -> None:
        self._log_count = 0

    async def _persist_runtime_event(self, ws_type: str, event: StreamEvent) -> None:
        if ws_type == "AGENT_TOOL_CALL":
            file_change = self._extract_file_change(event.metadata)
            if file_change:
                await persist_agent_event(
                    project_id=self.project_id,
                    agent_role=event.agent,
                    event_type="file_change",
                    data=file_change,
                )
            return

        if ws_type == "AGENT_ERROR":
            await persist_agent_event(
                project_id=self.project_id,
                agent_role=event.agent,
                event_type="error",
                data={"error": event.content[:500]},
            )

    @staticmethod
    def _extract_file_change(metadata: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        if not isinstance(metadata, dict):
            return None

        tool_name = str(metadata.get("tool") or "unknown")
        tool_input = metadata.get("input")
        if not isinstance(tool_input, dict):
            return None

        file_path = str(tool_input.get("file_path") or tool_input.get("path") or "").strip()
        if not file_path:
            return None

        lowered = tool_name.lower()
        if any(token in lowered for token in ("create", "new_file", "write")):
            action = "create"
        elif any(token in lowered for token in ("edit", "patch", "replace", "rewrite", "append")):
            action = "edit"
        else:
            action = "read"

        return {"file_path": file_path, "action": action, "tool": tool_name}

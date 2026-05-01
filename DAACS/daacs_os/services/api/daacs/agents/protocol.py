"""Agent communication and websocket event protocol."""

import uuid
from datetime import datetime
from enum import Enum
from typing import Any, Dict

from pydantic import BaseModel, Field


class MessageType(str, Enum):
    TASK = "task"
    RESPONSE = "response"
    INFO = "info"
    ERROR = "error"
    REQUEST = "request"
    REJECT = "reject"
    DONE = "done"
    COMMAND = "command"
    STATUS_UPDATE = "status_update"


class AgentMessage(BaseModel):
    message_id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    sender: str
    receiver: str
    type: MessageType
    content: Any
    timestamp: float = Field(default_factory=lambda: datetime.now().timestamp())
    metadata: Dict[str, Any] = Field(default_factory=dict)


class AgentEvent(BaseModel):
    """WebSocket event payload for office UI."""

    type: str
    agent_role: str
    data: Dict[str, Any] = Field(default_factory=dict)
    timestamp: float = Field(default_factory=lambda: datetime.now().timestamp())


COLLAB_ROUND_STARTED = "COLLAB_ROUND_STARTED"
COLLAB_ROUND_COMPLETED = "COLLAB_ROUND_COMPLETED"
COLLAB_ARTIFACT_UPDATED = "COLLAB_ARTIFACT_UPDATED"

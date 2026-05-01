from datetime import datetime
from enum import Enum
from typing import Any, Dict, Optional
from pydantic import BaseModel, Field
import uuid

class AgentStatus(str, Enum):
    IDLE = "idle"
    BUSY = "busy"
    WAITING = "waiting"
    ERROR = "error"
    DONE = "done"

class MessageType(str, Enum):
    TASK = "task"           # New task assignment
    RESPONSE = "response"   # Response to a task
    INFO = "info"          # Status update or information
    ERROR = "error"        # Error report
    REQUEST = "request"     # Request for information
    REJECT = "reject"      # Task rejected (needs fix)
    DONE = "done"          # Task completion notification

class AgentMessage(BaseModel):
    message_id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    sender: str
    receiver: str
    type: MessageType
    content: Any
    timestamp: float = Field(default_factory=lambda: datetime.now().timestamp())
    metadata: Dict[str, Any] = Field(default_factory=dict)

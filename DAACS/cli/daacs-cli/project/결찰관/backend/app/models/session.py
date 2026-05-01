from datetime import datetime
from enum import Enum
from typing import List, Optional
from uuid import UUID, uuid4

from pydantic import BaseModel, Field


class ConversationTurn(BaseModel):
    """
    단일 대화 턴을 나타내는 Pydantic 모델
    """
    turn_id: UUID = Field(default_factory=uuid4)
    session_id: UUID
    parent_text: str
    ai_text: str
    created_at: datetime = Field(default_factory=datetime.now)

class CallStatus(str, Enum):
    """
    통화 세션의 상태를 나타내는 Enum
    """
    ACTIVE = "active"
    ENDED = "ended"

class CallSession(BaseModel):
    """
    통화 세션을 나타내는 Pydantic 모델 (메모리 전용)
    """
    session_id: UUID = Field(default_factory=uuid4)
    child_name: str = Field(max_length=50)
    created_at: datetime = Field(default_factory=datetime.now)
    last_active_at: datetime = Field(default_factory=datetime.now)
    status: CallStatus = CallStatus.ACTIVE
    turns: List[ConversationTurn] = Field(default_factory=list)

    class Config:
        """Pydantic 설정 클래스"""
        json_encoders = {
            UUID: str,
            datetime: lambda dt: dt.isoformat()
        }
        use_enum_values = True

from __future__ import annotations

from datetime import datetime
from typing import Dict, Optional
from uuid import UUID

from app.models.session import CallSession, CallStatus, ConversationTurn


class SessionMemory:
    """
    메모리 기반 세션 저장소 (디스크 저장 없음)
    """

    def __init__(self) -> None:
        self._sessions: Dict[UUID, CallSession] = {}

    def create_session(self, child_name: str) -> CallSession:
        session = CallSession(child_name=child_name)
        self._sessions[session.session_id] = session
        return session

    def get_session(self, session_id: UUID) -> Optional[CallSession]:
        return self._sessions.get(session_id)

    def add_turn(self, session_id: UUID, parent_text: str, ai_text: str) -> ConversationTurn:
        session = self._sessions.get(session_id)
        if session is None:
            raise KeyError("session_not_found")

        turn = ConversationTurn(
            session_id=session_id,
            parent_text=parent_text,
            ai_text=ai_text,
        )
        session.turns.append(turn)
        session.last_active_at = datetime.now()
        return turn

    def end_session(self, session_id: UUID) -> bool:
        session = self._sessions.get(session_id)
        if session is None:
            return False
        session.status = CallStatus.ENDED
        session.last_active_at = datetime.now()
        return True

    def cleanup_session(self, session_id: UUID) -> bool:
        return self._sessions.pop(session_id, None) is not None

    def clear(self) -> None:
        self._sessions.clear()


session_memory = SessionMemory()
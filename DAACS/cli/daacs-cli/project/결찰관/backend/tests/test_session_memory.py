from uuid import uuid4

import pytest

from app.models.session import CallStatus
from app.services.session_memory import session_memory


def test_create_and_get_session():
    session = session_memory.create_session("민수")

    fetched = session_memory.get_session(session.session_id)

    assert fetched is not None
    assert fetched.session_id == session.session_id
    assert fetched.child_name == "민수"
    assert fetched.status == CallStatus.ACTIVE


def test_add_turn_updates_session():
    session = session_memory.create_session("민수")

    turn = session_memory.add_turn(session.session_id, "부모 설명", "AI 답변")

    assert len(session.turns) == 1
    assert session.turns[0].turn_id == turn.turn_id
    assert session.turns[0].parent_text == "부모 설명"
    assert session.turns[0].ai_text == "AI 답변"


def test_end_and_cleanup_session():
    session = session_memory.create_session("민수")

    assert session_memory.end_session(session.session_id) is True
    assert session_memory.get_session(session.session_id).status == CallStatus.ENDED
    assert session_memory.cleanup_session(session.session_id) is True
    assert session_memory.get_session(session.session_id) is None


def test_add_turn_missing_session_raises():
    with pytest.raises(KeyError):
        session_memory.add_turn(uuid4(), "부모 설명", "AI 답변")
from __future__ import annotations

import asyncio
import uuid

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from daacs.core.security import create_access_token
from daacs.core.ws_ticket import issue_ws_ticket
from daacs.db.models import ProjectMembership, User
from daacs.db.session import get_db
from daacs.server import app


class _Result:
    def __init__(self, value):
        self._value = value

    def scalar_one_or_none(self):
        return self._value


class _FakeDb:
    def __init__(self, user: User, membership: ProjectMembership):
        self._user = user
        self._membership = membership

    async def execute(self, statement):
        entity = statement.column_descriptions[0].get("entity")
        if entity is User:
            return _Result(self._user)
        if entity is ProjectMembership:
            return _Result(self._membership)
        return _Result(None)


def test_ws_rejects_missing_token():
    project_id = str(uuid.uuid4())
    user = User(
        id=uuid.uuid4(),
        email="missing-token@example.com",
        hashed_password="hashed",
        is_active=True,
    )
    membership = ProjectMembership(
        project_id=uuid.uuid4(),
        user_id=user.id,
        role="owner",
        is_owner=True,
    )
    db = _FakeDb(user, membership)

    async def _fake_db():
        yield db

    app.dependency_overrides[get_db] = _fake_db
    with TestClient(app) as client:
        try:
            with pytest.raises(WebSocketDisconnect):
                with client.websocket_connect(f"/ws/agents/{project_id}") as ws:
                    ws.send_text('{"type":"ping"}')
                    ws.receive_text()
        finally:
            app.dependency_overrides.clear()


def test_ws_accepts_valid_token_and_project_access():
    project_id = uuid.uuid4()
    user_id = uuid.uuid4()
    user = User(
        id=user_id,
        email="ws-user@example.com",
        hashed_password="hashed",
        is_active=True,
    )
    membership = ProjectMembership(
        project_id=project_id,
        user_id=user_id,
        role="owner",
        is_owner=True,
    )
    db = _FakeDb(user, membership)

    async def _fake_db():
        yield db

    token = create_access_token(subject=str(user_id))
    app.dependency_overrides[get_db] = _fake_db
    try:
        with TestClient(app) as client:
            with client.websocket_connect(f"/ws/agents/{project_id}") as ws:
                ws.send_text(f'{{"type":"auth","token":"{token}"}}')
                ws.send_text('{"type":"ping"}')
                msg = ws.receive_json()
                assert msg["type"] == "pong"
    finally:
        app.dependency_overrides.clear()


def test_ws_accepts_one_time_ticket_and_rejects_reuse():
    project_id = uuid.uuid4()
    user_id = uuid.uuid4()
    user = User(
        id=user_id,
        email="ws-ticket@example.com",
        hashed_password="hashed",
        is_active=True,
    )
    membership = ProjectMembership(
        project_id=project_id,
        user_id=user_id,
        role="owner",
        is_owner=True,
    )
    db = _FakeDb(user, membership)

    async def _fake_db():
        yield db

    ticket = asyncio.run(issue_ws_ticket(user_id, str(project_id), ttl_seconds=30))
    app.dependency_overrides[get_db] = _fake_db
    try:
        with TestClient(app) as client:
            with client.websocket_connect(f"/ws/agents/{project_id}") as ws:
                ws.send_text(f'{{"type":"auth","ticket":"{ticket}"}}')
                ws.send_text('{"type":"ping"}')
                msg = ws.receive_json()
                assert msg["type"] == "pong"

            with pytest.raises(WebSocketDisconnect):
                with client.websocket_connect(f"/ws/agents/{project_id}") as ws:
                    ws.send_text(f'{{"type":"auth","ticket":"{ticket}"}}')
                    ws.send_text('{"type":"ping"}')
                    ws.receive_text()
    finally:
        app.dependency_overrides.clear()

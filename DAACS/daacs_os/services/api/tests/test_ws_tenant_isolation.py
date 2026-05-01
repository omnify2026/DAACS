from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from daacs.core import deps
from daacs.core.security import create_access_token
from daacs.db.models import ProjectMembership, User
from daacs.server import app


class _Result:
    def __init__(self, value):
        self._value = value

    def scalar_one_or_none(self):
        return self._value


class _FakeDb:
    def __init__(self, user, membership):
        self.user = user
        self.membership = membership

    async def execute(self, statement):
        entity = statement.column_descriptions[0].get("entity")
        if entity is User:
            return _Result(self.user)
        if entity is ProjectMembership:
            return _Result(self.membership)
        return _Result(None)


def test_ws_wrong_tenant_is_rejected():
    user_id = uuid.uuid4()
    bad_project = uuid.uuid4()
    user = User(id=user_id, email="tenant@example.com", hashed_password="x", is_active=True)
    membership = None
    token = create_access_token(subject=str(user_id))
    db = _FakeDb(user, membership)

    async def _fake_db():
        yield db

    app.dependency_overrides[deps.get_db] = _fake_db
    try:
        with TestClient(app) as client:
            with pytest.raises(WebSocketDisconnect):
                with client.websocket_connect(f"/ws/agents/{bad_project}") as ws:
                    ws.send_text(f'{{"type":"auth","token":"{token}"}}')
                    ws.send_text("{\"type\":\"ping\"}")
                    ws.receive_json()
    finally:
        app.dependency_overrides.clear()

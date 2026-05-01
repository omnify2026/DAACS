from __future__ import annotations

import uuid

from fastapi.testclient import TestClient

from daacs.core import deps
from daacs.routes import agents
from daacs.server import app


async def _fake_project_access():
    return uuid.uuid4()


def test_agent_history_endpoint_returns_persisted_rows(monkeypatch):
    project_id = str(uuid.uuid4())
    captured = {}

    async def _fake_load_task_history(_project_id: str, agent_role: str, limit: int):
        captured["project_id"] = _project_id
        captured["agent_role"] = agent_role
        captured["limit"] = limit
        return [
            {
                "id": str(uuid.uuid4()),
                "project_id": _project_id,
                "agent_role": agent_role,
                "description": "build feature",
                "status": "completed",
                "result": {"ok": True},
            }
        ]

    monkeypatch.setattr(agents, "load_task_history", _fake_load_task_history)
    app.dependency_overrides[deps.require_project_access] = _fake_project_access
    try:
        with TestClient(app) as client:
            res = client.get(f"/api/agents/{project_id}/developer/history?limit=25")
            assert res.status_code == 200
            body = res.json()
            assert len(body) == 1
            assert body[0]["status"] == "completed"
            assert captured["agent_role"] == "developer"
            assert captured["limit"] == 25
    finally:
        app.dependency_overrides.clear()


def test_agent_events_endpoint_supports_type_filter(monkeypatch):
    project_id = str(uuid.uuid4())
    captured = {}

    async def _fake_load_agent_events(_project_id: str, agent_role: str, event_type: str | None, limit: int):
        captured["project_id"] = _project_id
        captured["agent_role"] = agent_role
        captured["event_type"] = event_type
        captured["limit"] = limit
        return [
            {
                "id": str(uuid.uuid4()),
                "project_id": _project_id,
                "agent_role": agent_role,
                "event_type": event_type or "error",
                "data": {"error": "boom"},
            }
        ]

    monkeypatch.setattr(agents, "load_agent_events", _fake_load_agent_events)
    app.dependency_overrides[deps.require_project_access] = _fake_project_access
    try:
        with TestClient(app) as client:
            res = client.get(f"/api/agents/{project_id}/developer/events?event_type=error&limit=10")
            assert res.status_code == 200
            body = res.json()
            assert len(body) == 1
            assert body[0]["event_type"] == "error"
            assert captured["event_type"] == "error"
            assert captured["limit"] == 10
    finally:
        app.dependency_overrides.clear()


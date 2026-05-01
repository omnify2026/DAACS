from __future__ import annotations

import uuid

from fastapi.testclient import TestClient

from daacs.core import deps, distributed_runtime
from daacs.routes import agents, teams
from daacs.server import app


async def _fake_project_access():
    return uuid.uuid4()


class _FakeManager:
    def __init__(self, project_id: str, event_broadcaster=None):
        self.project_id = project_id
        self.agent_server = None

    def set_llm_overrides(self, _overrides):
        return None

    def clock_in(self):
        return None

    async def start_server(self, *args, **kwargs):
        return None

    def get_all_states(self):
        return [
            {
                "role": "developer",
                "status": "idle",
                "current_task": None,
                "message": None,
                "position": {"x": 1, "y": 1},
            }
        ]


class _FakeDb:
    async def scalar(self, _statement):
        return None


async def _fake_db():
    yield _FakeDb()


def test_regression_clockin_clockout_and_team_task(monkeypatch):
    project_id = str(uuid.uuid4())

    async def _fake_register(_project_id: str, _manager):
        return distributed_runtime.instance_id()

    async def _fake_manager_action(project_id: str, action: str, args=None, timeout_seconds=15.0):
        if action == "has_manager":
            raise KeyError("missing")
        if action == "submit_team_task":
            return {"developer": "task-dev-1"}
        if action == "clock_out":
            return {"status": "clocked_out", "project_id": project_id}
        return {}

    monkeypatch.setattr(agents, "AgentManager", _FakeManager)
    monkeypatch.setattr(agents, "register_manager_with_ownership", _fake_register)
    monkeypatch.setattr(agents, "manager_action", _fake_manager_action)
    monkeypatch.setattr(teams, "manager_action", _fake_manager_action)

    app.dependency_overrides[deps.require_project_access] = _fake_project_access
    app.dependency_overrides[deps.get_db] = _fake_db
    try:
        with TestClient(app) as client:
            clock_in = client.post(f"/api/projects/{project_id}/clock-in")
            assert clock_in.status_code == 200

            team_task = client.post(
                f"/api/teams/{project_id}/task",
                json={"team": "development_team", "instruction": "run"},
            )
            assert team_task.status_code == 200

            clock_out = client.post(f"/api/projects/{project_id}/clock-out")
            assert clock_out.status_code == 200
    finally:
        app.dependency_overrides.clear()

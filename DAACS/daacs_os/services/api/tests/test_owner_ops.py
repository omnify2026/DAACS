from __future__ import annotations

import uuid

from fastapi.testclient import TestClient

from daacs.core import deps
from daacs.routes import owner_ops
from daacs.server import app


async def _fake_project_access():
    return uuid.uuid4()


def _fake_user():
    return type("U", (), {"id": uuid.uuid4(), "email": "owner@example.com"})()


def test_owner_ops_submit_and_list_decision():
    project_id = str(uuid.uuid4())
    app.dependency_overrides[deps.require_project_access] = _fake_project_access
    app.dependency_overrides[deps.get_current_user] = _fake_user

    try:
        with TestClient(app) as client:
            submit = client.post(
                f"/api/ops/{project_id}/decisions",
                json={
                    "item_id": "workflow-feature",
                    "title": "Feature workflow direction",
                    "source": "Workflow",
                    "action": "approved",
                    "target_type": "workflow",
                    "target_id": "workflow-feature",
                    "detail": "Proceed with current execution path",
                },
            )
            assert submit.status_code == 200
            payload = submit.json()
            assert payload["project_id"] == project_id
            assert payload["action"] == "approved"
            assert payload["decided_by"] == "owner@example.com"
            assert payload["target_type"] == "workflow"

            listing = client.get(f"/api/ops/{project_id}/decisions")
            assert listing.status_code == 200
            items = listing.json()["items"]
            assert len(items) >= 1
            assert items[-1]["item_id"] == "workflow-feature"

            status = client.get(f"/api/ops/{project_id}/status")
            assert status.status_code == 200
            status_body = status.json()
            assert status_body["project_id"] == project_id
            assert "team_runs" in status_body
            assert "incidents" in status_body
    finally:
        app.dependency_overrides.clear()


def test_owner_ops_hold_applies_workflow_pause(monkeypatch):
    project_id = str(uuid.uuid4())
    workflow_id = str(uuid.uuid4())
    app.dependency_overrides[deps.require_project_access] = _fake_project_access
    app.dependency_overrides[deps.get_current_user] = _fake_user

    called: dict[str, str] = {}

    async def _fake_apply_workflow(_project_id: str, _workflow_id: str, _action: str):
        called["status"] = "paused"
        return "workflow_paused"

    monkeypatch.setattr(owner_ops, "_apply_workflow_decision", _fake_apply_workflow)

    try:
        with TestClient(app) as client:
            submit = client.post(
                f"/api/ops/{project_id}/decisions",
                json={
                    "item_id": "workflow-feature",
                    "title": "Feature workflow direction",
                    "source": "Workflow",
                    "action": "hold",
                    "target_type": "workflow",
                    "target_id": workflow_id,
                    "workflow_id": workflow_id,
                    "detail": "Pause and reassess",
                },
            )
            assert submit.status_code == 200
            payload = submit.json()
            assert payload["workflow_id"] == workflow_id
            assert payload["applied_effect"] == "workflow_paused"
            assert called["status"] == "paused"
    finally:
        app.dependency_overrides.clear()


def test_owner_ops_incident_and_team_run_targets():
    project_id = str(uuid.uuid4())
    app.dependency_overrides[deps.require_project_access] = _fake_project_access
    app.dependency_overrides[deps.get_current_user] = _fake_user
    try:
        with TestClient(app) as client:
            incident = client.post(
                f"/api/ops/{project_id}/decisions",
                json={
                    "item_id": "incident-1",
                    "title": "Error spike",
                    "source": "Ops",
                    "action": "rejected",
                    "target_type": "incident",
                    "target_id": "incident-1",
                },
            )
            assert incident.status_code == 200
            assert incident.json()["applied_effect"] == "incident_escalated"

            team_run = client.post(
                f"/api/ops/{project_id}/decisions",
                json={
                    "item_id": "team-run-active",
                    "title": "Parallel team run",
                    "source": "TeamRun",
                    "action": "hold",
                    "target_type": "team_run",
                    "target_id": "team-run-active",
                },
            )
            assert team_run.status_code == 200
            assert team_run.json()["applied_effect"] == "team_run_paused"

            status = client.get(f"/api/ops/{project_id}/status")
            assert status.status_code == 200
            state = status.json()
            assert state["incidents"]["incident-1"] == "escalated"
            assert state["team_runs"]["team-run-active"] == "paused"
    finally:
        app.dependency_overrides.clear()


def test_owner_ops_workflow_approved_uses_saved_context(monkeypatch):
    project_id = str(uuid.uuid4())
    workflow_id = str(uuid.uuid4())
    app.dependency_overrides[deps.require_project_access] = _fake_project_access
    app.dependency_overrides[deps.get_current_user] = _fake_user
    called: dict[str, object] = {}

    async def _fake_load_workflow(_project_id: str, _workflow_id: str):
        return {
            "id": workflow_id,
            "project_id": project_id,
            "workflow_name": "feature_development",
            "goal": "Use preserved goal",
            "params": {"max_iterations": 3},
            "status": "paused",
        }

    async def _fake_resume(**kwargs):
        called["workflow_name"] = kwargs["workflow_name"]
        called["goal"] = kwargs["goal"]
        called["params"] = kwargs["params"]
        return "workflow_resumed"

    monkeypatch.setattr(owner_ops, "load_workflow_from_db", _fake_load_workflow)
    monkeypatch.setattr(owner_ops, "_resume_workflow", _fake_resume)

    try:
        with TestClient(app) as client:
            submit = client.post(
                f"/api/ops/{project_id}/decisions",
                json={
                    "item_id": "wf-resume",
                    "title": "Resume workflow",
                    "source": "Workflow",
                    "action": "approved",
                    "target_type": "workflow",
                    "target_id": workflow_id,
                    "workflow_id": workflow_id,
                },
            )
            assert submit.status_code == 200
            payload = submit.json()
            assert payload["applied_effect"] == "workflow_resumed"
            assert called["workflow_name"] == "feature_development"
            assert called["goal"] == "Use preserved goal"
            assert called["params"] == {"max_iterations": 3}
    finally:
        app.dependency_overrides.clear()

from __future__ import annotations

import uuid

from fastapi.testclient import TestClient

from daacs.core import deps
from daacs.routes import workflows
from daacs.server import app


async def _fake_project_access():
    return uuid.uuid4()


async def _runtime_exists(_project_id: str) -> bool:
    return True


def test_start_workflow_registers_running_item(monkeypatch):
    project_id = str(uuid.uuid4())
    persisted = {}

    async def _fake_start_workflow_distributed(project_id: str, workflow_name: str, goal: str, params=None):
        workflow_id = str(uuid.uuid4())
        persisted[workflow_id] = {
            "id": workflow_id,
            "project_id": project_id,
            "workflow_name": workflow_name,
            "goal": goal,
            "params": params or {},
            "status": "running",
            "current_step": 0,
            "total_steps": 0,
            "steps": [],
        }
        return {
            "status": "started",
            "project_id": project_id,
            "workflow_id": workflow_id,
            "workflow_name": workflow_name,
            "goal": goal,
        }

    async def _load_list(project_id: str):
        return [wf for wf in persisted.values() if wf["project_id"] == project_id]

    monkeypatch.setattr(workflows, "ensure_project_runtime_exists", _runtime_exists)
    monkeypatch.setattr(workflows, "start_workflow_distributed", _fake_start_workflow_distributed)
    monkeypatch.setattr(workflows, "load_workflows_for_project_from_db", _load_list)

    app.dependency_overrides[deps.require_project_access] = _fake_project_access
    try:
        with TestClient(app) as client:
            start = client.post(
                f"/api/workflows/{project_id}/start",
                json={"workflow_name": "feature_development"},
            )
            assert start.status_code == 200
            body = start.json()
            assert body["status"] == "started"

            listing = client.get(f"/api/workflows/{project_id}")
            assert listing.status_code == 200
            data = listing.json()
            assert len(data) == 1
            assert data[0]["workflow_name"] == "feature_development"
    finally:
        app.dependency_overrides.clear()


def test_start_workflow_conflict_returns_409(monkeypatch):
    project_id = str(uuid.uuid4())

    async def _fake_start_workflow_distributed(project_id: str, workflow_name: str, goal: str, params=None):
        raise workflows.WorkflowConflictError("workflow_conflict:active:wf-123:running")

    monkeypatch.setattr(workflows, "ensure_project_runtime_exists", _runtime_exists)
    monkeypatch.setattr(workflows, "start_workflow_distributed", _fake_start_workflow_distributed)

    app.dependency_overrides[deps.require_project_access] = _fake_project_access
    try:
        with TestClient(app) as client:
            res = client.post(
                f"/api/workflows/{project_id}/start",
                json={"workflow_name": "feature_development"},
            )
            assert res.status_code == 409
            body = res.json()
            assert "already active" in body["detail"]
            assert "wf-123" in body["detail"]
    finally:
        app.dependency_overrides.clear()


def test_stop_workflow_not_found(monkeypatch):
    project_id = str(uuid.uuid4())

    async def _load_missing(_project_id: str, _workflow_id: str):
        return None

    monkeypatch.setattr(workflows, "ensure_project_runtime_exists", _runtime_exists)
    monkeypatch.setattr(workflows, "load_workflow_from_db", _load_missing)

    app.dependency_overrides[deps.require_project_access] = _fake_project_access
    try:
        with TestClient(app) as client:
            res = client.post(f"/api/workflows/{project_id}/missing/stop")
        assert res.status_code == 404
    finally:
        app.dependency_overrides.clear()


def test_stop_workflow_keyerror_maps_to_404(monkeypatch):
    project_id = str(uuid.uuid4())
    workflow_id = str(uuid.uuid4())

    async def _load_existing(_project_id: str, _workflow_id: str):
        return {"id": _workflow_id, "status": "running"}

    async def _fake_stop(_project_id: str, _workflow_id: str):
        raise KeyError("missing")

    monkeypatch.setattr(workflows, "ensure_project_runtime_exists", _runtime_exists)
    monkeypatch.setattr(workflows, "load_workflow_from_db", _load_existing)
    monkeypatch.setattr(workflows, "stop_workflow_distributed", _fake_stop)

    app.dependency_overrides[deps.require_project_access] = _fake_project_access
    try:
        with TestClient(app) as client:
            res = client.post(f"/api/workflows/{project_id}/{workflow_id}/stop")
            assert res.status_code == 404
    finally:
        app.dependency_overrides.clear()


def test_start_workflow_request_params_are_not_shared():
    left = workflows.StartWorkflowRequest()
    right = workflows.StartWorkflowRequest()

    left.params["custom"] = True

    assert "custom" not in right.params

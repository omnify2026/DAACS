from __future__ import annotations

import time

from fastapi.testclient import TestClient

import daacs.api as daacs_api
from daacs.orchestrator.core import DAACSOrchestrator
import daacs.server_runtime as server_runtime


def test_project_lifecycle_e2e(tmp_path, monkeypatch):
    daacs_api.projects.clear()
    client = TestClient(daacs_api.app)

    monkeypatch.chdir(tmp_path)

    def fake_run(self, goal):
        return {"final_status": "completed", "needs_rework": False, "stop_reason": None}

    monkeypatch.setattr(DAACSOrchestrator, "run", fake_run, raising=True)
    monkeypatch.setattr(server_runtime, "run_servers_sync", lambda _project_id: None)
    monkeypatch.setattr(
        server_runtime,
        "compute_release_gate",
        lambda *args, **kwargs: {
            "status": "pass",
            "auto_ok": True,
            "fullstack_required": False,
            "manual_gates": [],
            "results": {},
        },
        raising=True,
    )

    res = client.post("/api/projects", json={"goal": "e2e flow", "config": {}})
    assert res.status_code == 200
    project_id = res.json()["id"]

    res = client.post(f"/api/projects/{project_id}/run")
    assert res.status_code == 200

    status = None
    for _ in range(40):
        res = client.get(f"/api/projects/{project_id}")
        assert res.status_code == 200
        status = res.json().get("status")
        if status == "completed":
            break
        time.sleep(0.05)

    assert status == "completed"

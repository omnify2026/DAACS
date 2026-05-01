from __future__ import annotations

from types import SimpleNamespace
from pathlib import Path

import pytest

from daacs.application import workflow_service


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _expected_steps():
    return [
        {
            "id": "handoff-1",
            "title": "pm:plan",
            "node": "plan",
            "role": "pm",
            "status": "done",
            "iteration": 0,
        },
        {
            "id": "handoff-2",
            "title": "reviewer:review",
            "node": "review",
            "role": "reviewer",
            "status": "done",
            "iteration": 0,
        },
    ]


def _expected_steps_with_verification():
    return [
        {
            "id": "handoff-1",
            "title": "pm:plan",
            "node": "plan",
            "role": "pm",
            "status": "done",
            "iteration": 0,
        },
        {
            "id": "handoff-2",
            "title": "verifier:verification",
            "node": "verification",
            "role": "verifier",
            "status": "done",
            "iteration": 0,
            "qa_profile": "ui",
            "verification_confidence": 78,
            "verification_gaps": ["Missing required evidence: api_compliance"],
        },
    ]


def test_sanitize_project_cwd_accepts_git_checkout_root(monkeypatch, tmp_path):
    repo_root = tmp_path / "omnify"
    nested_root = repo_root / "DAACS_OS"
    api_cwd = nested_root / "services" / "api"
    allowed_workspace = repo_root / "frontend"

    (repo_root / ".git").mkdir(parents=True)
    api_cwd.mkdir(parents=True)
    allowed_workspace.mkdir(parents=True)

    monkeypatch.setattr(
        workflow_service,
        "__file__",
        str(nested_root / "services" / "api" / "daacs" / "application" / "workflow_service.py"),
    )
    monkeypatch.chdir(api_cwd)

    resolved = workflow_service.sanitize_project_cwd(str(allowed_workspace))

    assert resolved == str(allowed_workspace.resolve())


@pytest.mark.anyio
async def test_start_workflow_persists_handoff_steps(monkeypatch):
    project_id = "proj-start"
    captured_task = {}
    status_calls = []

    async def _no_active_workflow(_project_id: str):
        return None

    async def _persist_started(**_kwargs):
        return None

    async def _persist_status(workflow_id: str, status: str, steps=None):
        status_calls.append((workflow_id, status, steps))

    class _FakeEngine:
        def __init__(self, **_kwargs):
            pass

        async def run(self, **_kwargs):
            return {
                "final_status": "completed",
                "handoff_history": [
                    {"node": "plan", "role": "pm", "iteration": 0},
                    {"node": "review", "role": "reviewer", "iteration": 0},
                ],
            }

    monkeypatch.setattr(workflow_service, "get_manager", lambda _project_id: SimpleNamespace(llm_overrides={}))
    monkeypatch.setattr(workflow_service, "load_active_workflow_for_project_from_db", _no_active_workflow)
    monkeypatch.setattr(workflow_service, "persist_workflow_started", _persist_started)
    monkeypatch.setattr(workflow_service, "persist_workflow_status", _persist_status)
    monkeypatch.setattr(workflow_service, "WorkflowEngine", _FakeEngine)
    monkeypatch.setattr(workflow_service, "LLMExecutor", lambda **_kwargs: object())
    monkeypatch.setattr(
        workflow_service,
        "set_workflow_task",
        lambda workflow_id, task: captured_task.update({"workflow_id": workflow_id, "task": task}),
    )

    result = await workflow_service._start_workflow_local(
        project_id=project_id,
        workflow_name="feature_development",
        goal="Ship the feature",
        params={},
    )

    await captured_task["task"]

    assert result["status"] == "started"
    assert status_calls == [
        (
            result["workflow_id"],
            "completed",
            _expected_steps(),
        )
    ]


@pytest.mark.anyio
async def test_resume_workflow_persists_handoff_steps(monkeypatch):
    workflow_id = "wf-resume"
    captured_task = {}
    status_calls = []

    async def _load_workflow(_project_id: str, _workflow_id: str):
        return {
            "id": workflow_id,
            "workflow_name": "feature_development",
            "goal": "Existing goal",
            "params": {"existing": True},
            "status": "paused",
        }

    async def _persist_status(workflow_id: str, status: str, steps=None):
        status_calls.append((workflow_id, status, steps))

    class _FakeEngine:
        def __init__(self, **_kwargs):
            pass

        async def run(self, **_kwargs):
            return {
                "final_status": "completed",
                "handoff_history": [
                    {"node": "plan", "role": "pm", "iteration": 0},
                    {"node": "review", "role": "reviewer", "iteration": 0},
                ],
            }

    monkeypatch.setattr(workflow_service, "get_manager", lambda _project_id: SimpleNamespace(llm_overrides={}))
    monkeypatch.setattr(workflow_service, "load_workflow_from_db", _load_workflow)
    monkeypatch.setattr(workflow_service, "persist_workflow_status", _persist_status)
    monkeypatch.setattr(workflow_service, "WorkflowEngine", _FakeEngine)
    monkeypatch.setattr(workflow_service, "LLMExecutor", lambda **_kwargs: object())
    monkeypatch.setattr(workflow_service, "get_workflow_task", lambda _workflow_id: None)
    monkeypatch.setattr(
        workflow_service,
        "set_workflow_task",
        lambda workflow_id, task: captured_task.update({"workflow_id": workflow_id, "task": task}),
    )

    result = await workflow_service._resume_workflow_local(
        project_id="proj-resume",
        workflow_id=workflow_id,
        workflow_name="",
        goal="",
        params={"new": True},
    )

    await captured_task["task"]

    assert result == "workflow_resumed"
    assert status_calls == [
        (workflow_id, "running", None),
        (workflow_id, "completed", _expected_steps()),
    ]


@pytest.mark.anyio
async def test_workflow_steps_include_verification_qa_metadata(monkeypatch):
    project_id = "proj-qa-step"
    captured_task = {}
    status_calls = []

    async def _no_active_workflow(_project_id: str):
        return None

    async def _persist_started(**_kwargs):
        return None

    async def _persist_status(workflow_id: str, status: str, steps=None):
        status_calls.append((workflow_id, status, steps))

    class _FakeEngine:
        def __init__(self, **_kwargs):
            pass

        async def run(self, **_kwargs):
            return {
                "final_status": "completed",
                "handoff_history": [
                    {"node": "plan", "role": "pm", "iteration": 0},
                    {"node": "verification", "role": "verifier", "iteration": 0},
                ],
                "qa_profile": "ui",
                "verification_confidence": 78,
                "verification_gaps": ["Missing required evidence: api_compliance"],
            }

    monkeypatch.setattr(workflow_service, "get_manager", lambda _project_id: SimpleNamespace(llm_overrides={}))
    monkeypatch.setattr(workflow_service, "load_active_workflow_for_project_from_db", _no_active_workflow)
    monkeypatch.setattr(workflow_service, "persist_workflow_started", _persist_started)
    monkeypatch.setattr(workflow_service, "persist_workflow_status", _persist_status)
    monkeypatch.setattr(workflow_service, "WorkflowEngine", _FakeEngine)
    monkeypatch.setattr(workflow_service, "LLMExecutor", lambda **_kwargs: object())
    monkeypatch.setattr(
        workflow_service,
        "set_workflow_task",
        lambda workflow_id, task: captured_task.update({"workflow_id": workflow_id, "task": task}),
    )

    result = await workflow_service._start_workflow_local(
        project_id=project_id,
        workflow_name="feature_development",
        goal="Ship the feature",
        params={},
    )

    await captured_task["task"]

    assert status_calls == [
        (
            result["workflow_id"],
            "completed",
            _expected_steps_with_verification(),
        )
    ]

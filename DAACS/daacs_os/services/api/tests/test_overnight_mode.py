from __future__ import annotations

import uuid
from pathlib import Path

from fastapi.testclient import TestClient
import pytest

from daacs.core import deps
from daacs.graph.engine import WorkflowEngine
from daacs.llm.executor import LLMExecutor
from daacs.overnight import BudgetExceededError
from daacs.overnight.verification_gates import GateVerdict, OvernightVerificationRunner, VerificationProfile
from daacs.routes import overnight
from daacs.server import app


class _FakeProvider:
    def __init__(self):
        self.calls = 0
        self.timeout_sec = 10

    async def invoke(self, prompt: str, system_prompt: str = "") -> str:
        self.calls += 1
        if self.calls < 3:
            raise TimeoutError("transient timeout")
        return "ok"

    def get_model_name(self) -> str:
        return "gpt-4o"


class _NoopSpendGuard:
    def check_or_raise(self, estimated_cost: float = 0.0):
        return None

    async def record(self, **kwargs):
        return None


class _NoopTurnGuard:
    def check_turn(self, role: str, task_id: str):
        return None

    def record_error(self, role: str, task_id: str, error_msg: str):
        return None

    def record_api_call(self, role: str, task_id: str):
        return None


async def _fake_project_access():
    return uuid.uuid4()


def test_executor_invoke_with_retry(monkeypatch):
    provider = _FakeProvider()
    executor = LLMExecutor(
        project_id="proj-retry",
        spend_guard=_NoopSpendGuard(),
        turn_guard=_NoopTurnGuard(),
    )
    monkeypatch.setattr(executor, "_get_provider", lambda role: provider)

    async def _sleep(_delay: float):
        return None

    monkeypatch.setattr("daacs.llm.executor.asyncio.sleep", _sleep)

    import asyncio

    result = asyncio.run(executor.execute(role="developer", prompt="hello", system_prompt="sys"))
    assert result == "ok"
    assert provider.calls == 3
    # timeout escalation applied on transient timeouts
    assert provider.timeout_sec >= 15


class _FakeResult:
    def __init__(self, task_id: str):
        self.id = task_id


class _FakeCeleryClient:
    def __init__(self):
        self.calls: list[dict] = []

    def send_task(self, name: str, kwargs=None, **opts):
        self.calls.append({"name": name, "kwargs": kwargs or {}, "opts": opts})
        return _FakeResult("task-eta-1")


def test_overnight_start_respects_start_at_eta(monkeypatch):
    project_id = str(uuid.uuid4())
    fake_client = _FakeCeleryClient()
    persisted: dict[str, dict] = {}

    async def _fake_ensure_runtime(_project_id: str) -> bool:
        return True

    monkeypatch.setattr(overnight, "ensure_project_runtime_exists", _fake_ensure_runtime)
    monkeypatch.setattr(overnight, "_celery_client", lambda: fake_client)

    async def _persist_started(workflow_id, project_id, workflow_name, goal, params=None):
        persisted[workflow_id] = {
            "id": workflow_id,
            "project_id": project_id,
            "workflow_name": workflow_name,
            "goal": goal,
            "params": params or {},
            "status": "queued",
            "overnight_config": {},
        }

    async def _update_fields(workflow_id: str, fields: dict):
        persisted.setdefault(workflow_id, {}).update(fields)

    monkeypatch.setattr(overnight, "persist_workflow_started", _persist_started)
    monkeypatch.setattr(overnight, "update_workflow_fields", _update_fields)

    app.dependency_overrides[deps.require_project_access] = _fake_project_access
    try:
        with TestClient(app) as client:
            res = client.post(
                f"/api/workflows/{project_id}/overnight",
                json={
                    "goal": "night build",
                    "start_at": "2099-01-01T00:00:00Z",
                },
            )
            assert res.status_code == 200, res.text
            body = res.json()
            assert body["status"] == "started"
            assert len(fake_client.calls) == 1
            call = fake_client.calls[0]
            assert call["name"] == "daacs.worker.tasks.workflow.run"
            assert "eta" in call["opts"]
    finally:
        app.dependency_overrides.clear()


def test_overnight_start_rejects_when_active_workflow_exists(monkeypatch):
    project_id = str(uuid.uuid4())

    async def _fake_ensure_runtime(_project_id: str) -> bool:
        return True

    async def _active_workflow(_project_id: str):
        return {"id": "wf-active-1", "status": "running"}

    monkeypatch.setattr(overnight, "ensure_project_runtime_exists", _fake_ensure_runtime)
    monkeypatch.setattr(overnight, "load_active_workflow_for_project_from_db", _active_workflow)

    app.dependency_overrides[deps.require_project_access] = _fake_project_access
    try:
        with TestClient(app) as client:
            res = client.post(
                f"/api/workflows/{project_id}/overnight",
                json={"goal": "night build"},
            )
            assert res.status_code == 409
            assert "already active" in res.json()["detail"]
    finally:
        app.dependency_overrides.clear()


class _FakeLlmEvaluator:
    async def execute(self, role: str, prompt: str, system_prompt: str = "", context=None):
        return '{"passed": false, "missing": ["integration test"], "reason": "missing integration test evidence"}'


def test_overnight_profiles_include_explicit_backend_auth_surfaces():
    default_gates = OvernightVerificationRunner._PROFILE_GATES[VerificationProfile.DEFAULT]
    strict_gates = OvernightVerificationRunner._PROFILE_GATES[VerificationProfile.STRICT]

    for gate_id in ("auth_surface", "byok_surface", "ws_auth_surface"):
        assert gate_id in default_gates
        assert gate_id in strict_gates
        assert OvernightVerificationRunner._HARD_DEFAULT[gate_id] is False


def test_overnight_explicit_backend_auth_surface_commands_are_scoped():
    assert OvernightVerificationRunner._API_SURFACE_TEST_ARGS == {
        "auth_surface": ("-m", "pytest", "-q", "tests/test_auth.py"),
        "byok_surface": ("-m", "pytest", "-q", "tests/test_byok_key_handling.py"),
        "ws_auth_surface": ("-m", "pytest", "-q", "tests/test_ws_auth.py"),
    }


def test_overnight_builds_backend_commands_from_local_venv(tmp_path):
    api_python = tmp_path / "services" / "api" / ".venv312" / "bin" / "python"
    api_python.parent.mkdir(parents=True)
    api_python.write_text("", encoding="utf-8")
    runner = OvernightVerificationRunner(workspace_dir=str(tmp_path))

    command = runner._build_api_python_command("-m", "pytest", "-q", "tests/test_auth.py")

    assert command == f"{api_python} -m pytest -q tests/test_auth.py"


def test_dod_eval_uses_llm_evaluator():
    import asyncio

    runner = OvernightVerificationRunner(
        workspace_dir=".",
        llm_executor=_FakeLlmEvaluator(),
    )
    state = {
        "logs": ["build passed", "lint passed", "tests passed"],
        "backend_files": {"a.py": "print(1)"},
        "frontend_files": {},
        "code_review_score": 9,
        "code_fingerprint": "abc",
    }
    results = asyncio.run(
        runner.run(
            profile="strict",
            state=state,
            definition_of_done=["integration test"],
            quality_threshold=7,
        )
    )
    dod_gate = next(r for r in results if r.gate_id == "dod_eval")
    assert dod_gate.verdict == GateVerdict.FAIL_RECOVERABLE
    assert "missing integration test evidence" in dod_gate.detail


def test_workflow_run_task_allows_retries():
    source = Path(__file__).resolve()
    candidates = [
        source.parents[1] / "worker" / "tasks" / "celery_app.py",
        Path("/app/services/worker/tasks/celery_app.py"),
    ]
    if len(source.parents) > 3:
        candidates.append(source.parents[3] / "services" / "worker" / "tasks" / "celery_app.py")
    worker_file = next((path for path in candidates if path.is_file()), None)
    if worker_file is None:
        pytest.skip("worker task source is not present in this test image")

    content = worker_file.read_text(encoding="utf-8")
    assert "@app.task(name=\"daacs.worker.tasks.workflow.run\", bind=True, max_retries=3)" in content


def test_engine_budget_exceeded_maps_to_stopped_with_report(monkeypatch):
    import asyncio
    import daacs.graph.engine as engine_module

    monkeypatch.setattr(engine_module, "get_engine", lambda: None)
    monkeypatch.setattr(engine_module, "async_sessionmaker", lambda *args, **kwargs: (lambda: None))

    async def _plan_node(*_args, **_kwargs):
        raise BudgetExceededError(run_id="r1", spent=5.1, cap=5.0, estimated=0.2)

    engine = WorkflowEngine(project_id="proj-budget", llm_executor=None, agent_manager=None)
    engine._nodes = {
        "plan": _plan_node,
        "execute_backend": _plan_node,
        "execute_frontend": _plan_node,
        "judge": _plan_node,
        "replan": _plan_node,
        "verify": _plan_node,
    }
    result = asyncio.run(
        engine.run(
            goal="budget path",
            params={"overnight_mode": True, "run_id": "", "max_iterations": 1},
            config={"constraints": {"max_spend_usd": 5.0}},
        )
    )
    assert result["final_status"] == "stopped_with_report"
    assert result["stop_reason"] == "budget_exceeded"


def test_engine_time_exceeded_maps_to_stopped_with_report(monkeypatch):
    import asyncio
    import daacs.graph.engine as engine_module

    monkeypatch.setattr(engine_module, "get_engine", lambda: None)
    monkeypatch.setattr(engine_module, "async_sessionmaker", lambda *args, **kwargs: (lambda: None))

    async def _plan_node(*_args, **_kwargs):
        return {}

    engine = WorkflowEngine(project_id="proj-time", llm_executor=None, agent_manager=None)
    engine._nodes = {
        "plan": _plan_node,
        "execute_backend": _plan_node,
        "execute_frontend": _plan_node,
        "judge": _plan_node,
        "replan": _plan_node,
        "verify": _plan_node,
    }
    result = asyncio.run(
        engine.run(
            goal="time path",
            params={"overnight_mode": True, "run_id": "", "max_iterations": 1},
            config={
                "deadline_at": "2000-01-01T00:00:00+00:00",
                "constraints": {"max_runtime_minutes": 1},
            },
        )
    )
    assert result["final_status"] == "stopped_with_report"
    assert result["stop_reason"] == "deadline_exceeded"

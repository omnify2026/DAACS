from __future__ import annotations

import asyncio

from daacs.graph.engine import WorkflowEngine


def _stub_runtime(monkeypatch):
    import daacs.graph.engine as engine_module

    monkeypatch.setattr(engine_module, "get_engine", lambda: None)
    monkeypatch.setattr(engine_module, "async_sessionmaker", lambda *args, **kwargs: (lambda: None))


def test_engine_skips_verification_when_verifier_not_active(monkeypatch):
    _stub_runtime(monkeypatch)
    calls: list[str] = []

    async def _plan(*_args, **_kwargs):
        calls.append("plan")
        return {
            "needs_backend": False,
            "needs_frontend": False,
            "active_roles": ["pm", "reviewer"],
            "orchestration_policy": {
                "execution_handoffs": [],
                "quality_handoffs": ["review"],
                "replan_handoff": "replanning",
            },
        }

    async def _review(*_args, **_kwargs):
        calls.append("review")
        return {"needs_rework": False, "code_review_score": 9}

    async def _verification(*_args, **_kwargs):
        calls.append("verification")
        raise AssertionError("verification should not run when verifier is not active")

    async def _replanning(*_args, **_kwargs):
        calls.append("replanning")
        return {}

    engine = WorkflowEngine(project_id="proj-skip-verify", llm_executor=None, agent_manager=None)
    engine._nodes = {
        "plan": _plan,
        "execute_backend": _plan,
        "execute_frontend": _plan,
        "review": _review,
        "replanning": _replanning,
        "verification": _verification,
    }

    result = asyncio.run(engine.run(goal="skip verifier path", params={"max_iterations": 1}))

    assert result["final_status"] == "completed"
    assert calls == ["plan", "review"]
    assert result["completed_handoffs"] == ["plan", "review"]


def test_engine_routes_verifier_failure_back_to_pm_replan(monkeypatch):
    _stub_runtime(monkeypatch)
    calls: list[str] = []

    async def _plan(*_args, **_kwargs):
        calls.append("plan")
        return {
            "needs_backend": False,
            "needs_frontend": False,
            "active_roles": ["pm", "reviewer", "verifier"],
            "orchestration_policy": {
                "execution_handoffs": [],
                "quality_handoffs": ["review", "verification"],
                "replan_handoff": "replanning",
            },
        }

    async def _review(*_args, **_kwargs):
        calls.append("review")
        return {"needs_rework": False, "code_review_score": 8}

    async def _verification(*_args, **_kwargs):
        calls.append("verification")
        return {
            "verification_passed": False,
            "verification_failures": ["Tests failed"],
        }

    async def _replanning(*_args, **_kwargs):
        calls.append("replanning")
        return {
            "needs_rework": False,
            "stop_reason": "handoff_replanned",
            "final_status": "stopped",
        }

    engine = WorkflowEngine(project_id="proj-verifier-replan", llm_executor=None, agent_manager=None)
    engine._nodes = {
        "plan": _plan,
        "execute_backend": _plan,
        "execute_frontend": _plan,
        "review": _review,
        "replanning": _replanning,
        "verification": _verification,
    }

    result = asyncio.run(engine.run(goal="verifier failure path", params={"max_iterations": 1}))

    assert result["final_status"] == "stopped"
    assert result["stop_reason"] == "handoff_replanned"
    assert calls == ["plan", "review", "verification", "replanning"]
    assert result["rework_source"] == "verifier"
    assert "Tests failed" in result["failure_summary"]


def test_engine_replans_on_low_verification_confidence(monkeypatch):
    _stub_runtime(monkeypatch)
    calls: list[str] = []

    async def _plan(*_args, **_kwargs):
        calls.append("plan")
        return {
            "needs_backend": False,
            "needs_frontend": False,
            "active_roles": ["pm", "reviewer", "verifier"],
            "qa_profile": "strict",
            "orchestration_policy": {
                "execution_handoffs": [],
                "quality_handoffs": ["review", "verification"],
                "replan_handoff": "replanning",
            },
        }

    async def _review(*_args, **_kwargs):
        calls.append("review")
        return {"needs_rework": False, "code_review_score": 9}

    async def _verification(*_args, **_kwargs):
        calls.append("verification")
        return {
            "verification_passed": True,
            "verification_failures": [],
            "verification_gaps": [],
            "verification_confidence": 50,
        }

    async def _replanning(*_args, **_kwargs):
        calls.append("replanning")
        return {
            "needs_rework": False,
            "stop_reason": "confidence_replanned",
            "final_status": "stopped",
        }

    engine = WorkflowEngine(project_id="proj-verifier-confidence", llm_executor=None, agent_manager=None)
    engine._nodes = {
        "plan": _plan,
        "execute_backend": _plan,
        "execute_frontend": _plan,
        "review": _review,
        "replanning": _replanning,
        "verification": _verification,
    }

    result = asyncio.run(engine.run(goal="confidence path", params={"max_iterations": 1}))

    assert result["final_status"] == "stopped"
    assert result["stop_reason"] == "confidence_replanned"
    assert calls == ["plan", "review", "verification", "replanning"]
    assert result["rework_source"] == "verifier"
    assert any("Verification confidence 50 is below threshold 85" in item for item in result["failure_summary"])

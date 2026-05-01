from __future__ import annotations

import uuid
from types import SimpleNamespace

from fastapi.testclient import TestClient

from daacs.core import deps
from daacs.routes import runtime
from daacs.server import app


class _FakeDb:
    async def scalar(self, _statement):
        return SimpleNamespace(name="Compat Runtime Project")


async def _fake_db():
    yield _FakeDb()


def test_runtime_compat_routes_support_runtime_plan_and_intent_flow(monkeypatch):
    project_uuid = uuid.uuid4()
    project_id = str(project_uuid)

    async def _fake_project_access():
        return project_uuid

    async def _fake_ensure_runtime(_project_id: str) -> bool:
        return True

    async def _fake_manager_action(project_id: str, action: str, args=None, timeout_seconds=15.0):
        if action == "get_all_states":
            return [
                {
                    "role": "pm",
                    "status": "idle",
                    "current_task": "Scope the latest request",
                },
                {
                    "role": "developer",
                    "status": "working",
                    "current_task": "Apply the requested change",
                },
                {
                    "role": "reviewer",
                    "status": "idle",
                    "current_task": None,
                },
                {
                    "role": "verifier",
                    "status": "idle",
                    "current_task": None,
                },
            ]
        raise AssertionError(f"unexpected manager action: {action}")

    runtime.RUNTIME_OVERRIDES.clear()
    runtime.PROJECT_PLANS.clear()
    runtime.PROJECT_EXECUTION_INTENTS.clear()

    monkeypatch.setattr(runtime, "ensure_project_runtime_exists", _fake_ensure_runtime)
    monkeypatch.setattr(runtime, "manager_action", _fake_manager_action)

    app.dependency_overrides[deps.require_project_access] = _fake_project_access
    app.dependency_overrides[deps.get_db] = _fake_db
    try:
        with TestClient(app) as client:
            runtime_response = client.get(f"/api/projects/{project_id}/runtime")
            assert runtime_response.status_code == 200
            runtime_bundle = runtime_response.json()
            assert runtime_bundle["runtime"]["project_id"] == project_id
            assert runtime_bundle["runtime"]["company_name"] == "Compat Runtime Project"
            assert len(runtime_bundle["instances"]) == len(runtime.SERVICE_ROLES)
            assert any(
                instance["instance_id"] == "agent-developer"
                and instance["runtime_status"] == "working"
                for instance in runtime_bundle["instances"]
            )

            empty_plans = client.get(f"/api/projects/{project_id}/plans")
            assert empty_plans.status_code == 200
            assert empty_plans.json() == []

            create_plan = client.post(
                f"/api/projects/{project_id}/plans",
                json={"goal": "Ship the user-visible runtime fix"},
            )
            assert create_plan.status_code == 200
            plan = create_plan.json()
            plan_id = plan["plan_id"]
            assert plan["status"] == "draft"
            assert len(plan["steps"]) == 4

            execute_plan = client.post(
                f"/api/projects/{project_id}/plans/{plan_id}/execute",
                json={"execution_track": "server"},
            )
            assert execute_plan.status_code == 200
            assert execute_plan.json()["status"] == "active"

            ready_steps = client.get(
                f"/api/projects/{project_id}/plans/{plan_id}/ready-steps"
            )
            assert ready_steps.status_code == 200
            ready = ready_steps.json()
            assert [step["step_id"] for step in ready] == ["step-pm-clarify"]

            complete_pm = client.post(
                f"/api/projects/{project_id}/plans/{plan_id}/steps/step-pm-clarify/complete",
                json={"output": {"summary": "scope locked"}, "status": "completed"},
            )
            assert complete_pm.status_code == 200
            assert complete_pm.json()["status"] == "active"

            ready_after_pm = client.get(
                f"/api/projects/{project_id}/plans/{plan_id}/ready-steps"
            ).json()
            assert [step["step_id"] for step in ready_after_pm] == ["step-dev-implement"]

            complete_dev = client.post(
                f"/api/projects/{project_id}/plans/{plan_id}/steps/step-dev-implement/complete",
                json={"output": {"summary": "implementation done"}, "status": "completed"},
            )
            assert complete_dev.status_code == 200
            review_plan = complete_dev.json()
            review_step = next(
                step for step in review_plan["steps"] if step["step_id"] == "step-review-quality"
            )
            assert review_step["status"] == "awaiting_approval"

            approve_review = client.post(
                f"/api/projects/{project_id}/plans/{plan_id}/steps/step-review-quality/approve",
                json={
                    "approver_id": "agent-ceo",
                    "note": "quality gate passed",
                    "execution_track": "server",
                },
            )
            assert approve_review.status_code == 200
            approved_plan = approve_review.json()
            verify_step = next(
                step for step in approved_plan["steps"] if step["step_id"] == "step-verify-e2e"
            )
            assert verify_step["status"] == "pending"

            ready_verify = client.get(
                f"/api/projects/{project_id}/plans/{plan_id}/ready-steps"
            ).json()
            assert [step["step_id"] for step in ready_verify] == ["step-verify-e2e"]

            complete_verify = client.post(
                f"/api/projects/{project_id}/plans/{plan_id}/steps/step-verify-e2e/complete",
                json={"output": {"summary": "e2e verified"}, "status": "completed"},
            )
            assert complete_verify.status_code == 200
            assert complete_verify.json()["status"] == "completed"

            empty_intents = client.get(f"/api/projects/{project_id}/execution-intents")
            assert empty_intents.status_code == 200
            assert empty_intents.json() == []

            create_intent = client.post(
                f"/api/projects/{project_id}/execution-intents",
                json={
                    "agent_id": "agent-reviewer",
                    "agent_role": "reviewer",
                    "kind": "run_ops_action",
                    "title": "Request a follow-up change",
                    "description": "Ask the project to revise the output after QA review.",
                    "target": "workspace://shared-board/latest",
                    "connector_id": "runtime_ops_connector",
                    "payload": {"reason": "qa-adjustment"},
                    "requires_approval": True,
                },
            )
            assert create_intent.status_code == 200
            intent = create_intent.json()
            intent_id = intent["intent_id"]
            assert intent["status"] == "pending_approval"

            approve_intent = client.post(
                f"/api/projects/{project_id}/execution-intents/{intent_id}/decision",
                json={"action": "approved", "note": "proceed"},
            )
            assert approve_intent.status_code == 200
            assert approve_intent.json()["status"] == "approved"

            complete_intent = client.post(
                f"/api/projects/{project_id}/execution-intents/{intent_id}/complete",
                json={
                    "status": "completed",
                    "result_summary": "change request accepted and queued",
                    "result_payload": {"queued": True},
                },
            )
            assert complete_intent.status_code == 200
            assert complete_intent.json()["status"] == "completed"

            listed_intents = client.get(f"/api/projects/{project_id}/execution-intents")
            assert listed_intents.status_code == 200
            rows = listed_intents.json()
            assert len(rows) == 1
            assert rows[0]["result_summary"] == "change request accepted and queued"
    finally:
        app.dependency_overrides.clear()


def test_runtime_plan_rejects_ready_and_completion_for_non_active_plans(monkeypatch):
    project_uuid = uuid.uuid4()
    project_id = str(project_uuid)

    async def _fake_project_access():
        return project_uuid

    async def _fake_ensure_runtime(_project_id: str) -> bool:
        return True

    runtime.RUNTIME_OVERRIDES.clear()
    runtime.PROJECT_PLANS.clear()
    runtime.PROJECT_EXECUTION_INTENTS.clear()

    monkeypatch.setattr(runtime, "ensure_project_runtime_exists", _fake_ensure_runtime)

    app.dependency_overrides[deps.require_project_access] = _fake_project_access
    app.dependency_overrides[deps.get_db] = _fake_db
    try:
        with TestClient(app) as client:
            plan = client.post(
                f"/api/projects/{project_id}/plans",
                json={"goal": "Reject closed and inactive readiness access"},
            ).json()
            plan_id = plan["plan_id"]

            draft_ready = client.get(f"/api/projects/{project_id}/plans/{plan_id}/ready-steps")
            assert draft_ready.status_code == 400
            assert draft_ready.json()["detail"] == "Plan is not active"

            draft_complete = client.post(
                f"/api/projects/{project_id}/plans/{plan_id}/steps/step-pm-clarify/complete",
                json={"output": {"summary": "too early"}, "status": "completed"},
            )
            assert draft_complete.status_code == 400
            assert draft_complete.json()["detail"] == "Plan is not active"

            store_plan = runtime.PROJECT_PLANS[project_id][plan_id]
            store_plan["status"] = "paused"

            paused_ready = client.get(f"/api/projects/{project_id}/plans/{plan_id}/ready-steps")
            assert paused_ready.status_code == 400
            assert paused_ready.json()["detail"] == "Plan is not active"

            paused_complete = client.post(
                f"/api/projects/{project_id}/plans/{plan_id}/steps/step-pm-clarify/complete",
                json={"output": {"summary": "still paused"}, "status": "completed"},
            )
            assert paused_complete.status_code == 400
            assert paused_complete.json()["detail"] == "Plan is not active"

            store_plan["status"] = "completed"

            closed_ready = client.get(f"/api/projects/{project_id}/plans/{plan_id}/ready-steps")
            assert closed_ready.status_code == 400
            assert closed_ready.json()["detail"] == "Plan is not active"

            closed_complete = client.post(
                f"/api/projects/{project_id}/plans/{plan_id}/steps/step-pm-clarify/complete",
                json={"output": {"summary": "too late"}, "status": "completed"},
            )
            assert closed_complete.status_code == 400
            assert closed_complete.json()["detail"] == "Plan is not active"

            store_plan["status"] = "failed"

            failed_ready = client.get(f"/api/projects/{project_id}/plans/{plan_id}/ready-steps")
            assert failed_ready.status_code == 400
            assert failed_ready.json()["detail"] == "Plan is not active"

            failed_complete = client.post(
                f"/api/projects/{project_id}/plans/{plan_id}/steps/step-pm-clarify/complete",
                json={"output": {"summary": "failed plan"}, "status": "completed"},
            )
            assert failed_complete.status_code == 400
            assert failed_complete.json()["detail"] == "Plan is not active"

            failed_complete = client.post(
                f"/api/projects/{project_id}/plans/{plan_id}/steps/step-pm-clarify/complete",
                json={"output": {"summary": "too late after failure"}, "status": "completed"},
            )
            assert failed_complete.status_code == 400
            assert failed_complete.json()["detail"] == "Plan is not active"
    finally:
        app.dependency_overrides.clear()


def test_runtime_plan_gate_rejects_blocked_dependency_and_wrong_approval_role(monkeypatch):
    project_uuid = uuid.uuid4()
    project_id = str(project_uuid)

    async def _fake_project_access():
        return project_uuid

    async def _fake_ensure_runtime(_project_id: str) -> bool:
        return True

    runtime.RUNTIME_OVERRIDES.clear()
    runtime.PROJECT_PLANS.clear()
    runtime.PROJECT_EXECUTION_INTENTS.clear()

    monkeypatch.setattr(runtime, "ensure_project_runtime_exists", _fake_ensure_runtime)

    app.dependency_overrides[deps.require_project_access] = _fake_project_access
    app.dependency_overrides[deps.get_db] = _fake_db
    try:
        with TestClient(app) as client:
            plan = client.post(
                f"/api/projects/{project_id}/plans",
                json={"goal": "Lock unsafe plan transitions"},
            ).json()
            plan_id = plan["plan_id"]
            client.post(
                f"/api/projects/{project_id}/plans/{plan_id}/execute",
                json={"execution_track": "server"},
            )

            blocked_complete = client.post(
                f"/api/projects/{project_id}/plans/{plan_id}/steps/step-review-quality/complete",
                json={"output": {"summary": "should not close"}, "status": "completed"},
            )
            assert blocked_complete.status_code == 400
            assert blocked_complete.json()["detail"] == "Step is not ready to complete"

            dependency_unsatisfied_complete = client.post(
                f"/api/projects/{project_id}/plans/{plan_id}/steps/step-dev-implement/complete",
                json={"output": {"summary": "dependency missing"}, "status": "completed"},
            )
            assert dependency_unsatisfied_complete.status_code == 400
            assert dependency_unsatisfied_complete.json()["detail"] == "Step dependencies are not satisfied"

            not_awaiting_approval = client.post(
                f"/api/projects/{project_id}/plans/{plan_id}/steps/step-pm-clarify/approve",
                json={"approver_id": "agent-ceo"},
            )
            assert not_awaiting_approval.status_code == 400
            assert not_awaiting_approval.json()["detail"] == "Step is not awaiting approval"

            client.post(
                f"/api/projects/{project_id}/plans/{plan_id}/steps/step-pm-clarify/complete",
                json={"output": {"summary": "scope done"}, "status": "completed"},
            )
            client.post(
                f"/api/projects/{project_id}/plans/{plan_id}/steps/step-dev-implement/complete",
                json={"output": {"summary": "implementation done"}, "status": "completed"},
            )

            wrong_approver = client.post(
                f"/api/projects/{project_id}/plans/{plan_id}/steps/step-review-quality/approve",
                json={"approver_id": "agent-reviewer"},
            )
            assert wrong_approver.status_code == 403
            assert wrong_approver.json()["detail"] == "Step is assigned to a different approver"

            missing_approver = client.post(
                f"/api/projects/{project_id}/plans/{plan_id}/steps/step-review-quality/approve",
                json={},
            )
            assert missing_approver.status_code == 400
            assert missing_approver.json()["detail"] == "Step requires an explicit approver"

            store_plan = runtime.PROJECT_PLANS[project_id][plan_id]
            review_step = next(
                step
                for step in store_plan["steps"]
                if step["step_id"] == "step-review-quality"
            )
            review_step["approval_required_by"] = "agent-ghost"

            invalid_required_approver = client.post(
                f"/api/projects/{project_id}/plans/{plan_id}/steps/step-review-quality/approve",
                json={"approver_id": "agent-ghost"},
            )
            assert invalid_required_approver.status_code == 400
            assert invalid_required_approver.json()["detail"] == "Step requires a valid approver"

            review_step["approval_required_by"] = "agent-ceo"

            correct_approver = client.post(
                f"/api/projects/{project_id}/plans/{plan_id}/steps/step-review-quality/approve",
                json={"approver_id": "agent-ceo", "note": "owner approved"},
            )
            assert correct_approver.status_code == 200
            review_step = next(
                step
                for step in correct_approver.json()["steps"]
                if step["step_id"] == "step-review-quality"
            )
            assert review_step["status"] == "approved"
    finally:
        app.dependency_overrides.clear()


def test_runtime_execution_intents_enforce_status_transitions(monkeypatch):
    project_uuid = uuid.uuid4()
    project_id = str(project_uuid)

    async def _fake_project_access():
        return project_uuid

    async def _fake_ensure_runtime(_project_id: str) -> bool:
        return True

    runtime.RUNTIME_OVERRIDES.clear()
    runtime.PROJECT_PLANS.clear()
    runtime.PROJECT_EXECUTION_INTENTS.clear()

    monkeypatch.setattr(runtime, "ensure_project_runtime_exists", _fake_ensure_runtime)

    app.dependency_overrides[deps.require_project_access] = _fake_project_access
    app.dependency_overrides[deps.get_db] = _fake_db
    try:
        with TestClient(app) as client:
            create_intent = client.post(
                f"/api/projects/{project_id}/execution-intents",
                json={
                    "agent_id": "agent-devops",
                    "agent_role": "devops",
                    "kind": "run_ops_action",
                    "title": "Run production-safe cleanup",
                    "description": "Clean up generated artifacts after approval.",
                    "target": "workspace://runtime/cleanup",
                    "connector_id": "runtime_ops_connector",
                    "payload": {"scope": "generated"},
                    "requires_approval": True,
                },
            )
            assert create_intent.status_code == 200
            intent_id = create_intent.json()["intent_id"]

            early_complete = client.post(
                f"/api/projects/{project_id}/execution-intents/{intent_id}/complete",
                json={"status": "completed", "result_summary": "should not complete"},
            )
            assert early_complete.status_code == 400
            assert early_complete.json()["detail"] == "Execution intent is not approved"

            approve = client.post(
                f"/api/projects/{project_id}/execution-intents/{intent_id}/decision",
                json={"action": "approved", "note": "safe"},
            )
            assert approve.status_code == 200
            assert approve.json()["status"] == "approved"

            second_decision = client.post(
                f"/api/projects/{project_id}/execution-intents/{intent_id}/decision",
                json={"action": "rejected", "note": "too late"},
            )
            assert second_decision.status_code == 400
            assert second_decision.json()["detail"] == "Execution intent is not pending approval"

            complete = client.post(
                f"/api/projects/{project_id}/execution-intents/{intent_id}/complete",
                json={"status": "completed", "result_summary": "cleanup completed"},
            )
            assert complete.status_code == 200
            assert complete.json()["status"] == "completed"

            repeat_complete = client.post(
                f"/api/projects/{project_id}/execution-intents/{intent_id}/complete",
                json={"status": "completed", "result_summary": "should not repeat"},
            )
            assert repeat_complete.status_code == 400
            assert repeat_complete.json()["detail"] == "Execution intent is not approved"
    finally:
        app.dependency_overrides.clear()

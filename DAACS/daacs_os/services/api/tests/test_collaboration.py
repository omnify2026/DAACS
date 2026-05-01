from __future__ import annotations

import asyncio
import uuid
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from daacs.application.collaboration_service import reset_for_tests
from daacs.agents.base_roles import AGENT_META, AgentRole
from daacs.agents.teams import AgentTeam, get_team_roles
from daacs.core import deps
from daacs.routes import collaboration
from daacs.server import app


async def _fake_project_access():
    return uuid.uuid4()


def test_collaboration_session_create_and_round_start(monkeypatch):
    project_id = str(uuid.uuid4())
    project_cwd = str(Path(__file__).resolve().parents[1])
    reset_for_tests()
    sessions: dict[str, dict] = {}
    result_poll_counts: dict[str, int] = {}
    submit_calls: list[dict[str, object]] = []
    submit_task_calls: list[dict[str, object]] = []

    async def _fake_submit(project_id: str, team_items: list[dict], project_cwd: str | None = None):
        submit_calls.append(
            {
                "project_id": project_id,
                "teams": [getattr(item["team"], "value", str(item["team"])) for item in team_items],
                "team_items": team_items,
                "project_cwd": project_cwd,
            }
        )
        submitted: dict[str, dict[str, str]] = {}
        for item in team_items:
            team_name = getattr(item["team"], "value", str(item["team"]))
            if team_name == "development_team":
                submitted[team_name] = {"developer": "dev-task"}
            elif team_name == "operations_team":
                submitted[team_name] = {"devops": "ops-task"}
        return submitted

    async def _fake_manager_action(project_id: str, action: str, args=None, timeout_seconds=15.0):
        if action == "start_parallel":
            return {"status": "parallel_started", "project_id": project_id}
        if action == "submit_task":
            role = (args or {}).get("role")
            submit_task_calls.append(
                {
                    "role": role,
                    "instruction": (args or {}).get("instruction"),
                    "context": (args or {}).get("context"),
                }
            )
            if role == "reviewer":
                return {"task_id": "review-task"}
            if role == "verifier":
                return {"task_id": "verify-task"}
            assert role == "pm"
            mode = ((args or {}).get("context") or {}).get("mode")
            if mode == "collaboration_planning":
                return {"task_id": "pm-plan"}
            return {"task_id": "pm-synth"}
        if action == "get_multi_agent_results":
            task_ids = (args or {}).get("task_ids") or {}
            key = ",".join(sorted(task_ids.values()))
            result_poll_counts[key] = result_poll_counts.get(key, 0) + 1
            if result_poll_counts[key] == 1:
                return {
                    role: {
                        "task_id": task_id,
                        "status": "running",
                    }
                    for role, task_id in task_ids.items()
                }
            if task_ids == {"pm": "pm-plan"}:
                return {
                    "pm": {
                        "task_id": "pm-plan",
                        "status": "completed",
                        "result": {
                            "refined_goal": "Ship collaboration loop with stronger implementation quality",
                            "plan_summary": "Clarify deliverables before implementation, then validate rollout safety.",
                            "acceptance_criteria": [
                                "Implementation outputs name concrete files or modules",
                                "Review and verification call out real blockers",
                            ],
                            "deliverables": [
                                "Concrete implementation outcome",
                                "Review blockers",
                                "Verification proof gaps",
                            ],
                            "review_focus": ["Regression risk", "Missing tests"],
                            "verification_focus": ["Acceptance criteria coverage", "Missing evidence"],
                            "ops_focus": ["Canary safety", "Health checks"],
                            "execution_card": "Ship the concrete implementation slice first without broadening the round.",
                            "primary_focus": "Name the concrete files or modules touched by the implementation slice.",
                            "done_for_this_round": "One concrete implementation slice is complete and reviewable.",
                            "do_not_expand": ["Do not broaden into secondary rollout work in the same implementation turn."],
                        },
                    }
                }
            if task_ids == {"pm": "pm-synth"}:
                return {
                    "pm": {
                        "task_id": "pm-synth",
                        "status": "completed",
                        "result": {
                            "decision": "PM synthesis merged the round",
                            "open_questions": ["Rollback failure handling still needs acceptance criteria"],
                            "next_actions": ["Add canary health checks before rollout"],
                        },
                    }
                }
            return {
                role: (
                    {
                        "task_id": task_id,
                        "status": "completed",
                        "result": {
                            "instruction": "Implement auth flow",
                            "llm_response": "Created api/auth.py and token validation hooks.",
                            "new_files": ["api/auth.py"],
                            "follow_up": ["Add integration tests"],
                        },
                    }
                    if role == "developer"
                    else {
                        "task_id": task_id,
                        "status": "completed",
                        "result": {
                            "instruction": "Review auth flow",
                            "summary": "Rollback coverage and release blockers look good.",
                            "llm_response": "Rollback path has regression coverage and no release blocker remains.",
                            "issues": [],
                            "open_questions": [],
                            "next_actions": [],
                            "score": 8,
                            "verdict": "pass",
                        },
                    }
                    if role == "reviewer"
                    else {
                        "task_id": task_id,
                        "status": "completed",
                        "result": {
                            "instruction": "Verify auth flow",
                            "summary": "Acceptance criteria are covered with explicit verification proof.",
                            "llm_response": "Rollback and login hardening checks passed with concrete evidence.",
                            "blockers": [],
                            "open_questions": [],
                            "next_actions": [],
                            "checks": [
                                "pytest tests/auth/test_login.py",
                                "pytest tests/auth/test_rollback.py",
                            ],
                            "evidence": [
                                "login hardening test passed",
                                "rollback regression test passed",
                            ],
                            "verdict": "pass",
                        },
                    }
                    if role == "verifier"
                    else {
                        "task_id": task_id,
                        "status": "completed",
                        "result": {
                            "instruction": "Plan rollout",
                            "llm_response": "Canary rollout needs health checks and alert thresholds.",
                            "next_actions": ["Add canary health checks"],
                        },
                    }
                )
                for role, task_id in task_ids.items()
            }
        return {}

    async def _fake_persist_session(session: dict):
        sessions[session["session_id"]] = {
            **session,
            "rounds": list(session.get("rounds", [])),
            "artifacts": list(session.get("artifacts", [])),
        }

    async def _fake_load_session(p_id: str, session_id: str):
        data = sessions.get(session_id)
        if data is None:
            return None
        if data.get("project_id") != p_id:
            return None
        return data

    async def _fake_persist_round(session_id: str, round_payload: dict, artifact: dict):
        data = sessions.get(session_id)
        if data is None:
            return
        data.setdefault("rounds", []).append(round_payload)
        data.setdefault("artifacts", []).append(artifact)

    monkeypatch.setattr(collaboration, "manager_action", _fake_manager_action)
    monkeypatch.setattr(collaboration, "submit_parallel_team_primitives", _fake_submit)
    monkeypatch.setattr(collaboration, "persist_collaboration_session", _fake_persist_session)
    monkeypatch.setattr(collaboration, "load_collaboration_session_from_db", _fake_load_session)
    monkeypatch.setattr(collaboration, "persist_collaboration_round", _fake_persist_round)

    app.dependency_overrides[deps.require_project_access] = _fake_project_access
    app.dependency_overrides[deps.get_current_user] = lambda: type("U", (), {"id": uuid.uuid4()})()
    try:
        with TestClient(app) as client:
            create = client.post(
                f"/api/collaboration/{project_id}/sessions",
                json={"shared_goal": "Ship collaboration loop", "participants": ["developer", "reviewer"]},
            )
            assert create.status_code == 200
            session_id = create.json()["session_id"]

            round_start = client.post(
                f"/api/collaboration/{project_id}/sessions/{session_id}/rounds",
                json={
                    "prompt": "Execute in parallel",
                    "teams": ["development_team", "review_team", "operations_team"],
                    "project_cwd": project_cwd,
                },
            )
            assert round_start.status_code == 200
            payload = round_start.json()
            assert payload["status"] == "completed"
            assert payload["artifact"]["decision"] == "PM synthesis merged the round"
            assert payload["artifact"]["open_questions"] == [
                "Rollback failure handling still needs acceptance criteria"
            ]
            assert payload["artifact"]["next_actions"] == ["Add canary health checks before rollout"]
            assert len(payload["artifact"]["contributions"]) == 5
            assert payload["artifact"]["contributions"][0]["agent_role"] == "pm"
            assert payload["artifact"]["contributions"][0]["details"]["execution_card"] == (
                "Ship the concrete implementation slice first without broadening the round."
            )
            assert submit_calls[0]["teams"] == ["development_team"]
            assert submit_calls[1]["teams"] == ["operations_team"]
            assert submit_calls[0]["project_cwd"] == project_cwd
            development_instruction = submit_calls[0]["team_items"][0]["instruction"]
            development_context = submit_calls[0]["team_items"][0]["context"]
            assert "Execution card:" in str(development_instruction)
            assert "Primary focus:" in str(development_instruction)
            assert development_context["execution_card"]
            review_call = next(call for call in submit_task_calls if call["role"] == "reviewer")
            verify_call = next(call for call in submit_task_calls if call["role"] == "verifier")
            assert "Created api/auth.py and token validation hooks." in review_call["context"]["artifacts"]
            assert "Rollback coverage and release blockers look good." in verify_call["context"]["artifacts"]
            assert "Acceptance criteria coverage" in review_call["context"]["member_instructions"]["verifier"]
            assert result_poll_counts["dev-task"] >= 2
            assert result_poll_counts["review-task"] >= 2
            assert result_poll_counts["verify-task"] >= 2
            assert result_poll_counts["ops-task"] >= 2
            assert result_poll_counts["pm-plan"] >= 2
            assert result_poll_counts["pm-synth"] >= 2
    finally:
        app.dependency_overrides.clear()


def test_collaboration_round_blocks_after_reviewer_quality_gate_failure(monkeypatch):
    project_id = str(uuid.uuid4())
    project_cwd = str(Path(__file__).resolve().parents[1])
    reset_for_tests()
    sessions: dict[str, dict] = {}
    submit_calls: list[dict[str, object]] = []
    submit_task_calls: list[dict[str, object]] = []

    async def _fake_submit(project_id: str, team_items: list[dict], project_cwd: str | None = None):
        submit_calls.append(
            {
                "project_id": project_id,
                "teams": [getattr(item["team"], "value", str(item["team"])) for item in team_items],
                "team_items": team_items,
                "project_cwd": project_cwd,
            }
        )
        submitted: dict[str, dict[str, str]] = {}
        for item in team_items:
            team_name = getattr(item["team"], "value", str(item["team"]))
            if team_name == "development_team":
                submitted[team_name] = {"developer": "dev-task"}
            elif team_name == "operations_team":
                submitted[team_name] = {"devops": "ops-task"}
        return submitted

    async def _fake_manager_action(project_id: str, action: str, args=None, timeout_seconds=15.0):
        if action == "start_parallel":
            return {"status": "parallel_started", "project_id": project_id}
        if action == "submit_task":
            role = (args or {}).get("role")
            submit_task_calls.append(
                {
                    "role": role,
                    "instruction": (args or {}).get("instruction"),
                    "context": (args or {}).get("context"),
                }
            )
            if role == "reviewer":
                return {"task_id": "review-task"}
            if role == "verifier":
                raise AssertionError("Verifier should not run after the reviewer blocks the round")
            assert role == "pm"
            mode = ((args or {}).get("context") or {}).get("mode")
            if mode == "collaboration_planning":
                return {"task_id": "pm-plan"}
            raise AssertionError("PM synthesis should not run for a blocked round")
        if action == "get_multi_agent_results":
            task_ids = (args or {}).get("task_ids") or {}
            if task_ids == {"pm": "pm-plan"}:
                return {
                    "pm": {
                        "task_id": "pm-plan",
                        "status": "completed",
                        "result": {
                            "refined_goal": "Ship collaboration loop with stronger implementation quality",
                            "plan_summary": "Clarify deliverables before implementation, then validate rollout safety.",
                            "acceptance_criteria": [
                                "Implementation outputs name concrete files or modules",
                                "Review and verification call out real blockers",
                            ],
                            "deliverables": [
                                "Concrete implementation outcome",
                                "Review blockers",
                                "Verification proof gaps",
                            ],
                            "review_focus": ["Regression risk", "Missing tests"],
                            "verification_focus": ["Acceptance criteria coverage", "Missing evidence"],
                            "ops_focus": ["Canary safety", "Health checks"],
                        },
                    }
                }
            if task_ids == {"reviewer": "review-task"}:
                return {
                    "reviewer": {
                        "task_id": "review-task",
                        "status": "completed",
                        "result": {
                            "instruction": "Review auth flow",
                            "summary": "Rollback path still lacks regression coverage.",
                            "llm_response": "Rollback path still lacks regression coverage.",
                            "issues": ["Rollback path still lacks regression coverage"],
                            "open_questions": [],
                            "next_actions": ["Add rollback regression test"],
                            "score": 6,
                            "verdict": "fail",
                        },
                    }
                }
            if task_ids == {"developer": "dev-task"}:
                return {
                    "developer": {
                        "task_id": "dev-task",
                        "status": "completed",
                        "result": {
                            "instruction": "Implement auth flow",
                            "llm_response": "Created api/auth.py and token validation hooks.",
                            "new_files": ["api/auth.py"],
                            "follow_up": ["Add integration tests"],
                        },
                    }
                }
            if task_ids == {"devops": "ops-task"}:
                raise AssertionError("Operations should be skipped after a blocked review stage")
        return {}

    async def _fake_persist_session(session: dict):
        sessions[session["session_id"]] = {
            **session,
            "rounds": list(session.get("rounds", [])),
            "artifacts": list(session.get("artifacts", [])),
        }

    async def _fake_load_session(p_id: str, session_id: str):
        data = sessions.get(session_id)
        if data is None:
            return None
        if data.get("project_id") != p_id:
            return None
        return data

    async def _fake_persist_round(session_id: str, round_payload: dict, artifact: dict):
        data = sessions.get(session_id)
        if data is None:
            return
        data.setdefault("rounds", []).append(round_payload)
        data.setdefault("artifacts", []).append(artifact)

    monkeypatch.setattr(collaboration, "manager_action", _fake_manager_action)
    monkeypatch.setattr(collaboration, "submit_parallel_team_primitives", _fake_submit)
    monkeypatch.setattr(collaboration, "persist_collaboration_session", _fake_persist_session)
    monkeypatch.setattr(collaboration, "load_collaboration_session_from_db", _fake_load_session)
    monkeypatch.setattr(collaboration, "persist_collaboration_round", _fake_persist_round)

    app.dependency_overrides[deps.require_project_access] = _fake_project_access
    app.dependency_overrides[deps.get_current_user] = lambda: type("U", (), {"id": uuid.uuid4()})()
    try:
        with TestClient(app) as client:
            create = client.post(
                f"/api/collaboration/{project_id}/sessions",
                json={"shared_goal": "Ship collaboration loop", "participants": ["developer", "reviewer"]},
            )
            assert create.status_code == 200
            session_id = create.json()["session_id"]

            round_start = client.post(
                f"/api/collaboration/{project_id}/sessions/{session_id}/rounds",
                json={
                    "prompt": "Execute in parallel",
                    "teams": ["development_team", "review_team", "operations_team"],
                    "project_cwd": project_cwd,
                },
            )
            assert round_start.status_code == 200
            payload = round_start.json()
            assert payload["status"] == "incomplete"
            assert payload["artifact"]["decision"].startswith("Quality gate blocked:")
            assert any(
                "review_team/reviewer: review verdict is fail" in question
                for question in payload["artifact"]["open_questions"]
            )
            assert len(submit_calls) == 1
            assert submit_calls[0]["teams"] == ["development_team"]
            assert submit_calls[0]["project_cwd"] == project_cwd
            assert [call["role"] for call in submit_task_calls if call["role"] != "pm"] == ["reviewer"]
    finally:
        app.dependency_overrides.clear()


def test_collaboration_session_defaults_include_verifier(monkeypatch):
    project_id = str(uuid.uuid4())
    reset_for_tests()
    sessions: dict[str, dict] = {}

    async def _fake_persist_session(session: dict):
        sessions[session["session_id"]] = session

    monkeypatch.setattr(collaboration, "persist_collaboration_session", _fake_persist_session)

    app.dependency_overrides[deps.require_project_access] = _fake_project_access
    app.dependency_overrides[deps.get_current_user] = lambda: type("U", (), {"id": uuid.uuid4()})()
    try:
        with TestClient(app) as client:
            create = client.post(
                f"/api/collaboration/{project_id}/sessions",
                json={"shared_goal": "Ship dynamic collaboration"},
            )
            assert create.status_code == 200
            participants = create.json()["participants"]
            assert "pm" in participants
            assert "developer" in participants
            assert "reviewer" in participants
            assert "verifier" in participants
    finally:
        app.dependency_overrides.clear()


def test_collaboration_round_returns_incomplete_when_team_tasks_time_out(monkeypatch):
    project_id = str(uuid.uuid4())
    sessions: dict[str, dict] = {}
    submit_modes: list[str] = []
    submit_teams: list[list[str]] = []
    submitted_contexts: list[dict] = []
    stop_parallel_calls: list[str] = []

    async def _fake_submit(project_id: str, team_items: list[dict], project_cwd: str | None = None):
        submit_teams.append([getattr(item["team"], "value", str(item["team"])) for item in team_items])
        submitted_contexts.extend([dict(item.get("context") or {}) for item in team_items])
        submitted: dict[str, dict[str, str]] = {}
        for item in team_items:
            team_name = getattr(item["team"], "value", str(item["team"]))
            if team_name == "development_team":
                submitted[team_name] = {"developer": "dev-task"}
        return submitted

    async def _fake_wait_for_multi_results(project_id: str, task_ids: dict[str, str], *args, **kwargs):
        if task_ids == {"pm": "pm-plan"}:
            return {
                "pm": {
                    "task_id": "pm-plan",
                    "status": "completed",
                    "result": {
                        "refined_goal": "Audit the signup flow files",
                        "plan_summary": "Identify exact files and summarize the evidence.",
                        "deliverables": ["Concrete implementation outcome"],
                    },
                }
            }
        if task_ids == {"developer": "dev-task"}:
            return {
                "developer": {
                    "task_id": "dev-task",
                    "status": "running",
                }
            }
        raise AssertionError(f"Unexpected task_ids: {task_ids}")

    async def _fake_manager_action(project_id: str, action: str, args=None, timeout_seconds=15.0):
        if action == "start_parallel":
            return {"status": "parallel_started", "project_id": project_id}
        if action == "submit_task":
            mode = ((args or {}).get("context") or {}).get("mode")
            submit_modes.append(str(mode))
            return {"task_id": "pm-plan"}
        if action == "stop_parallel":
            stop_parallel_calls.append(project_id)
            return {"status": "parallel_stopped", "project_id": project_id}
        raise AssertionError(f"Unexpected action: {action}")

    async def _fake_persist_session(session: dict):
        sessions[session["session_id"]] = {
            **session,
            "rounds": list(session.get("rounds", [])),
            "artifacts": list(session.get("artifacts", [])),
        }

    async def _fake_load_session(p_id: str, session_id: str):
        data = sessions.get(session_id)
        if data is None:
            return None
        if data.get("project_id") != p_id:
            return None
        return data

    async def _fake_persist_round(session_id: str, round_payload: dict, artifact: dict):
        data = sessions.get(session_id)
        if data is None:
            return
        data.setdefault("rounds", []).append(round_payload)
        data.setdefault("artifacts", []).append(artifact)

    monkeypatch.setattr(collaboration, "manager_action", _fake_manager_action)
    monkeypatch.setattr(collaboration, "submit_parallel_team_primitives", _fake_submit)
    monkeypatch.setattr(collaboration, "_wait_for_multi_results", _fake_wait_for_multi_results)
    monkeypatch.setattr(collaboration, "persist_collaboration_session", _fake_persist_session)
    monkeypatch.setattr(collaboration, "load_collaboration_session_from_db", _fake_load_session)
    monkeypatch.setattr(collaboration, "persist_collaboration_round", _fake_persist_round)

    app.dependency_overrides[deps.require_project_access] = _fake_project_access
    app.dependency_overrides[deps.get_current_user] = lambda: type("U", (), {"id": uuid.uuid4()})()
    try:
        with TestClient(app) as client:
            create = client.post(
                f"/api/collaboration/{project_id}/sessions",
                json={"shared_goal": "Find signup files"},
            )
            assert create.status_code == 200
            session_id = create.json()["session_id"]

            round_start = client.post(
                f"/api/collaboration/{project_id}/sessions/{session_id}/rounds",
                json={
                    "prompt": "Identify signup files and workspace handoff files.",
                    "teams": ["development_team", "review_team", "operations_team"],
                },
            )
            assert round_start.status_code == 200
            payload = round_start.json()

            assert payload["status"] == "incomplete"
            assert payload["round"]["status"] == "incomplete"
            assert payload["artifact"]["decision"].startswith("Incomplete round:")
            assert payload["artifact"]["open_questions"][0].startswith(
                "Timed out before all agent tasks finished:"
            )
            assert "development_team/developer" in payload["artifact"]["open_questions"][0]
            assert payload["artifact"]["next_actions"][0] == (
                "Retry the round after narrowing the goal or increasing the timeout."
            )
            assert stop_parallel_calls == [project_id]
            assert submit_modes == []
            assert submit_teams == [["development_team"]]
            assert submitted_contexts[0]["discovery_only"] is True
            assert "read-only" in submitted_contexts[0]["member_instructions"]["developer"].lower()
    finally:
        app.dependency_overrides.clear()


def test_collaboration_team_context_includes_role_specific_member_guidance():
    planning_brief = collaboration._fallback_planning_brief(
        prompt="Review auth hardening",
        shared_goal="Ship a safer auth flow",
    )
    context = collaboration._build_team_context(
        collaboration.AgentTeam.REVIEW_TEAM,
        prompt="Review auth hardening",
        shared_goal="Ship a safer auth flow",
        prior_contributions=[
            {
                "team": "development_team",
                "agent_role": "developer",
                "status": "completed",
                "summary": "Updated api/auth.py and login token checks.",
            }
        ],
        planning_brief=planning_brief,
    )

    assert context["mode"] == "collaboration_round"
    assert context["team"] == "review_team"
    assert "reviewer" in context["member_instructions"]
    assert "verifier" in context["member_instructions"]
    assert "user-visible requirement coverage" in context["member_instructions"]["reviewer"].lower()
    assert "acceptance criteria" in context["member_instructions"]["verifier"].lower()
    assert "user-flow" in context["member_instructions"]["verifier"].lower()

    instruction = collaboration._build_team_instruction(
        collaboration.AgentTeam.REVIEW_TEAM,
        prompt="Review auth hardening",
        shared_goal="Ship a safer auth flow",
        prior_contributions=[],
        planning_brief=planning_brief,
    )
    assert "Acceptance criteria:" in instruction
    assert "Compare the output against every acceptance criterion" in instruction


def test_discovery_only_request_detects_revision_style_file_questions():
    planning_brief = {
        "refined_goal": "Extend the existing finding with the exact file and component names.",
        "plan_summary": "Revise the previous result by naming the exact file where the round status is rendered.",
    }

    assert collaboration._is_discovery_only_request(
        "Revise the previous result by also naming where the shared board renders the round status for users.",
        planning_brief,
    )


def test_discovery_only_request_keeps_read_only_revision_prompts_out_of_implementation_mode():
    planning_brief = {
        "refined_goal": (
            "Map the web collaboration flow to identify where an existing session is reused and where "
            "the shared board reads round status, then extend the answer with the backend route path."
        ),
        "plan_summary": (
            "Revision request: keep this read-only, but add the backend route file that serves "
            "collaboration round responses and the timeout control path too."
        ),
    }

    assert collaboration._is_discovery_only_request(
        (
            "Revision request: keep this read-only, but add the backend route file that serves "
            "collaboration round responses and the timeout control path too."
        ),
        planning_brief,
    )


def test_discovery_only_request_keeps_read_only_validation_prompts_out_of_implementation_mode():
    planning_brief = {
        "refined_goal": "검증만 해서 어떤 문제가 남았는지 확인한다.",
        "plan_summary": "고치지 말고 사용자 관점 검증 결과와 의심 파일만 정리한다.",
    }

    assert collaboration._is_discovery_only_request(
        "고치지 말고 검증만 해줘. 사용자 관점에서 깨지는 흐름, 의심 파일, 확인 결과만 알려줘.",
        planning_brief,
    )


def test_discovery_only_request_keeps_korean_review_only_prompts_out_of_implementation_mode():
    planning_brief = {
        "refined_goal": "사용자 관점 검수만 하고 수정 없이 위험한 파일을 찾는다.",
        "plan_summary": "변경하지 말고 검수 결과와 의심 파일만 정리한다.",
    }

    assert collaboration._is_discovery_only_request(
        "수정 없이 검수만 해줘. 어떤 파일이 문제인지 확인만 하고 고치지는 마.",
        planning_brief,
    )


def test_discovery_only_request_routes_cleanup_phrases_to_implementation_mode():
    planning_brief = {
        "refined_goal": "불필요한 코드와 죽은 코드를 정리한다.",
        "plan_summary": "미사용 코드를 삭제하고 관련 테스트를 업데이트한다.",
    }

    assert not collaboration._is_discovery_only_request(
        "불필요한 코드 정리하고 죽은 코드 삭제한 뒤 관련 테스트까지 수정해줘.",
        planning_brief,
    )


def test_discovery_only_request_routes_short_korean_cleanup_to_implementation_mode():
    planning_brief = {
        "refined_goal": "미사용 코드 정리해줘.",
        "plan_summary": "불필요한 파일과 테스트 코드를 정리해.",
    }

    assert not collaboration._is_discovery_only_request(
        "미사용 코드 정리해줘. 관련 테스트도 같이 변경해줘.",
        planning_brief,
    )


def test_discovery_only_request_detects_korean_quality_audit_prompts():
    planning_brief = {
        "refined_goal": "DAACS 웹 협업 흐름을 사용자 관점으로 점검한다.",
        "plan_summary": "재현 경로, 의심 파일, 검증 방법이 포함된 체크리스트를 정리한다.",
    }

    assert collaboration._is_discovery_only_request(
        "사용자 관점에서 DAACS 웹 협업 흐름을 점검하고 가장 먼저 고쳐야 할 문제를 체크리스트로 정리해줘. 재현 경로, 의심 파일, 검증 방법을 포함해.",
        planning_brief,
    )


def test_discovery_only_request_treats_korean_fix_prompts_as_implementation():
    planning_brief = {
        "refined_goal": "공유 보드 상태 동기화 문제를 수정한다.",
        "plan_summary": "버튼 상태와 세션 재사용 로직을 변경하고 검증한다.",
    }

    assert not collaboration._is_discovery_only_request(
        "공유 보드 상태 동기화 버그를 수정하고 관련 테스트를 추가해줘.",
        planning_brief,
    )


def test_discovery_only_request_routes_mixed_korean_result_file_change_to_implementation():
    planning_brief = {
        "refined_goal": "기존 결과와 관련 파일 경로를 바탕으로 문제를 수정한다.",
        "plan_summary": "결과 파일을 확인한 뒤 필요한 코드를 변경하고 회귀 테스트를 추가한다.",
    }

    assert not collaboration._is_discovery_only_request(
        "기존 결과랑 파일 경로를 보고 잘못된 부분 수정하고 변경 테스트까지 추가해줘.",
        planning_brief,
    )


def test_discovery_only_request_keeps_korean_result_revision_as_discovery():
    planning_brief = {
        "refined_goal": "이전 결과를 보강해서 정확한 파일과 함수 이름을 정리한다.",
        "plan_summary": "기존 결과를 수정 요청으로 다시 정리하고 절대 경로 기준으로 답한다.",
    }

    assert collaboration._is_discovery_only_request(
        (
            "이전 결과를 수정해서 현재 120초 타임아웃이 발생하는 정확한 파일과 함수 이름을 추가해줘. "
            "특히 discovery 판별, 개발자 실행 타임아웃, 공유 보드 상태 렌더 위치를 각각 절대 경로 기준으로 정리해줘."
        ),
        planning_brief,
    )


def test_discovery_team_context_includes_search_roots():
    planning_brief = collaboration._fallback_planning_brief(
        prompt="Identify where the web collaboration flow reuses an existing session.",
        shared_goal="Trace the web collaboration flow",
    )
    context = collaboration._build_team_context(
        collaboration.AgentTeam.DEVELOPMENT_TEAM,
        prompt="Identify where the web collaboration flow reuses an existing session.",
        shared_goal="Trace the web collaboration flow",
        prior_contributions=[],
        planning_brief=planning_brief,
        project_cwd=str(Path(__file__).resolve().parents[3]),
        discovery_only=True,
    )

    assert context["discovery_only"] is True
    assert "search_roots" in context
    assert "apps/web/src/components/office" in context["search_roots"]
    assert "apps/web/src" not in context["search_roots"]
    assert "Search Roots" not in context["member_instructions"]["developer"]


def test_discovery_team_context_includes_korean_web_and_api_search_roots():
    prompt = (
        "이전 결과를 수정해서 discovery 판별, 개발자 실행 타임아웃, "
        "공유 보드 상태 렌더 위치를 절대 경로 기준으로 정리해줘."
    )
    planning_brief = collaboration._fallback_planning_brief(
        prompt=prompt,
        shared_goal="한국어 discovery 수정 요청 흐름을 추적한다.",
    )
    context = collaboration._build_team_context(
        collaboration.AgentTeam.DEVELOPMENT_TEAM,
        prompt=prompt,
        shared_goal=planning_brief["refined_goal"],
        prior_contributions=[],
        planning_brief=planning_brief,
        project_cwd=str(Path(__file__).resolve().parents[3]),
        discovery_only=True,
    )

    assert "search_roots" in context
    assert "apps/web/src/components/office" in context["search_roots"]
    assert "services/api/daacs/routes" in context["search_roots"]


@pytest.mark.anyio
async def test_plan_round_with_pm_skips_manager_for_discovery_only_prompt(monkeypatch):
    async def _unexpected_manager_action(*args, **kwargs):
        raise AssertionError("manager_action should not be called for discovery-only planning")

    monkeypatch.setattr(collaboration, "manager_action", _unexpected_manager_action)

    brief = await collaboration._plan_round_with_pm(
        project_id="proj-1",
        prompt="Identify where the web collaboration flow reuses an existing session.",
        shared_goal="Trace the web collaboration flow",
    )

    assert brief["refined_goal"] == "Trace the web collaboration flow"
    assert brief["plan_summary"].startswith("이번 라운드는 이 목표에 맞춘다")


@pytest.mark.anyio
async def test_synthesize_artifact_with_pm_skips_manager_for_discovery_only_prompt(monkeypatch):
    async def _unexpected_manager_action(*args, **kwargs):
        raise AssertionError("manager_action should not be called for discovery-only synthesis")

    monkeypatch.setattr(collaboration, "manager_action", _unexpected_manager_action)

    contributions = [
        {
            "team": "development_team",
            "agent_role": "developer",
            "task_id": "t1",
            "status": "completed",
            "summary": "GoalMeetingPanel.tsx reuses the session and SharedBoardPanel.tsx renders round status.",
        }
    ]
    artifact = await collaboration._synthesize_artifact_with_pm(
        project_id="proj-1",
        session_id="sess-1",
        round_id="round-1",
        prompt="Revise the previous result by also naming where the shared board renders the round status for users.",
        shared_goal="Identify where the web collaboration flow reuses an existing session and name the main file involved.",
        contributions=contributions,
    )

    assert artifact == collaboration.build_deterministic_artifact(
        session_id="sess-1",
        round_id="round-1",
        shared_goal="Revise the previous result by also naming where the shared board renders the round status for users.",
        contributions=contributions,
    )


def test_collaboration_session_stop_route(monkeypatch):
    project_id = str(uuid.uuid4())
    session_id = str(uuid.uuid4())
    calls: list[tuple[str, str, dict | None, float]] = []

    async def _fake_load_session(p_id: str, s_id: str):
        if p_id != project_id or s_id != session_id:
            return None
        return {
            "session_id": session_id,
            "project_id": project_id,
            "shared_goal": "Stop the run",
            "participants": ["pm", "developer", "reviewer", "verifier"],
            "rounds": [],
            "artifacts": [],
            "created_at": None,
        }

    async def _fake_manager_action(project_id: str, action: str, args=None, timeout_seconds=15.0):
        calls.append((project_id, action, args, timeout_seconds))
        return {"status": "parallel_stopped"}

    monkeypatch.setattr(collaboration, "load_collaboration_session_from_db", _fake_load_session)
    monkeypatch.setattr(collaboration, "manager_action", _fake_manager_action)

    app.dependency_overrides[deps.require_project_access] = _fake_project_access
    try:
        with TestClient(app) as client:
            response = client.post(f"/api/collaboration/{project_id}/sessions/{session_id}/stop")
            assert response.status_code == 200
            assert response.json()["status"] == "stopped"
            assert calls == [(project_id, "stop_parallel", {}, 20.0)]
    finally:
        app.dependency_overrides.clear()


def test_pm_planning_falls_back_after_short_collaboration_timeout(monkeypatch):
    timeouts: list[float] = []

    async def _fake_manager_action(project_id: str, action: str, args=None, timeout_seconds=15.0):
        assert action == "submit_task"
        return {"task_id": "pm-plan"}

    async def _fake_wait_for_multi_results(project_id: str, task_ids: dict[str, str], *args, **kwargs):
        timeouts.append(float(kwargs.get("timeout_seconds")))
        return {
            "pm": {
                "task_id": "pm-plan",
                "status": "running",
            }
        }

    monkeypatch.setattr(collaboration, "manager_action", _fake_manager_action)
    monkeypatch.setattr(collaboration, "_wait_for_multi_results", _fake_wait_for_multi_results)

    brief = asyncio.run(
        collaboration._plan_round_with_pm(
            project_id=str(uuid.uuid4()),
            prompt="Ship the collaboration round faster",
            shared_goal="Improve collaboration latency",
        )
    )

    assert timeouts == [collaboration.COLLAB_PM_RESULT_TIMEOUT_SECONDS]
    assert brief == collaboration._fallback_planning_brief(
        "Ship the collaboration round faster",
        "Improve collaboration latency",
    )


def test_pm_synthesis_falls_back_after_short_collaboration_timeout(monkeypatch):
    timeouts: list[float] = []

    async def _fake_manager_action(project_id: str, action: str, args=None, timeout_seconds=15.0):
        assert action == "submit_task"
        return {"task_id": "pm-synth"}

    async def _fake_wait_for_multi_results(project_id: str, task_ids: dict[str, str], *args, **kwargs):
        timeouts.append(float(kwargs.get("timeout_seconds")))
        return {
            "pm": {
                "task_id": "pm-synth",
                "status": "running",
            }
        }

    contributions = [
        {
            "team": "planning_team",
            "agent_role": "pm",
            "status": "completed",
            "summary": "Plan the round around the auth rollback gap.",
            "open_questions": [],
            "next_actions": ["Verify rollback acceptance criteria"],
        }
    ]

    monkeypatch.setattr(collaboration, "manager_action", _fake_manager_action)
    monkeypatch.setattr(collaboration, "_wait_for_multi_results", _fake_wait_for_multi_results)

    artifact = asyncio.run(
        collaboration._synthesize_artifact_with_pm(
            project_id=str(uuid.uuid4()),
            session_id="session-1",
            round_id="round-1",
            prompt="Synthesize the collaboration outcome",
            shared_goal="Ship auth safely",
            contributions=contributions,
        )
    )

    assert timeouts == [collaboration.COLLAB_PM_RESULT_TIMEOUT_SECONDS]
    assert artifact == collaboration.build_deterministic_artifact(
        session_id="session-1",
        round_id="round-1",
        shared_goal="Synthesize the collaboration outcome",
        contributions=contributions,
    )


def test_review_team_and_meta_include_verifier():
    assert AgentRole.VERIFIER in get_team_roles(AgentTeam.REVIEW_TEAM)
    assert AGENT_META[AgentRole.VERIFIER]["title"] == "Verifier"


def test_collaboration_team_roles_are_kept_lean_for_round_completion():
    assert get_team_roles(AgentTeam.DEVELOPMENT_TEAM) == [AgentRole.DEVELOPER]
    assert get_team_roles(AgentTeam.REVIEW_TEAM) == [AgentRole.REVIEWER, AgentRole.VERIFIER]
    assert get_team_roles(AgentTeam.OPERATIONS_TEAM) == [AgentRole.DEVOPS]

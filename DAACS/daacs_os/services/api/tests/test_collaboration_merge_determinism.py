from __future__ import annotations

from daacs.orchestration.collaboration_orchestrator import (
    build_contribution_record,
    build_deterministic_artifact,
)


def test_collaboration_merge_is_deterministic():
    contributions = [
        {"agent_role": "reviewer", "task_id": "b", "open_questions": ["Q2"], "next_actions": ["A2"]},
        {"agent_role": "developer", "task_id": "a", "open_questions": ["Q1"], "next_actions": ["A1"]},
    ]
    artifact_a = build_deterministic_artifact("s", "r", "goal", contributions)
    artifact_b = build_deterministic_artifact("s", "r", "goal", list(reversed(contributions)))

    assert artifact_a["decision"] == artifact_b["decision"]
    assert artifact_a["artifact_type"] == artifact_b["artifact_type"]
    assert artifact_a["refined_goal"] == artifact_b["refined_goal"]
    assert artifact_a["deliverables"] == artifact_b["deliverables"]
    assert artifact_a["project_fit_summary"] == artifact_b["project_fit_summary"]
    assert artifact_a["open_questions"] == artifact_b["open_questions"]
    assert artifact_a["next_actions"] == artifact_b["next_actions"]
    assert artifact_a["contributions"] == artifact_b["contributions"]


def test_collaboration_merge_applies_default_lines_when_missing():
    artifact = build_deterministic_artifact(
        "s1",
        "r1",
        "goal",
        [{"agent_role": "pm", "task_id": "t1", "summary": "Planned rollout"}],
    )
    assert artifact["open_questions"] == []
    assert artifact["next_actions"] == []
    assert artifact["artifact_type"] == "multi_agent_round"
    assert "Planned rollout" in artifact["decision"]


def test_collaboration_merge_prefers_delivery_findings_over_planning_summary():
    artifact = build_deterministic_artifact(
        "s1",
        "r1",
        "goal",
        [
            {
                "team": "planning_team",
                "agent_role": "pm",
                "task_id": "t1",
                "status": "completed",
                "summary": "Plan the round around the sharpened goal: identify the file.",
            },
            {
                "team": "development_team",
                "agent_role": "developer",
                "task_id": "t2",
                "status": "completed",
                "summary": "GoalMeetingPanel.tsx reuses the session and SharedBoardPanel.tsx renders round status.",
            },
        ],
    )

    assert artifact["decision"].startswith(
        "GoalMeetingPanel.tsx reuses the session and SharedBoardPanel.tsx renders round status."
    )
    assert "Plan the round around the sharpened goal" not in artifact["decision"]


def test_collaboration_merge_lifts_planning_details_to_top_level():
    artifact = build_deterministic_artifact(
        "s1",
        "r1",
        "Ship a clearer collaboration artifact",
        [
            {
                "team": "planning_team",
                "agent_role": "pm",
                "task_id": "t1",
                "status": "completed",
                "summary": "Create a more result-shaped collaboration artifact.",
                "details": {
                    "refined_goal": "Show the round as a goal-to-result report.",
                    "acceptance_criteria": ["Show current goal", "Show deliverables at top level"],
                    "deliverables": ["Shared board summary block", "Top-level artifact fields"],
                },
            }
        ],
    )

    assert artifact["refined_goal"] == "Show the round as a goal-to-result report."
    assert artifact["acceptance_criteria"] == ["Show current goal", "Show deliverables at top level"]
    assert artifact["deliverables"] == ["Shared board summary block", "Top-level artifact fields"]
    assert "goal-to-result report" in artifact["project_fit_summary"]


def test_collaboration_merge_uses_exact_paths_for_discovery_checklist_artifact():
    artifact = build_deterministic_artifact(
        "s1",
        "r1",
        (
            "Revision request: keep this read-only, but add the backend route file that serves "
            "collaboration round responses and present the answer as a compact checklist with exact file paths."
        ),
        [
            {
                "team": "planning_team",
                "agent_role": "pm",
                "task_id": "t1",
                "status": "completed",
                "summary": "Plan the round around the sharpened goal.",
                "details": {
                    "refined_goal": "Surface the exact route and UI file paths.",
                    "acceptance_criteria": ["Name the route file", "Name the UI file"],
                    "deliverables": ["Generic planning line that should not leak into the checklist"],
                },
            },
            {
                "team": "development_team",
                "agent_role": "developer",
                "task_id": "t2",
                "status": "completed",
                "summary": (
                    "Read-only discovery matched: "
                    "services/api/daacs/routes/collaboration.py::start_collaboration_round; "
                    "apps/web/src/components/office/SharedBoardPanel.tsx::SharedBoardPanel"
                ),
                "details": {
                    "new_files": [
                        "services/api/daacs/routes/collaboration.py",
                        "apps/web/src/components/office/SharedBoardPanel.tsx",
                    ]
                },
            },
        ],
    )

    assert artifact["artifact_type"] == "discovery_checklist"
    assert artifact["deliverables"] == [
        "services/api/daacs/routes/collaboration.py",
        "apps/web/src/components/office/SharedBoardPanel.tsx",
    ]
    assert artifact["acceptance_criteria"] == ["Name the route file", "Name the UI file"]


def test_collaboration_merge_uses_structured_discovery_checklist_paths():
    artifact = build_deterministic_artifact(
        "s1",
        "r1",
        "Present a compact checklist with exact file paths.",
        [
            {
                "team": "development_team",
                "agent_role": "developer",
                "task_id": "t1",
                "status": "completed",
                "summary": "Read-only discovery returned structured checklist rows.",
                "details": {
                    "discovery_checklist": [
                        {
                            "target": "shared_board",
                            "path": "apps/web/src/components/office/SharedBoardPanel.tsx",
                            "symbol": "SharedBoardPanelView",
                            "evidence": "renders artifact_type and refined_goal",
                        }
                    ]
                },
            }
        ],
    )

    assert artifact["artifact_type"] == "discovery_checklist"
    assert artifact["deliverables"] == ["apps/web/src/components/office/SharedBoardPanel.tsx"]


def test_collaboration_merge_normalizes_blank_and_non_string_lines():
    artifact = build_deterministic_artifact(
        "s1",
        "r1",
        "goal",
        [
            {
                "agent_role": "pm",
                "task_id": "t1",
                "open_questions": ["", "  valid-q  ", 1],
                "next_actions": ["\tvalid-a\t", None],
            }
        ],
    )
    assert artifact["open_questions"] == ["valid-q"]
    assert artifact["next_actions"] == ["valid-a"]


def test_build_contribution_record_preserves_structured_result_fields():
    contribution = build_contribution_record(
        "development_team",
        "developer",
        {
            "task_id": "t1",
            "status": "completed",
            "result": {
                "instruction": "Implement auth flow",
                "llm_response": "Created auth route and token validation hooks.",
                "new_files": ["api/auth.py"],
                "follow_up": ["Add integration tests"],
            },
        },
    )

    assert contribution["summary"] == "Created auth route and token validation hooks."
    assert contribution["next_actions"] == ["Add integration tests"]
    assert contribution["details"]["new_files"] == ["api/auth.py"]


def test_build_contribution_record_keeps_long_discovery_summaries():
    summary = (
        "Read-only discovery matched: shared_board: DAACS_OS/apps/web/src/components/office/SharedBoardPanel.tsx::"
        "roundStatusLabel (...); discovery_classifier: DAACS_OS/services/api/daacs/routes/collaboration.py::"
        "_is_discovery_only_request (...); timeout_control: DAACS_OS/services/api/daacs/routes/collaboration.py::"
        "_wait_for_multi_results (COLLAB_RESULT_TIMEOUT_SECONDS = 120.0)"
    )
    contribution = build_contribution_record(
        "development_team",
        "developer",
        {
            "task_id": "t-discovery",
            "status": "completed",
            "result": {
                "action": "collaboration_discovery",
                "summary": summary,
                "new_files": [
                    "DAACS_OS/apps/web/src/components/office/SharedBoardPanel.tsx",
                    "DAACS_OS/services/api/daacs/routes/collaboration.py",
                ],
            },
        },
    )

    assert contribution["summary"] == summary
    assert "_wait_for_multi_results" in contribution["summary"]


def test_build_contribution_record_preserves_discovery_checklist_details():
    contribution = build_contribution_record(
        "development_team",
        "developer",
        {
            "task_id": "t-discovery-detail",
            "status": "completed",
            "result": {
                "action": "collaboration_discovery",
                "summary": "Read-only discovery matched: shared board and timeout control.",
                "discovery_checklist": [
                    {
                        "target": "shared_board",
                        "path": "apps/web/src/components/office/SharedBoardPanel.tsx",
                        "symbol": "roundStatusLabel",
                        "evidence": "function roundStatusLabel(status) {",
                    },
                    {
                        "target": "timeout_control",
                        "path": "services/api/daacs/routes/collaboration.py",
                        "symbol": "_wait_for_multi_results",
                        "evidence": "COLLAB_RESULT_TIMEOUT_SECONDS = 120.0",
                    },
                ],
            },
        },
    )

    assert contribution["details"]["discovery_checklist"] == [
        {
            "target": "shared_board",
            "path": "apps/web/src/components/office/SharedBoardPanel.tsx",
            "symbol": "roundStatusLabel",
            "evidence": "function roundStatusLabel(status) {",
        },
        {
            "target": "timeout_control",
            "path": "services/api/daacs/routes/collaboration.py",
            "symbol": "_wait_for_multi_results",
            "evidence": "COLLAB_RESULT_TIMEOUT_SECONDS = 120.0",
        },
    ]


def test_build_contribution_record_preserves_verification_and_ops_details():
    contribution = build_contribution_record(
        "review_team",
        "verifier",
        {
            "task_id": "t3",
            "status": "completed",
            "result": {
                "summary": "Rollback coverage is still incomplete.",
                "verdict": "fail",
                "score": 5,
                "checks": ["pytest tests/auth/test_login.py"],
                "evidence": ["Missing rollback failure output"],
                "health_checks": ["Track login success ratio"],
            },
        },
    )

    assert contribution["details"]["verdict"] == "fail"
    assert contribution["details"]["score"] == 5
    assert contribution["details"]["checks"] == ["pytest tests/auth/test_login.py"]
    assert contribution["details"]["evidence"] == ["Missing rollback failure output"]
    assert contribution["details"]["health_checks"] == ["Track login success ratio"]


def test_build_contribution_record_turns_failures_into_actionable_blockers():
    contribution = build_contribution_record(
        "review_team",
        "reviewer",
        {
            "task_id": "t2",
            "status": "failed",
            "error": "pytest crashed",
        },
    )

    assert contribution["open_questions"] == ["reviewer failed: pytest crashed"]
    assert contribution["next_actions"] == ["Resolve reviewer failure and rerun the round."]

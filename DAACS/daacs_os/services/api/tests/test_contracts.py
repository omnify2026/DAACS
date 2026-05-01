from __future__ import annotations

from daacs.agents import protocol
from daacs.orchestration.collaboration_orchestrator import build_deterministic_artifact


def test_ws_contract_constants_exist():
    assert protocol.COLLAB_ROUND_STARTED == "COLLAB_ROUND_STARTED"
    assert protocol.COLLAB_ROUND_COMPLETED == "COLLAB_ROUND_COMPLETED"
    assert protocol.COLLAB_ARTIFACT_UPDATED == "COLLAB_ARTIFACT_UPDATED"


def test_collaboration_artifact_contract_shape():
    artifact = build_deterministic_artifact(
        session_id="s1",
        round_id="r1",
        shared_goal="goal",
        contributions=[{"agent_role": "developer", "task_id": "t1", "open_questions": [], "next_actions": []}],
    )
    assert set(artifact.keys()) == {
        "session_id",
        "round_id",
        "artifact_type",
        "decision",
        "refined_goal",
        "acceptance_criteria",
        "deliverables",
        "project_fit_summary",
        "open_questions",
        "next_actions",
        "contributions",
    }

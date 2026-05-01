"""Collaboration payload builders (DB persistence handled by routes/helpers)."""

from __future__ import annotations

import uuid
from typing import Any, Dict, List, Optional

from ..orchestration.collaboration_orchestrator import build_deterministic_artifact


def create_session(
    project_id: str,
    owner_user_id: str,
    shared_goal: str,
    participants: List[str],
) -> Dict[str, Any]:
    return {
        "session_id": str(uuid.uuid4()),
        "project_id": project_id,
        "owner_user_id": owner_user_id,
        "shared_goal": shared_goal.strip(),
        "participants": sorted(set(participants)),
        "rounds": [],
        "artifacts": [],
        "created_at": None,
    }


def start_round(
    session_id: str,
    prompt: str,
    contributions: List[Dict[str, Any]],
    shared_goal: str,
    *,
    round_id: Optional[str] = None,
    artifact: Optional[Dict[str, Any]] = None,
    status: str = "completed",
) -> Dict[str, Any]:
    resolved_round_id = round_id or str(uuid.uuid4())
    resolved_artifact = artifact or build_deterministic_artifact(
        session_id=session_id,
        round_id=resolved_round_id,
        shared_goal=prompt or shared_goal,
        contributions=contributions,
    )
    round_payload = {
        "round_id": resolved_round_id,
        "prompt": prompt,
        "status": status,
        "created_at": None,
    }
    return {
        "round": round_payload,
        "artifact": resolved_artifact,
    }


def reset_for_tests() -> None:
    return

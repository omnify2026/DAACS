"""Owner operations decision endpoints."""

from __future__ import annotations

import json
import logging
from datetime import datetime
from typing import Any, Dict, List, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from ..application.persistence_service import load_workflow_from_db, persist_workflow_status
from ..application.workflow_service import (
    _WORKFLOW_DEFAULT_GOALS,
    WorkflowConflictError,
    resume_workflow_distributed,
    stop_workflow_distributed,
)
from ..core import distributed_runtime
from ..core.deps import get_current_user, require_project_access
from ..db.models import User

router = APIRouter(prefix="/api/ops", tags=["owner-ops"])
logger = logging.getLogger("daacs.routes.owner_ops")

DecisionAction = Literal["approved", "hold", "rejected"]
DecisionTarget = Literal["workflow", "team_run", "incident"]

_DECISION_LOGS: Dict[str, List[Dict[str, Any]]] = {}
_TEAM_RUN_STATE: Dict[str, Dict[str, str]] = {}
_INCIDENT_STATE: Dict[str, Dict[str, str]] = {}


class OwnerDecisionRequest(BaseModel):
    item_id: str = Field(..., min_length=1, max_length=200)
    title: str = Field(..., min_length=1, max_length=200)
    source: str = Field(default="OwnerOps", min_length=1, max_length=100)
    action: DecisionAction
    detail: str | None = Field(default=None, max_length=2000)
    target_type: DecisionTarget = "workflow"
    target_id: str | None = Field(default=None, min_length=1, max_length=120)
    workflow_id: str | None = Field(default=None, min_length=1, max_length=120)


class OwnerDecisionResponse(BaseModel):
    project_id: str
    item_id: str
    title: str
    source: str
    action: DecisionAction
    detail: str | None = None
    target_type: DecisionTarget
    target_id: str | None = None
    workflow_id: str | None = None
    applied_effect: str | None = None
    decided_at: str
    decided_by: str


def _owner_state_key(project_id: str) -> str:
    return f"daacs:owner_ops:state:{project_id}"


def _fallback_state(project_id: str) -> Dict[str, Any]:
    return {
        "decisions": list(_DECISION_LOGS.get(project_id, [])),
        "team_runs": dict(_TEAM_RUN_STATE.get(project_id, {})),
        "incidents": dict(_INCIDENT_STATE.get(project_id, {})),
    }


def _sync_fallback_state(project_id: str, state: Dict[str, Any]) -> None:
    _DECISION_LOGS[project_id] = list(state.get("decisions", []))
    _TEAM_RUN_STATE[project_id] = dict(state.get("team_runs", {}))
    _INCIDENT_STATE[project_id] = dict(state.get("incidents", {}))


async def _load_owner_state(project_id: str) -> Dict[str, Any]:
    try:
        client = await distributed_runtime.get_redis_client()
        raw = await client.get(_owner_state_key(project_id))
        if not raw:
            return _fallback_state(project_id)
        decoded = json.loads(raw)
        if not isinstance(decoded, dict):
            return _fallback_state(project_id)
        return {
            "decisions": list(decoded.get("decisions", [])),
            "team_runs": dict(decoded.get("team_runs", {})),
            "incidents": dict(decoded.get("incidents", {})),
        }
    except Exception as exc:
        logger.warning("OwnerOps state load fallback for project=%s: %s", project_id, exc)
        return _fallback_state(project_id)


async def _save_owner_state(project_id: str, state: Dict[str, Any]) -> None:
    _sync_fallback_state(project_id, state)
    try:
        client = await distributed_runtime.get_redis_client()
        await client.set(_owner_state_key(project_id), json.dumps(state), ex=60 * 60 * 24 * 7)
    except Exception as exc:
        logger.warning("OwnerOps state save fallback for project=%s: %s", project_id, exc)


async def _resume_workflow(
    project_id: str,
    workflow_id: str,
    workflow_name: str,
    goal: str | None,
    params: Dict[str, Any] | None,
) -> str:
    resolved_goal = (goal or "").strip() or _WORKFLOW_DEFAULT_GOALS.get(
        workflow_name,
        f"Execute workflow '{workflow_name}' successfully.",
    )
    resolved_params = params or {}
    try:
        return await resume_workflow_distributed(
            project_id=project_id,
            workflow_id=workflow_id,
            workflow_name=workflow_name,
            goal=resolved_goal,
            params=resolved_params,
        )
    except KeyError:
        return "resume_failed_project_not_clocked_in"
    except TimeoutError:
        return "resume_timeout"
    except WorkflowConflictError as exc:
        logger.info("resume_workflow conflict project=%s workflow=%s detail=%s", project_id, workflow_id, exc)
        return "resume_conflict"
    except RuntimeError as exc:
        logger.warning("resume_workflow runtime error project=%s: %s", project_id, exc)
        return "resume_runtime_unavailable"


async def _apply_workflow_decision(project_id: str, workflow_id: str, action: DecisionAction) -> str:
    workflow = await load_workflow_from_db(project_id, workflow_id)
    if workflow is None:
        return "workflow_not_found"

    if action == "approved":
        return await _resume_workflow(
            project_id=project_id,
            workflow_id=workflow_id,
            workflow_name=workflow.get("workflow_name", "feature_development"),
            goal=workflow.get("goal"),
            params=workflow.get("params") or {},
        )

    target_status = "paused" if action == "hold" else "cancelled"
    try:
        await stop_workflow_distributed(project_id, workflow_id)
    except Exception as exc:
        logger.warning("stop_workflow_distributed warning project=%s workflow=%s: %s", project_id, workflow_id, exc)
    await persist_workflow_status(workflow_id, status=target_status)
    return f"workflow_{target_status}"


def _apply_team_run_decision(state: Dict[str, Any], target_id: str, action: DecisionAction) -> str:
    team_runs = dict(state.get("team_runs", {}))
    new_status = "running" if action == "approved" else "paused" if action == "hold" else "cancelled"
    team_runs[target_id] = new_status
    state["team_runs"] = team_runs
    return f"team_run_{new_status}"


def _apply_incident_decision(state: Dict[str, Any], target_id: str, action: DecisionAction) -> str:
    incidents = dict(state.get("incidents", {}))
    new_status = "resolved" if action == "approved" else "monitoring" if action == "hold" else "escalated"
    incidents[target_id] = new_status
    state["incidents"] = incidents
    return f"incident_{new_status}"


@router.get("/{project_id}/status")
async def get_owner_ops_status(
    project_id: str,
    _project=Depends(require_project_access),
) -> Dict[str, Any]:
    state = await _load_owner_state(project_id)
    return {
        "project_id": project_id,
        "team_runs": state.get("team_runs", {}),
        "incidents": state.get("incidents", {}),
        "decisions_count": len(state.get("decisions", [])),
    }


@router.post("/{project_id}/decisions", response_model=OwnerDecisionResponse)
async def submit_owner_decision(
    project_id: str,
    req: OwnerDecisionRequest,
    _project=Depends(require_project_access),
    user: User = Depends(get_current_user),
) -> OwnerDecisionResponse:
    target_id = req.target_id or req.workflow_id or req.item_id
    workflow_id = req.workflow_id or (target_id if req.target_type == "workflow" else None)

    state = await _load_owner_state(project_id)
    applied_effect: str | None = None
    if req.target_type == "workflow" and workflow_id:
        applied_effect = await _apply_workflow_decision(project_id, workflow_id, req.action)
    elif req.target_type == "team_run":
        applied_effect = _apply_team_run_decision(state, target_id, req.action)
    elif req.target_type == "incident":
        applied_effect = _apply_incident_decision(state, target_id, req.action)

    record = {
        "project_id": project_id,
        "item_id": req.item_id,
        "title": req.title,
        "source": req.source,
        "action": req.action,
        "detail": req.detail,
        "target_type": req.target_type,
        "target_id": target_id,
        "workflow_id": workflow_id,
        "applied_effect": applied_effect,
        "decided_at": datetime.now().isoformat(),
        "decided_by": user.email,
    }
    decisions = list(state.get("decisions", []))
    decisions.append(record)
    state["decisions"] = decisions
    await _save_owner_state(project_id, state)
    return OwnerDecisionResponse(**record)


@router.get("/{project_id}/decisions")
async def list_owner_decisions(
    project_id: str,
    limit: int = 50,
    _project=Depends(require_project_access),
) -> Dict[str, Any]:
    state = await _load_owner_state(project_id)
    rows = state.get("decisions", [])
    safe_limit = max(1, min(limit, 200))
    return {"project_id": project_id, "items": rows[-safe_limit:]}

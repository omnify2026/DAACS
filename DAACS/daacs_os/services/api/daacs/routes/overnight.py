"""Overnight workflow API endpoints."""

from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from ..application.persistence_service import (
    load_active_workflow_for_project_from_db,
    load_workflow_from_db,
    persist_workflow_started,
    update_workflow_fields,
)
from ..application.workflow_service import _WORKFLOW_DEFAULT_GOALS, ensure_project_runtime_exists
from ..core.deps import require_project_access

router = APIRouter(prefix="/api/workflows", tags=["overnight"])


def _celery_client():
    from celery import Celery

    redis_host = os.getenv("REDIS_HOST", "redis")
    redis_port = os.getenv("REDIS_PORT", "6379")
    broker = os.getenv("CELERY_BROKER_URL", f"redis://{redis_host}:{redis_port}/0")
    backend = os.getenv("CELERY_RESULT_BACKEND", f"redis://{redis_host}:{redis_port}/1")
    return Celery("daacs_api_client", broker=broker, backend=backend)


class OvernightConstraints(BaseModel):
    max_runtime_minutes: int = Field(default=480, ge=1, le=1440)
    max_spend_usd: float = Field(default=5.0, gt=0)
    max_iterations: int = Field(default=20, ge=1, le=200)
    allowed_tools: List[str] = Field(default_factory=list)
    blocked_commands: List[str] = Field(default_factory=list)


class ResumePolicy(BaseModel):
    max_retries_per_gate: int = Field(default=3, ge=0, le=20)
    max_total_retries: int = Field(default=12, ge=0, le=200)


class OvernightStartRequest(BaseModel):
    workflow_name: str = "feature_development"
    goal: str | None = None
    constraints: OvernightConstraints = Field(default_factory=OvernightConstraints)
    definition_of_done: List[str] = Field(default_factory=list)
    verification_profile: str = Field(default="default")
    quality_threshold: int = Field(default=7, ge=0, le=10)
    resume_policy: ResumePolicy = Field(default_factory=ResumePolicy)
    start_at: Optional[datetime] = None
    deadline_at: Optional[datetime] = None
    params: Dict[str, Any] = Field(default_factory=dict)


class OvernightResumeRequest(BaseModel):
    additional_budget_usd: float = Field(default=0, ge=0)
    additional_time_minutes: int = Field(default=0, ge=0)
    additional_iterations: int = Field(default=0, ge=0)


def _resolve_goal(workflow_name: str, raw_goal: str | None) -> str:
    goal = (raw_goal or "").strip()
    if goal:
        return goal
    return _WORKFLOW_DEFAULT_GOALS.get(
        workflow_name,
        f"Execute workflow '{workflow_name}' successfully.",
    )


async def _ensure_manager(project_id: str) -> None:
    ok = await ensure_project_runtime_exists(project_id)
    if not ok:
        raise HTTPException(
            status_code=404,
            detail=f"Project {project_id} not found. POST /api/projects/{project_id}/clock-in first.",
        )


async def _ensure_no_active_workflow(project_id: str) -> None:
    active = await load_active_workflow_for_project_from_db(project_id)
    if active is None:
        return
    raise HTTPException(
        status_code=409,
        detail=(
            "Another workflow is already active "
            f"(id={active.get('id')}, status={active.get('status', 'unknown')})."
        ),
    )


def _normalize_deadline(req: OvernightStartRequest) -> datetime:
    if req.deadline_at is not None:
        deadline = req.deadline_at
        if deadline.tzinfo is None:
            deadline = deadline.replace(tzinfo=timezone.utc)
        return deadline
    now = datetime.now(timezone.utc)
    return now + timedelta(minutes=req.constraints.max_runtime_minutes)

def _normalize_start_at(start_at: Optional[datetime]) -> Optional[datetime]:
    if start_at is None:
        return None
    normalized = start_at
    if normalized.tzinfo is None:
        normalized = normalized.replace(tzinfo=timezone.utc)
    return normalized


@router.post("/{project_id}/overnight")
async def start_overnight(
    project_id: str,
    req: OvernightStartRequest,
    _project_id: str = Depends(require_project_access),
) -> Dict[str, Any]:
    await _ensure_manager(project_id)
    await _ensure_no_active_workflow(project_id)
    run_id = str(uuid.uuid4())
    goal = _resolve_goal(req.workflow_name, req.goal)
    deadline_at = _normalize_deadline(req)
    start_at = _normalize_start_at(req.start_at)

    overnight_config: Dict[str, Any] = {
        "mode": "overnight",
        "constraints": req.constraints.model_dump(),
        "definition_of_done": req.definition_of_done,
        "verification_profile": req.verification_profile,
        "quality_threshold": req.quality_threshold,
        "resume_policy": req.resume_policy.model_dump(),
        "start_at": start_at.isoformat() if start_at else None,
        "deadline_at": deadline_at.isoformat(),
        "gate_results": [],
        "retries": {"per_gate": {}, "total": 0},
        "state": "queued",
    }
    merged_params = {**req.params, "overnight_mode": True, "run_id": run_id}

    await persist_workflow_started(
        workflow_id=run_id,
        project_id=project_id,
        workflow_name=req.workflow_name,
        goal=goal,
        params=merged_params,
    )
    await update_workflow_fields(
        run_id,
        {
            "status": "queued",
            "overnight_config": overnight_config,
            "deadline_at": deadline_at,
        },
    )

    client = _celery_client()
    try:
        send_kwargs: Dict[str, Any] = {}
        if start_at is not None and start_at > datetime.now(timezone.utc):
            send_kwargs["eta"] = start_at
        async_result = client.send_task(
            "daacs.worker.tasks.workflow.run",
            kwargs={
                "run_id": run_id,
                "project_id": project_id,
                "goal": goal,
                "workflow_name": req.workflow_name,
                "params": merged_params,
                "config": overnight_config,
            },
            **send_kwargs,
        )
    except Exception as exc:
        await update_workflow_fields(run_id, {"status": "error"})
        raise HTTPException(status_code=500, detail=f"Failed to dispatch overnight run: {exc}") from exc

    overnight_config["celery_task_id"] = async_result.id
    initial_status = "queued" if (start_at is not None and start_at > datetime.now(timezone.utc)) else "running"
    overnight_config["state"] = initial_status
    await update_workflow_fields(run_id, {"status": initial_status, "overnight_config": overnight_config})
    return {
        "status": "started",
        "project_id": project_id,
        "run_id": run_id,
        "workflow_name": req.workflow_name,
        "goal": goal,
        "deadline_at": deadline_at.isoformat(),
        "task_id": async_result.id,
    }


@router.get("/{project_id}/overnight/{run_id}")
async def get_overnight_status(
    project_id: str,
    run_id: str,
    _project_id: str = Depends(require_project_access),
) -> Dict[str, Any]:
    await _ensure_manager(project_id)
    row = await load_workflow_from_db(project_id, run_id)
    if row is None:
        raise HTTPException(status_code=404, detail=f"Overnight run {run_id} not found")
    return {
        "run_id": run_id,
        "status": row.get("status"),
        "goal": row.get("goal"),
        "spent_usd": row.get("spent_usd", 0),
        "deadline_at": row.get("deadline_at"),
        "overnight_config": row.get("overnight_config", {}),
        "steps": row.get("steps", []),
    }


@router.post("/{project_id}/overnight/{run_id}/stop")
async def stop_overnight(
    project_id: str,
    run_id: str,
    _project_id: str = Depends(require_project_access),
) -> Dict[str, Any]:
    await _ensure_manager(project_id)
    row = await load_workflow_from_db(project_id, run_id)
    if row is None:
        raise HTTPException(status_code=404, detail=f"Overnight run {run_id} not found")

    overnight_config = row.get("overnight_config", {}) or {}
    task_id = overnight_config.get("celery_task_id")
    if task_id:
        _celery_client().control.revoke(task_id, terminate=True)

    overnight_config["state"] = "stopped_with_report"
    await update_workflow_fields(
        run_id,
        {
            "status": "stopped_with_report",
            "overnight_config": overnight_config,
        },
    )
    return {"status": "stopped_with_report", "run_id": run_id}


@router.post("/{project_id}/overnight/{run_id}/resume")
async def resume_overnight(
    project_id: str,
    run_id: str,
    req: OvernightResumeRequest,
    _project_id: str = Depends(require_project_access),
) -> Dict[str, Any]:
    await _ensure_manager(project_id)
    row = await load_workflow_from_db(project_id, run_id)
    if row is None:
        raise HTTPException(status_code=404, detail=f"Overnight run {run_id} not found")
    if row.get("status") not in {"recovering", "needs_human", "stopped_with_report"}:
        raise HTTPException(status_code=409, detail=f"Run status '{row.get('status')}' is not resumable")

    overnight_config = row.get("overnight_config", {}) or {}
    constraints = overnight_config.get("constraints", {})
    constraints["max_spend_usd"] = float(constraints.get("max_spend_usd", 0)) + req.additional_budget_usd
    constraints["max_runtime_minutes"] = int(constraints.get("max_runtime_minutes", 0)) + req.additional_time_minutes
    constraints["max_iterations"] = int(constraints.get("max_iterations", 0)) + req.additional_iterations
    overnight_config["constraints"] = constraints
    overnight_config["state"] = "queued"

    params = row.get("params", {}) or {}
    params["overnight_mode"] = True
    params["run_id"] = run_id

    task = _celery_client().send_task(
        "daacs.worker.tasks.workflow.run",
        kwargs={
            "run_id": run_id,
            "project_id": project_id,
            "goal": row.get("goal", ""),
            "workflow_name": row.get("workflow_name", "feature_development"),
            "params": params,
            "config": overnight_config,
            "resume": True,
        },
    )
    overnight_config["celery_task_id"] = task.id
    await update_workflow_fields(
        run_id,
        {
            "status": "running",
            "params": params,
            "overnight_config": overnight_config,
        },
    )
    return {"status": "running", "run_id": run_id, "task_id": task.id}


@router.get("/{project_id}/overnight/{run_id}/report")
async def get_overnight_report(
    project_id: str,
    run_id: str,
    _project_id: str = Depends(require_project_access),
) -> Dict[str, Any]:
    await _ensure_manager(project_id)
    row = await load_workflow_from_db(project_id, run_id)
    if row is None:
        raise HTTPException(status_code=404, detail=f"Overnight run {run_id} not found")

    overnight_config = row.get("overnight_config", {}) or {}
    gates = overnight_config.get("gate_results", [])
    hard_failures = [
        g for g in gates
        if bool(g.get("hard")) and g.get("verdict") != "pass"
    ]
    return {
        "run_id": run_id,
        "goal": row.get("goal"),
        "final_status": row.get("status"),
        "spent_usd": row.get("spent_usd", 0),
        "deadline_at": row.get("deadline_at"),
        "gate_results": gates,
        "hard_failures": hard_failures,
        "logs_tail": (row.get("steps", []) or [])[-20:],
        "next_actions": overnight_config.get("next_actions", []),
    }

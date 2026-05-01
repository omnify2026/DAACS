"""Workflow endpoints for workflow lifecycle."""

import uuid
from typing import Any, Dict, List

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from ..application.persistence_service import (
    load_workflow_from_db,
    load_workflows_for_project_from_db,
)
from ..application.workflow_service import (
    _WORKFLOW_DEFAULT_GOALS,
    WorkflowConflictError,
    ensure_project_runtime_exists,
    start_workflow_distributed,
    stop_workflow_distributed,
)
from ..core.deps import require_project_access

router = APIRouter(prefix="/api", tags=["workflows"])


class StartWorkflowRequest(BaseModel):
    workflow_name: str = "feature_development"
    goal: str | None = None
    params: Dict[str, Any] = Field(default_factory=dict)


class WorkflowStatusResponse(BaseModel):
    id: str
    workflow_name: str
    status: str
    current_step: int
    total_steps: int
    steps: List[Dict[str, Any]]


async def _ensure_runtime(project_id: str) -> None:
    ok = await ensure_project_runtime_exists(project_id)
    if not ok:
        raise HTTPException(
            status_code=404,
            detail=f"Project {project_id} not found. POST /api/projects/{project_id}/clock-in first.",
        )


def _render_workflow_conflict(exc: WorkflowConflictError) -> str:
    detail = str(exc).strip()
    if detail.startswith("workflow_conflict:active:"):
        parts = detail.split(":")
        if len(parts) >= 4:
            return f"Another workflow is already active (id={parts[2]}, status={parts[3]})."
        return "Another workflow is already active."
    if detail.startswith("workflow_conflict:not_resumable:"):
        parts = detail.split(":")
        if len(parts) >= 3:
            return f"Workflow is not resumable from status '{parts[2]}'."
    return detail or "Workflow state conflict."


@router.post("/workflows/{project_id}/start")
async def start_workflow(
    project_id: str,
    req: StartWorkflowRequest,
    _project_id: str = Depends(require_project_access),
) -> Dict[str, Any]:
    await _ensure_runtime(project_id)

    goal = (req.goal or "").strip() or _WORKFLOW_DEFAULT_GOALS.get(
        req.workflow_name,
        f"Execute workflow '{req.workflow_name}' successfully.",
    )

    try:
        return await start_workflow_distributed(
            project_id=project_id,
            workflow_name=req.workflow_name,
            goal=goal,
            params=req.params,
        )
    except WorkflowConflictError as exc:
        raise HTTPException(status_code=409, detail=_render_workflow_conflict(exc)) from exc
    except TimeoutError as exc:
        raise HTTPException(status_code=503, detail=f"Workflow start timeout for project {project_id}") from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=f"Workflow runtime unavailable: {exc}") from exc


@router.get("/workflows/{project_id}")
async def list_workflows(
    project_id: str,
    _project_id: str = Depends(require_project_access),
) -> List[Dict[str, Any]]:
    await _ensure_runtime(project_id)
    return await load_workflows_for_project_from_db(project_id)


@router.get("/workflows/{project_id}/{workflow_id}")
async def get_workflow_status(
    project_id: str,
    workflow_id: str,
    _project_id: str = Depends(require_project_access),
) -> WorkflowStatusResponse:
    await _ensure_runtime(project_id)
    wf = await load_workflow_from_db(project_id, workflow_id)
    if wf is None:
        raise HTTPException(status_code=404, detail=f"Workflow {workflow_id} not found")
    return WorkflowStatusResponse(
        id=wf.get("id", workflow_id),
        workflow_name=wf.get("workflow_name", ""),
        status=wf.get("status", "unknown"),
        current_step=int(wf.get("current_step", 0)),
        total_steps=int(wf.get("total_steps", 0)),
        steps=wf.get("steps", []),
    )


@router.post("/workflows/{project_id}/{workflow_id}/stop")
async def stop_workflow(
    project_id: str,
    workflow_id: str,
    _project_id: str = Depends(require_project_access),
) -> Dict[str, Any]:
    await _ensure_runtime(project_id)
    wf = await load_workflow_from_db(project_id, workflow_id)
    if wf is None:
        raise HTTPException(status_code=404, detail=f"Workflow {workflow_id} not found")

    try:
        return await stop_workflow_distributed(project_id, workflow_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=f"Workflow {workflow_id} not found") from exc
    except TimeoutError as exc:
        raise HTTPException(status_code=503, detail=f"Workflow stop timeout for project {project_id}") from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=f"Workflow runtime unavailable: {exc}") from exc

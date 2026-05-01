"""Team endpoints extracted from the workflow router."""

from typing import Any, Dict, List

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from ..agents.teams import AgentTeam
from ..application.workflow_service import manager_action
from ..core.deps import require_project_access

router = APIRouter(prefix="/api", tags=["teams"])


class TeamTaskRequest(BaseModel):
    team: str
    instruction: str
    context: Dict[str, Any] = Field(default_factory=dict)


class TeamTaskItem(BaseModel):
    team: str
    instruction: str
    context: Dict[str, Any] = Field(default_factory=dict)


class TeamParallelRequest(BaseModel):
    items: List[TeamTaskItem] = Field(default_factory=list)


async def _call_manager(project_id: str, action: str, args: Dict[str, Any]) -> Any:
    try:
        return await manager_action(project_id, action, args=args, timeout_seconds=30.0)
    except KeyError as exc:
        raise HTTPException(
            status_code=404,
            detail=f"Project {project_id} not found. POST /api/projects/{project_id}/clock-in first.",
        ) from exc
    except TimeoutError as exc:
        raise HTTPException(status_code=503, detail=f"Runtime timeout for project {project_id}") from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=f"Runtime unavailable: {exc}") from exc


@router.get("/teams")
async def get_teams() -> List[Dict[str, Any]]:
    from ..agents.teams import list_teams

    return list_teams()


@router.post("/teams/{project_id}/task")
async def submit_team_task(
    project_id: str,
    req: TeamTaskRequest,
    _project_id: str = Depends(require_project_access),
) -> Dict[str, Any]:
    try:
        team = AgentTeam(req.team)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"Unknown team: {req.team}") from exc

    task_ids = await _call_manager(
        project_id,
        "submit_team_task",
        {
            "team": team.value,
            "instruction": req.instruction,
            "context": req.context or None,
        },
    )

    return {
        "status": "team_submitted",
        "project_id": project_id,
        "team": team.value,
        "task_ids": task_ids,
        "agent_count": len(task_ids),
    }


@router.post("/teams/{project_id}/parallel")
async def submit_parallel_team_tasks(
    project_id: str,
    req: TeamParallelRequest,
    _project_id: str = Depends(require_project_access),
) -> Dict[str, Any]:
    if not req.items:
        raise HTTPException(status_code=400, detail="items is required")

    submitted: Dict[str, Any] = {}
    errors: List[Dict[str, str]] = []

    for item in req.items:
        try:
            team = AgentTeam(item.team)
        except ValueError:
            errors.append({"team": item.team, "error": "unknown_team"})
            continue

        task_ids = await _call_manager(
            project_id,
            "submit_team_task",
            {
                "team": team.value,
                "instruction": item.instruction,
                "context": item.context or None,
            },
        )
        submitted[team.value] = {
            "instruction": item.instruction[:120],
            "task_ids": task_ids,
            "agent_count": len(task_ids),
        }

    return {
        "status": "team_parallel_submitted",
        "project_id": project_id,
        "submitted": submitted,
        "errors": errors,
    }


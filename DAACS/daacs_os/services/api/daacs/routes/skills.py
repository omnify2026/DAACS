"""Skill endpoints extracted from the workflow router."""

from typing import Any, Dict

from fastapi import APIRouter, Depends, HTTPException

from ..agents.base_roles import AgentRole
from ..application.workflow_service import manager_action
from ..core.deps import require_project_access

router = APIRouter(prefix="/api", tags=["skills"])


async def _call_manager(project_id: str, action: str, args: Dict[str, Any]) -> Any:
    try:
        return await manager_action(project_id, action, args=args, timeout_seconds=10.0)
    except KeyError as exc:
        raise HTTPException(
            status_code=404,
            detail=f"Project {project_id} not found. POST /api/projects/{project_id}/clock-in first.",
        ) from exc
    except TimeoutError as exc:
        raise HTTPException(status_code=503, detail=f"Runtime timeout for project {project_id}") from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=f"Runtime unavailable: {exc}") from exc


@router.get("/skills/bundles")
async def get_skill_bundles() -> Dict[str, Any]:
    from ..skills.loader import SkillLoader

    loader = SkillLoader()
    return loader.get_bundle_summary()


@router.get("/skills/{project_id}/{role}")
async def get_agent_skills(
    project_id: str,
    role: str,
    _project_id: str = Depends(require_project_access),
) -> Dict[str, Any]:
    try:
        _ = AgentRole(role)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"Unknown role: {role}") from exc

    result = await _call_manager(project_id, "get_skill_bundle", {"role": role})
    if not result.get("loaded"):
        return {"role": role, "skills": [], "loaded": False}
    return result


"""Natural-language agent factory endpoints."""

from __future__ import annotations

import uuid
from typing import Any, Dict, List

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.deps import get_current_user, get_db, require_project_access
from ..db.models import CustomAgent, User

router = APIRouter(prefix="/api/agent-factory", tags=["agent-factory"])


class CreateAgentRequest(BaseModel):
    prompt: str = Field(..., min_length=3, max_length=2000)
    preferred_role: str | None = Field(default=None)
    color: str | None = Field(default=None)


def _extract_name(prompt: str) -> str:
    base = prompt.strip().split(".")[0]
    base = " ".join(base.split())
    if len(base) > 40:
        base = base[:40].rstrip()
    return base or "Custom Agent"


def _extract_role(preferred_role: str | None, prompt: str) -> str:
    role = (preferred_role or "").strip().lower()
    if role:
        return role
    text = prompt.lower()
    if "verify" in text or "verification" in text or "test" in text or "qa" in text or "check" in text:
        return "verifier"
    if "design" in text:
        return "designer"
    if "market" in text:
        return "marketer"
    if "review" in text:
        return "reviewer"
    if "deploy" in text or "infra" in text:
        return "devops"
    return "developer"


@router.post("/{project_id}/create")
async def create_custom_agent(
    req: CreateAgentRequest,
    project_uuid: uuid.UUID = Depends(require_project_access),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    used_count_result = await db.execute(
        select(func.count(CustomAgent.id)).where(CustomAgent.user_id == current_user.id)
    )
    used_count = int(used_count_result.scalar_one() or 0)
    if used_count >= current_user.agent_slots:
        raise HTTPException(
            status_code=402,
            detail="Agent slot limit reached. Purchase additional slots to place more agents.",
        )

    agent = CustomAgent(
        project_id=project_uuid,
        user_id=current_user.id,
        name=_extract_name(req.prompt),
        role=_extract_role(req.preferred_role, req.prompt),
        prompt=req.prompt.strip(),
        skills=[],
        color=req.color,
    )
    db.add(agent)
    await db.flush()

    used_count += 1
    if current_user.custom_agent_count != used_count:
        current_user.custom_agent_count = used_count
        db.add(current_user)
        await db.flush()

    return {
        "status": "created",
        "project_id": str(project_uuid),
        "agent": {
            "id": str(agent.id),
            "name": agent.name,
            "role": agent.role,
            "prompt": agent.prompt,
            "color": agent.color,
        },
        "slot": {
            "used": used_count,
            "total": current_user.agent_slots,
            "remaining": max(0, current_user.agent_slots - used_count),
        },
    }


@router.post("/{project_id}/unlock-slot")
async def unlock_slot(
    _project: uuid.UUID = Depends(require_project_access),
    _current_user: User = Depends(get_current_user),
    _db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    raise HTTPException(
        status_code=503,
        detail="Slot purchase is temporarily unavailable. Payment integration pending.",
    )


@router.get("/{project_id}/list")
async def list_custom_agents(
    project_uuid: uuid.UUID = Depends(require_project_access),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, List[Dict[str, Any]]]:
    rows = await db.execute(
        select(CustomAgent)
        .where(
            CustomAgent.user_id == current_user.id,
            CustomAgent.project_id == project_uuid,
        )
        .order_by(CustomAgent.created_at.asc())
    )
    custom_agents = rows.scalars().all()

    agents = [
        {
            "id": str(agent.id),
            "name": agent.name,
            "role": agent.role,
            "prompt": agent.prompt,
            "color": agent.color,
        }
        for agent in custom_agents
    ]
    return {"agents": agents}

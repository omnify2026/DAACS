"""Agent endpoints extracted from the workflow router."""

import asyncio
import logging
import uuid
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..agents.base_roles import AgentRole
from ..agents.manager import AgentManager
from ..application.persistence_service import load_agent_events, load_task_history
from ..application.workflow_service import (
    manager_action,
    register_manager_with_ownership,
    sanitize_project_cwd,
)
from ..core import distributed_runtime
from ..core.deps import get_db, require_project_access
from ..db.models import Project
from .agents_ws import ws_manager

logger = logging.getLogger("daacs.routes.agents")
router = APIRouter(prefix="/api", tags=["agents"])


class AgentCommandRequest(BaseModel):
    command: Optional[str] = None
    message: Optional[str] = None
    context: Dict[str, Any] = Field(default_factory=dict)

    @property
    def resolved_command(self) -> str:
        return (self.command or self.message or "").strip()


class AgentTaskRequest(BaseModel):
    instruction: str
    context: Dict[str, Any] = Field(default_factory=dict)


class BroadcastTaskRequest(BaseModel):
    instruction: str
    roles: Optional[List[str]] = None


class LlmRoleOverrideRequest(BaseModel):
    cli: Optional[str] = Field(default=None, pattern="^(codex|claude|gemini)$")
    tier: Optional[str] = Field(default=None, pattern="^(flash|standard|high|max)$")
    model: Optional[str] = Field(default=None, min_length=1, max_length=120)


class LlmSettingsRequest(BaseModel):
    codex_only: Optional[bool] = None
    codex_model: Optional[str] = Field(default=None, min_length=1, max_length=120)
    role_overrides: Dict[str, LlmRoleOverrideRequest] = Field(default_factory=dict)


def _resolve_agent(role: str) -> AgentRole:
    try:
        return AgentRole(role)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"Unknown role: {role}") from exc


async def _call_manager(
    project_id: str,
    action: str,
    args: Optional[Dict[str, Any]] = None,
    timeout_seconds: float = 15.0,
) -> Any:
    try:
        return await manager_action(project_id, action, args=args, timeout_seconds=timeout_seconds)
    except KeyError as exc:
        raise HTTPException(
            status_code=404,
            detail=f"Project {project_id} not found. POST /api/projects/{project_id}/clock-in first.",
        ) from exc
    except TimeoutError as exc:
        raise HTTPException(status_code=503, detail=f"Runtime timeout for project {project_id}") from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=f"Runtime unavailable: {exc}") from exc


def _agent_event_broadcaster(project_id: str):
    def event_broadcaster(event):
        try:
            loop = asyncio.get_running_loop()
            loop.create_task(ws_manager.broadcast_to_project(project_id, event))
        except RuntimeError:
            pass

    return event_broadcaster


def _normalize_llm_settings(payload: Dict[str, Any]) -> Dict[str, Any]:
    normalized: Dict[str, Any] = {}
    if "codex_only" in payload and payload["codex_only"] is not None:
        normalized["codex_only"] = bool(payload["codex_only"])

    codex_model = (payload.get("codex_model") or "").strip()
    if codex_model:
        normalized["codex_model"] = codex_model

    role_overrides: Dict[str, Dict[str, Any]] = {}
    for role_name, override in (payload.get("role_overrides") or {}).items():
        if role_name not in {r.value for r in AgentRole}:
            continue
        clean: Dict[str, Any] = {}
        for key in ("cli", "tier", "model"):
            value = getattr(override, key, None) if hasattr(override, key) else override.get(key)
            if isinstance(value, str):
                value = value.strip()
            if value:
                clean[key] = value
        if clean:
            role_overrides[role_name] = clean

    if role_overrides:
        normalized["role_overrides"] = role_overrides

    return normalized


@router.get("/agents/{project_id}")
async def get_all_agents(
    project_id: str,
    _project_id: str = Depends(require_project_access),
) -> List[Dict[str, Any]]:
    return await _call_manager(project_id, "get_all_states")


@router.get("/agents/{project_id}/{role}")
async def get_agent(
    project_id: str,
    role: str,
    _project_id: str = Depends(require_project_access),
) -> Dict[str, Any]:
    agent_role = _resolve_agent(role)
    state = await _call_manager(project_id, "get_agent_state", {"role": agent_role.value})
    if state is None:
        raise HTTPException(status_code=404, detail=f"Agent {role} not found")
    return state


@router.post("/agents/{project_id}/{role}/command")
async def send_agent_command(
    project_id: str,
    role: str,
    req: AgentCommandRequest,
    _project_id: str = Depends(require_project_access),
) -> Dict[str, Any]:
    command = req.resolved_command
    if not command:
        raise HTTPException(status_code=400, detail="command/message is required")

    agent_role = _resolve_agent(role)
    result = await _call_manager(
        project_id,
        "send_command",
        {"role": agent_role.value, "command": command},
    )
    if isinstance(result, dict) and "error" in result:
        raise HTTPException(status_code=500, detail=result["error"])

    return {
        "status": result.get("status", "sent"),
        "agent_role": role,
        "message": result.get("command", command),
    }


@router.post("/projects/{project_id}/clock-in")
async def clock_in(
    project_id: str,
    project_cwd: Optional[str] = None,
    _project_id: uuid.UUID = Depends(require_project_access),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    if project_id in {"", "none"}:
        raise HTTPException(status_code=400, detail="project_id is required")

    # If runtime already exists (local or remote), keep single project owner.
    try:
        await _call_manager(project_id, "has_manager", timeout_seconds=3.0)
        return {"status": "already_clocked_in", "project_id": project_id}
    except HTTPException as exc:
        if exc.status_code != 404:
            raise

    manager = AgentManager(project_id=project_id, event_broadcaster=_agent_event_broadcaster(project_id))
    manager.clock_in()
    project = await db.scalar(select(Project).where(Project.id == _project_id))
    llm_overrides = {}
    if project and isinstance(project.config, dict):
        llm_overrides = project.config.get("llm", {}) or {}
    manager.set_llm_overrides(llm_overrides)

    owner = await register_manager_with_ownership(project_id, manager)
    if owner != distributed_runtime.instance_id():
        return {
            "status": "already_clocked_in",
            "project_id": project_id,
            "owner_instance": owner,
        }

    safe_project_cwd = sanitize_project_cwd(project_cwd)
    try:
        await manager.start_server(ws_manager, project_cwd=safe_project_cwd)
    except Exception as exc:
        logger.warning("AgentServer start failed (non-fatal): %s", exc)

    return {
        "status": "clocked_in",
        "project_id": project_id,
        "agents": manager.get_all_states(),
        "streaming": manager.agent_server is not None and manager.agent_server.is_started,
    }


@router.get("/projects/{project_id}/llm-settings")
async def get_project_llm_settings(
    project_id: str,
    _project_id: uuid.UUID = Depends(require_project_access),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    project = await db.scalar(select(Project).where(Project.id == _project_id))
    if project is None:
        raise HTTPException(status_code=404, detail=f"Project {project_id} not found")
    settings = {}
    if isinstance(project.config, dict):
        settings = project.config.get("llm", {}) or {}
    return {"project_id": project_id, "llm": settings}


@router.put("/projects/{project_id}/llm-settings")
async def update_project_llm_settings(
    project_id: str,
    req: LlmSettingsRequest,
    _project_id: uuid.UUID = Depends(require_project_access),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    project = await db.scalar(select(Project).where(Project.id == _project_id))
    if project is None:
        raise HTTPException(status_code=404, detail=f"Project {project_id} not found")

    config = dict(project.config or {})
    config["llm"] = _normalize_llm_settings(req.model_dump())
    project.config = config
    db.add(project)
    await db.flush()

    try:
        await _call_manager(project_id, "set_llm_overrides", {"llm": config["llm"]}, timeout_seconds=5.0)
    except HTTPException as exc:
        if exc.status_code != 404:
            raise

    return {"status": "saved", "project_id": project_id, "llm": config["llm"]}


@router.post("/projects/{project_id}/clock-out")
async def clock_out(
    project_id: str,
    _project_id: str = Depends(require_project_access),
) -> Dict[str, Any]:
    return await _call_manager(project_id, "clock_out", timeout_seconds=20.0)


@router.post("/agents/{project_id}/{role}/stream-task")
async def stream_agent_task(
    project_id: str,
    role: str,
    req: AgentTaskRequest,
    _project_id: str = Depends(require_project_access),
) -> Dict[str, Any]:
    agent_role = _resolve_agent(role)
    instruction = req.instruction.strip()
    if not instruction:
        raise HTTPException(status_code=400, detail="instruction is required")

    await _call_manager(
        project_id,
        "launch_stream_task",
        {
            "role": agent_role.value,
            "instruction": instruction,
            "context": req.context or None,
        },
        timeout_seconds=10.0,
    )

    return {
        "status": "streaming",
        "agent": role,
        "instruction": instruction[:100],
        "note": "Watch WebSocket for AGENT_STREAM_CHUNK / AGENT_TOOL_CALL events",
    }


@router.get("/agents/{project_id}/server-status")
async def get_agent_server_status(
    project_id: str,
    _project_id: str = Depends(require_project_access),
) -> Dict[str, Any]:
    return await _call_manager(project_id, "get_server_status", timeout_seconds=5.0)


@router.post("/agents/{project_id}/start-parallel")
async def start_parallel(
    project_id: str,
    _project_id: str = Depends(require_project_access),
) -> Dict[str, Any]:
    return await _call_manager(project_id, "start_parallel", timeout_seconds=20.0)


@router.post("/agents/{project_id}/stop-parallel")
async def stop_parallel(
    project_id: str,
    _project_id: str = Depends(require_project_access),
) -> Dict[str, Any]:
    return await _call_manager(project_id, "stop_parallel", timeout_seconds=20.0)


@router.get("/agents/{project_id}/parallel-status")
async def parallel_status(
    project_id: str,
    _project_id: str = Depends(require_project_access),
) -> Dict[str, Any]:
    return await _call_manager(project_id, "parallel_status")


@router.post("/agents/{project_id}/{role}/task")
async def submit_agent_task(
    project_id: str,
    role: str,
    req: AgentTaskRequest,
    _project_id: str = Depends(require_project_access),
) -> Dict[str, Any]:
    agent_role = _resolve_agent(role)
    response = await _call_manager(
        project_id,
        "submit_task",
        {
            "role": agent_role.value,
            "instruction": req.instruction,
            "context": req.context or None,
        },
    )
    task_id = (response or {}).get("task_id")
    if task_id is None:
        raise HTTPException(status_code=404, detail=f"Agent {role} not found")

    return {
        "status": "submitted",
        "agent": role,
        "task_id": task_id,
        "instruction": req.instruction[:100],
    }


@router.get("/agents/{project_id}/{role}/task/{task_id}")
async def get_agent_task_result(
    project_id: str,
    role: str,
    task_id: str,
    _project_id: str = Depends(require_project_access),
) -> Dict[str, Any]:
    agent_role = _resolve_agent(role)
    result = await _call_manager(
        project_id,
        "get_task_result",
        {"role": agent_role.value, "task_id": task_id},
    )
    if result is None:
        raise HTTPException(status_code=404, detail=f"Task {task_id} not found")
    return {"agent": role, "task_id": task_id, **result}


@router.get("/agents/{project_id}/{role}/history")
async def get_agent_task_history(
    project_id: str,
    role: str,
    limit: int = 50,
    _project_id: str = Depends(require_project_access),
) -> List[Dict[str, Any]]:
    agent_role = _resolve_agent(role)
    safe_limit = max(1, min(limit, 200))
    return await load_task_history(project_id, agent_role.value, safe_limit)


@router.get("/agents/{project_id}/{role}/events")
async def get_agent_events(
    project_id: str,
    role: str,
    event_type: Optional[str] = None,
    limit: int = 50,
    _project_id: str = Depends(require_project_access),
) -> List[Dict[str, Any]]:
    agent_role = _resolve_agent(role)
    safe_limit = max(1, min(limit, 200))
    normalized_event_type = (event_type or "").strip() or None
    return await load_agent_events(project_id, agent_role.value, normalized_event_type, safe_limit)


@router.post("/agents/{project_id}/broadcast")
async def broadcast_task(
    project_id: str,
    req: BroadcastTaskRequest,
    _project_id: str = Depends(require_project_access),
) -> Dict[str, Any]:
    roles = None
    if req.roles:
        try:
            roles = [AgentRole(r).value for r in req.roles]
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=f"Unknown role: {exc}") from exc

    task_ids = await _call_manager(
        project_id,
        "broadcast_task",
        {
            "instruction": req.instruction,
            "roles": roles,
            "context": None,
        },
    )
    return {
        "status": "broadcast",
        "instruction": req.instruction[:100],
        "task_ids": task_ids,
        "agent_count": len(task_ids),
    }

"""Runtime compatibility endpoints for the current Python backend.

The web client already depends on the runtime / plans / execution-intent
surface that exists in the Rust backend. Until the Python backend reaches
feature parity, this router provides a minimal but executable compatibility
layer so the browser flow can load, inspect plans, and submit approval-style
intents without spamming 404s.
"""

from __future__ import annotations

import uuid
from copy import deepcopy
from datetime import datetime, timezone
from typing import Any, Dict, List, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..application.workflow_service import ensure_project_runtime_exists, manager_action
from ..core.deps import get_db, require_project_access
from ..db.models import Project

router = APIRouter(prefix="/api", tags=["runtime"])

JsonDict = Dict[str, Any]
RuntimeStatus = Literal["idle", "planning", "working", "waiting_approval", "completed", "failed"]
PlanStatus = Literal["draft", "active", "paused", "completed", "failed"]
StepStatus = Literal[
    "pending",
    "blocked",
    "in_progress",
    "awaiting_approval",
    "approved",
    "completed",
    "failed",
    "skipped",
]
IntentStatus = Literal[
    "draft",
    "pending_approval",
    "approved",
    "rejected",
    "executing",
    "completed",
    "failed",
]

SERVICE_ROLES: tuple[str, ...] = (
    "ceo",
    "pm",
    "developer",
    "reviewer",
    "verifier",
    "devops",
    "marketer",
    "designer",
    "cfo",
)

ROLE_META: Dict[str, Dict[str, Any]] = {
    "ceo": {
        "name": "CEO",
        "title": "CEO",
        "color": "#8B5CF6",
        "icon": "Crown",
        "home_zone": "ceo_office",
        "team": "executive_team",
        "authority": 100,
        "capabilities": ["strategy", "approval"],
    },
    "pm": {
        "name": "PM",
        "title": "프로젝트 매니저",
        "color": "#6366F1",
        "icon": "ClipboardList",
        "home_zone": "meeting_room",
        "team": "executive_team",
        "authority": 80,
        "capabilities": ["planning", "delivery"],
    },
    "developer": {
        "name": "Developer",
        "title": "Developer",
        "color": "#3B82F6",
        "icon": "Code",
        "home_zone": "rd_lab",
        "team": "development_team",
        "authority": 50,
        "capabilities": ["implementation", "backend", "frontend"],
    },
    "reviewer": {
        "name": "Reviewer",
        "title": "Reviewer",
        "color": "#EF4444",
        "icon": "Search",
        "home_zone": "rd_lab",
        "team": "review_team",
        "authority": 55,
        "capabilities": ["review", "quality"],
    },
    "verifier": {
        "name": "Verifier",
        "title": "Verifier",
        "color": "#14B8A6",
        "icon": "ShieldCheck",
        "home_zone": "server_farm",
        "team": "review_team",
        "authority": 55,
        "capabilities": ["verification", "qa", "e2e"],
    },
    "devops": {
        "name": "DevOps",
        "title": "데브옵스 엔지니어",
        "color": "#10B981",
        "icon": "Terminal",
        "home_zone": "server_farm",
        "team": "operations_team",
        "authority": 50,
        "capabilities": ["deployment", "monitoring"],
    },
    "marketer": {
        "name": "Marketer",
        "title": "마케터",
        "color": "#EC4899",
        "icon": "Megaphone",
        "home_zone": "marketing_studio",
        "team": "marketing_team",
        "authority": 45,
        "capabilities": ["content", "distribution"],
    },
    "designer": {
        "name": "Designer",
        "title": "UI/UX 디자이너",
        "color": "#F97316",
        "icon": "Palette",
        "home_zone": "design_studio",
        "team": "creative_team",
        "authority": 45,
        "capabilities": ["design", "assets"],
    },
    "cfo": {
        "name": "CFO",
        "title": "재무",
        "color": "#EAB308",
        "icon": "Calculator",
        "home_zone": "finance_room",
        "team": "finance_team",
        "authority": 60,
        "capabilities": ["budget", "finance", "risk"],
    },
}

RUNTIME_OVERRIDES: Dict[str, JsonDict] = {}
PROJECT_PLANS: Dict[str, Dict[str, JsonDict]] = {}
PROJECT_EXECUTION_INTENTS: Dict[str, Dict[str, JsonDict]] = {}
ACTIVE_PLAN_STATUS = "active"
OPEN_STEP_STATUSES = {"pending", "in_progress"}
PENDING_INTENT_STATUS = "pending_approval"
APPROVED_INTENT_STATUS = "approved"
RUNTIME_COMPAT_CONFIG_KEY = "runtime_compat_state"


class BootstrapRuntimeBody(BaseModel):
    company_name: Optional[str] = None
    blueprint_ids: Optional[List[str]] = None
    execution_mode: Optional[Literal["manual", "assisted", "autonomous"]] = None


class UpdateOfficeProfileBody(BaseModel):
    office_profile: JsonDict


class CreatePlanBody(BaseModel):
    goal: str = Field(..., min_length=1, max_length=2000)


class ExecutePlanBody(BaseModel):
    execution_track: Optional[Literal["local_cli", "server"]] = None


class ApproveStepBody(BaseModel):
    note: Optional[str] = None
    execution_track: Optional[Literal["local_cli", "server"]] = None
    approver_id: Optional[str] = None


class CompleteStepBody(BaseModel):
    input: Optional[Any] = None
    output: Any
    status: Literal["completed", "failed"] = "completed"


class CreateExecutionIntentBody(BaseModel):
    agent_id: str = Field(..., min_length=1, max_length=200)
    agent_role: str = Field(..., min_length=1, max_length=120)
    kind: Literal[
        "open_pull_request",
        "deploy_release",
        "publish_content",
        "launch_campaign",
        "publish_asset",
        "run_ops_action",
        "submit_budget_update",
    ]
    title: str = Field(..., min_length=1, max_length=300)
    description: str = Field(..., min_length=1, max_length=4000)
    target: str = Field(..., min_length=1, max_length=500)
    connector_id: str = Field(..., min_length=1, max_length=200)
    payload: Any = Field(default_factory=dict)
    requires_approval: bool = True


class DecideExecutionIntentBody(BaseModel):
    action: Literal["approved", "hold", "rejected"]
    note: Optional[str] = None
    execution_track: Optional[Literal["local_cli", "server"]] = None


class CompleteExecutionIntentBody(BaseModel):
    status: Literal["completed", "failed"] = "completed"
    result_summary: str = Field(..., min_length=1, max_length=4000)
    result_payload: Optional[Any] = None
    note: Optional[str] = None


def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


async def _ensure_runtime(project_id: str) -> None:
    ok = await ensure_project_runtime_exists(project_id)
    if not ok:
        raise HTTPException(
            status_code=404,
            detail=f"Project {project_id} not found. POST /api/projects/{project_id}/clock-in first.",
        )


async def _project_name(project_uuid: uuid.UUID, db: AsyncSession) -> str:
    project = await db.scalar(select(Project).where(Project.id == project_uuid))
    if project is None or not project.name.strip():
        return "DAACS Runtime"
    return project.name.strip()


def _runtime_id(project_id: str) -> str:
    return f"runtime-{project_id}"


def _default_org_graph(project_id: str) -> JsonDict:
    return {
        "project_id": project_id,
        "zones": {},
    }


def _status_from_manager(status: str | None) -> RuntimeStatus:
    normalized = (status or "").strip().lower()
    if normalized in {"working", "reviewing"}:
        return "working"
    if normalized in {"meeting"}:
        return "planning"
    if normalized in {"error", "failed"}:
        return "failed"
    if normalized in {"celebrating", "completed"}:
        return "completed"
    if normalized in {"waiting_approval", "awaiting_approval"}:
        return "waiting_approval"
    return "idle"


async def _manager_state_index(project_id: str) -> Dict[str, JsonDict]:
    try:
        states = await manager_action(project_id, "get_all_states")
    except Exception:
        return {}
    if not isinstance(states, list):
        return {}
    index: Dict[str, JsonDict] = {}
    for item in states:
        if not isinstance(item, dict):
            continue
        role = str(item.get("role") or "").strip().lower()
        if role:
            index[role] = item
    return index


def _build_blueprint(role: str) -> JsonDict:
    meta = ROLE_META[role]
    now = _utcnow()
    return {
        "id": f"bp-{role}",
        "name": meta["name"],
        "role_label": role,
        "capabilities": list(meta["capabilities"]),
        "prompt_bundle_ref": role,
        "skill_bundle_refs": [],
        "tool_policy": {},
        "permission_policy": {},
        "memory_policy": {},
        "collaboration_policy": {},
        "approval_policy": {
            "mode": "owner_review" if role in {"developer", "reviewer", "verifier"} else "self",
            "external_actions_require_approval": role in {"developer", "reviewer", "verifier"},
            "default_approver": "agent-ceo" if role != "ceo" else None,
        },
        "ui_profile": {
            "display_name": meta["name"],
            "title": meta["title"],
            "avatar_style": "default",
            "accent_color": meta["color"],
            "icon": meta["icon"],
            "home_zone": meta["home_zone"],
            "team_affinity": meta["team"],
            "authority_level": meta["authority"],
            "capability_tags": list(meta["capabilities"]),
            "primary_widgets": [],
            "secondary_widgets": [],
            "focus_mode": "default",
            "meeting_behavior": "standard",
        },
        "is_builtin": True,
        "owner_user_id": "system",
        "created_at": now,
        "updated_at": now,
    }


def _build_instance(role: str, manager_state: Optional[JsonDict]) -> JsonDict:
    runtime_status = _status_from_manager(
        str(manager_state.get("status") if manager_state else "")
    )
    current_task = str(manager_state.get("current_task") if manager_state else "").strip()
    return {
        "instance_id": f"agent-{role}",
        "blueprint_id": f"bp-{role}",
        "project_id": "",
        "runtime_status": runtime_status,
        "assigned_team": ROLE_META[role]["team"],
        "current_tasks": [current_task] if current_task else [],
        "context_window_state": {},
        "memory_bindings": {},
        "live_metrics": {},
        "created_at": _utcnow(),
        "updated_at": _utcnow(),
    }


def _plan_store(project_id: str) -> Dict[str, JsonDict]:
    return PROJECT_PLANS.setdefault(project_id, {})


def _intent_store(project_id: str) -> Dict[str, JsonDict]:
    return PROJECT_EXECUTION_INTENTS.setdefault(project_id, {})


def _runtime_override(project_id: str) -> JsonDict:
    return RUNTIME_OVERRIDES.setdefault(
        project_id,
        {
            "created_at": _utcnow(),
            "updated_at": _utcnow(),
            "execution_mode": "manual",
            "org_graph": _default_org_graph(project_id),
            "owner_ops_state": {"status": "idle", "pending_approvals": []},
            "meeting_protocol": {
                "meeting_style": "runtime_aware",
                "participant_instance_ids": ["agent-pm", "agent-reviewer", "agent-verifier"],
            },
            "approval_graph": {"owner_gate": ["agent-ceo"]},
            "shared_boards": {"artifacts": [], "channels": ["planning", "execution", "review"]},
        },
    )


def _runtime_compat_snapshot(project_id: str) -> JsonDict:
    return {
        "runtime_override": deepcopy(RUNTIME_OVERRIDES.get(project_id) or {}),
        "plans": deepcopy(PROJECT_PLANS.get(project_id) or {}),
        "execution_intents": deepcopy(PROJECT_EXECUTION_INTENTS.get(project_id) or {}),
    }


async def _project_config_row(project_uuid: uuid.UUID, db: AsyncSession) -> Any | None:
    try:
        if hasattr(db, "get"):
            return await db.get(Project, project_uuid)  # type: ignore[attr-defined]
        return await db.scalar(select(Project).where(Project.id == project_uuid))
    except Exception:
        return None


async def _hydrate_runtime_compat_state(
    project_id: str,
    project_uuid: uuid.UUID,
    db: AsyncSession,
) -> None:
    if project_id in RUNTIME_OVERRIDES or project_id in PROJECT_PLANS or project_id in PROJECT_EXECUTION_INTENTS:
        return
    project = await _project_config_row(project_uuid, db)
    config = getattr(project, "config", None)
    if not isinstance(config, dict):
        return
    state = config.get(RUNTIME_COMPAT_CONFIG_KEY)
    if not isinstance(state, dict):
        return
    runtime_override = state.get("runtime_override")
    plans = state.get("plans")
    intents = state.get("execution_intents")
    if isinstance(runtime_override, dict) and runtime_override:
        RUNTIME_OVERRIDES[project_id] = deepcopy(runtime_override)
    if isinstance(plans, dict):
        PROJECT_PLANS[project_id] = deepcopy(plans)
    if isinstance(intents, dict):
        PROJECT_EXECUTION_INTENTS[project_id] = deepcopy(intents)


async def _persist_runtime_compat_state(
    project_id: str,
    project_uuid: uuid.UUID,
    db: AsyncSession,
) -> None:
    project = await _project_config_row(project_uuid, db)
    if project is None:
        return
    config = getattr(project, "config", None)
    if not isinstance(config, dict):
        config = {}
    project.config = {
        **config,
        RUNTIME_COMPAT_CONFIG_KEY: _runtime_compat_snapshot(project_id),
    }
    commit = getattr(db, "commit", None)
    if callable(commit):
        await commit()


async def _build_runtime_bundle(
    project_id: str,
    project_uuid: uuid.UUID,
    db: AsyncSession,
) -> JsonDict:
    project_name = await _project_name(project_uuid, db)
    override = _runtime_override(project_id)
    manager_states = await _manager_state_index(project_id)

    blueprints = [_build_blueprint(role) for role in SERVICE_ROLES]
    instances = [_build_instance(role, manager_states.get(role)) for role in SERVICE_ROLES]
    for instance in instances:
        instance["project_id"] = project_id

    runtime = {
        "runtime_id": _runtime_id(project_id),
        "project_id": project_id,
        "company_name": project_name,
        "org_graph": deepcopy(override.get("org_graph") or _default_org_graph(project_id)),
        "agent_instance_ids": [instance["instance_id"] for instance in instances],
        "meeting_protocol": deepcopy(override.get("meeting_protocol") or {}),
        "approval_graph": deepcopy(override.get("approval_graph") or {}),
        "shared_boards": deepcopy(override.get("shared_boards") or {}),
        "execution_mode": override.get("execution_mode") or "manual",
        "owner_ops_state": deepcopy(override.get("owner_ops_state") or {}),
        "created_at": override.get("created_at") or _utcnow(),
        "updated_at": override.get("updated_at") or _utcnow(),
    }
    return {
        "runtime": runtime,
        "instances": instances,
        "blueprints": blueprints,
    }


def _default_plan_steps() -> List[JsonDict]:
    return [
        {
            "step_id": "step-pm-clarify",
            "label": "Clarify scope",
            "description": "Turn the latest request into an executable scope and acceptance criteria.",
            "assigned_to": "agent-pm",
            "depends_on": [],
            "approval_required_by": None,
            "status": "pending",
            "required_capabilities": ["planning"],
            "selection_reason": "PM owns scoping and coordination.",
            "approval_reason": None,
            "planner_notes": "Capture concrete deliverables before implementation.",
            "parallel_group": None,
            "input": {},
            "output": {},
            "started_at": None,
            "completed_at": None,
        },
        {
            "step_id": "step-dev-implement",
            "label": "Implement the change",
            "description": "Apply the requested change and update the main deliverable.",
            "assigned_to": "agent-developer",
            "depends_on": ["step-pm-clarify"],
            "approval_required_by": None,
            "status": "pending",
            "required_capabilities": ["implementation"],
            "selection_reason": "Developer owns production changes.",
            "approval_reason": None,
            "planner_notes": "Focus on the smallest change that satisfies the goal.",
            "parallel_group": None,
            "input": {},
            "output": {},
            "started_at": None,
            "completed_at": None,
        },
        {
            "step_id": "step-review-quality",
            "label": "Review output quality",
            "description": "Inspect user-facing quality, regressions, and missing evidence.",
            "assigned_to": "agent-reviewer",
            "depends_on": ["step-dev-implement"],
            "approval_required_by": "agent-ceo",
            "status": "blocked",
            "required_capabilities": ["review"],
            "selection_reason": "Reviewer checks quality before release.",
            "approval_reason": "Owner approval is required before verification closes the plan.",
            "planner_notes": "Highlight concrete blockers, not general commentary.",
            "parallel_group": None,
            "input": {},
            "output": {},
            "started_at": None,
            "completed_at": None,
        },
        {
            "step_id": "step-verify-e2e",
            "label": "Verify end-to-end",
            "description": "Re-run the user flow and confirm the modified output behaves correctly.",
            "assigned_to": "agent-verifier",
            "depends_on": ["step-review-quality"],
            "approval_required_by": None,
            "status": "blocked",
            "required_capabilities": ["verification", "e2e"],
            "selection_reason": "Verifier owns executable proof.",
            "approval_reason": None,
            "planner_notes": "Collect browser or API evidence for the final state.",
            "parallel_group": None,
            "input": {},
            "output": {},
            "started_at": None,
            "completed_at": None,
        },
    ]


def _dependencies_satisfied(plan: JsonDict, step: JsonDict) -> bool:
    by_id = {candidate["step_id"]: candidate for candidate in plan.get("steps", [])}
    for dep_id in step.get("depends_on", []):
        dep = by_id.get(dep_id)
        if dep is None:
            return False
        if dep.get("status") not in {"approved", "completed", "skipped"}:
            return False
    return True


def _find_plan_step(plan: JsonDict, step_id: str) -> JsonDict:
    step = next((item for item in plan["steps"] if item["step_id"] == step_id), None)
    if step is None:
        raise HTTPException(status_code=404, detail="Step not found")
    return step


def _ensure_plan_active(plan: JsonDict) -> None:
    if plan.get("status") != ACTIVE_PLAN_STATUS:
        raise HTTPException(status_code=400, detail="Plan is not active")


def _valid_approver_ids() -> set[str]:
    return {f"agent-{role}" for role in SERVICE_ROLES}


def _ensure_step_can_complete(plan: JsonDict, step: JsonDict, next_status: str) -> None:
    _ensure_plan_active(plan)
    current_status = step.get("status")
    if current_status in {"completed", "approved", "failed", "skipped"}:
        raise HTTPException(status_code=400, detail="Step is already closed")
    if next_status == "completed":
        if current_status not in OPEN_STEP_STATUSES:
            raise HTTPException(status_code=400, detail="Step is not ready to complete")
        if current_status in {"blocked", "awaiting_approval"}:
            raise HTTPException(status_code=400, detail="Step is not ready to complete")
        if step.get("approval_required_by"):
            raise HTTPException(status_code=400, detail="Step requires approval before it can close")
        if not _dependencies_satisfied(plan, step):
            raise HTTPException(status_code=400, detail="Step dependencies are not satisfied")


def _ensure_step_can_approve(step: JsonDict, approver_id: Optional[str]) -> None:
    required_approver = step.get("approval_required_by")
    if step.get("status") != "awaiting_approval":
        raise HTTPException(status_code=400, detail="Step is not awaiting approval")
    if not required_approver:
        raise HTTPException(status_code=400, detail="Step does not require approval")
    if required_approver not in _valid_approver_ids():
        raise HTTPException(status_code=400, detail="Step requires a valid approver")
    effective_approver = (approver_id or "").strip()
    if not effective_approver:
        raise HTTPException(status_code=400, detail="Step requires an explicit approver")
    if effective_approver != required_approver:
        raise HTTPException(status_code=403, detail="Step is assigned to a different approver")


def _refresh_plan_status(plan: JsonDict) -> None:
    if plan.get("status") in {"draft", "paused", "completed", "failed"}:
        return

    steps = plan.get("steps", [])
    all_terminal = all(step.get("status") in {"approved", "completed", "failed", "skipped"} for step in steps)
    any_failed = any(step.get("status") == "failed" for step in steps)
    if any_failed:
        plan["status"] = "failed"
    elif all_terminal and steps:
        plan["status"] = "completed"
    elif plan.get("status") == "draft":
        plan["status"] = "draft"
    else:
        plan["status"] = "active"

    for step in steps:
        if step.get("status") == "blocked" and _dependencies_satisfied(plan, step):
            step["status"] = (
                "awaiting_approval" if step.get("approval_required_by") else "pending"
            )


def _get_plan(project_id: str, plan_id: str) -> JsonDict:
    plan = _plan_store(project_id).get(plan_id)
    if plan is None:
        raise HTTPException(status_code=404, detail="Plan not found")
    return plan


def _get_intent(project_id: str, intent_id: str) -> JsonDict:
    intent = _intent_store(project_id).get(intent_id)
    if intent is None:
        raise HTTPException(status_code=404, detail="Execution intent not found")
    return intent


@router.get("/projects/{project_id}/runtime")
async def get_project_runtime(
    project_id: str,
    project_uuid: uuid.UUID = Depends(require_project_access),
    db: AsyncSession = Depends(get_db),
) -> JsonDict:
    await _ensure_runtime(project_id)
    await _hydrate_runtime_compat_state(project_id, project_uuid, db)
    return await _build_runtime_bundle(project_id, project_uuid, db)


@router.post("/projects/{project_id}/runtime/bootstrap")
async def bootstrap_runtime(
    project_id: str,
    body: BootstrapRuntimeBody,
    project_uuid: uuid.UUID = Depends(require_project_access),
    db: AsyncSession = Depends(get_db),
) -> JsonDict:
    await _ensure_runtime(project_id)
    await _hydrate_runtime_compat_state(project_id, project_uuid, db)
    override = _runtime_override(project_id)
    if body.execution_mode:
        override["execution_mode"] = body.execution_mode
    override["updated_at"] = _utcnow()
    bundle = await _build_runtime_bundle(project_id, project_uuid, db)
    if body.company_name and body.company_name.strip():
        bundle["runtime"]["company_name"] = body.company_name.strip()
    await _persist_runtime_compat_state(project_id, project_uuid, db)
    return bundle


@router.put("/projects/{project_id}/runtime/office-profile")
async def update_project_office_profile(
    project_id: str,
    body: UpdateOfficeProfileBody,
    project_uuid: uuid.UUID = Depends(require_project_access),
    db: AsyncSession = Depends(get_db),
) -> JsonDict:
    await _ensure_runtime(project_id)
    await _hydrate_runtime_compat_state(project_id, project_uuid, db)
    override = _runtime_override(project_id)
    org_graph = deepcopy(override.get("org_graph") or _default_org_graph(project_id))
    org_graph["office_profile"] = deepcopy(body.office_profile)
    zones = {}
    for zone in body.office_profile.get("zones", []) if isinstance(body.office_profile, dict) else []:
        if not isinstance(zone, dict):
            continue
        zone_id = str(zone.get("id") or "").strip()
        if not zone_id:
            continue
        zones[zone_id] = {
            "label": zone.get("label"),
            "accent_color": zone.get("accent_color"),
            "row": zone.get("row"),
            "col": zone.get("col"),
            "row_span": zone.get("row_span"),
            "col_span": zone.get("col_span"),
            "preset": zone.get("preset"),
            "label_position": zone.get("label_position"),
        }
    org_graph["zones"] = zones
    override["org_graph"] = org_graph
    override["updated_at"] = _utcnow()
    await _persist_runtime_compat_state(project_id, project_uuid, db)
    return await _build_runtime_bundle(project_id, project_uuid, db)


@router.get("/projects/{project_id}/plans")
async def list_project_plans(
    project_id: str,
    project_uuid: uuid.UUID = Depends(require_project_access),
    db: AsyncSession = Depends(get_db),
) -> List[JsonDict]:
    await _ensure_runtime(project_id)
    await _hydrate_runtime_compat_state(project_id, project_uuid, db)
    return [deepcopy(plan) for plan in _plan_store(project_id).values()]


@router.post("/projects/{project_id}/plans")
async def create_project_plan(
    project_id: str,
    body: CreatePlanBody,
    project_uuid: uuid.UUID = Depends(require_project_access),
    db: AsyncSession = Depends(get_db),
) -> JsonDict:
    await _ensure_runtime(project_id)
    await _hydrate_runtime_compat_state(project_id, project_uuid, db)
    plan_id = f"plan-{uuid.uuid4()}"
    now = _utcnow()
    plan = {
        "plan_id": plan_id,
        "runtime_id": _runtime_id(project_id),
        "goal": body.goal.strip(),
        "created_by": "pm",
        "planner_version": "python-compat-v1",
        "planning_mode": "compat",
        "plan_rationale": "Compatibility plan generated by the Python runtime bridge.",
        "revision": 1,
        "steps": _default_plan_steps(),
        "status": "draft",
        "created_at": now,
        "updated_at": now,
    }
    _plan_store(project_id)[plan_id] = plan
    await _persist_runtime_compat_state(project_id, project_uuid, db)
    return deepcopy(plan)


@router.get("/projects/{project_id}/plans/{plan_id}")
async def get_project_plan(
    project_id: str,
    plan_id: str,
    project_uuid: uuid.UUID = Depends(require_project_access),
    db: AsyncSession = Depends(get_db),
) -> JsonDict:
    await _ensure_runtime(project_id)
    await _hydrate_runtime_compat_state(project_id, project_uuid, db)
    return deepcopy(_get_plan(project_id, plan_id))


@router.post("/projects/{project_id}/plans/{plan_id}/execute")
async def execute_project_plan(
    project_id: str,
    plan_id: str,
    _body: ExecutePlanBody,
    project_uuid: uuid.UUID = Depends(require_project_access),
    db: AsyncSession = Depends(get_db),
) -> JsonDict:
    await _ensure_runtime(project_id)
    await _hydrate_runtime_compat_state(project_id, project_uuid, db)
    plan = _get_plan(project_id, plan_id)
    if plan["status"] == "draft":
        plan["status"] = "active"
        plan["updated_at"] = _utcnow()
    _refresh_plan_status(plan)
    await _persist_runtime_compat_state(project_id, project_uuid, db)
    return deepcopy(plan)


@router.get("/projects/{project_id}/plans/{plan_id}/ready-steps")
async def list_ready_steps(
    project_id: str,
    plan_id: str,
    project_uuid: uuid.UUID = Depends(require_project_access),
    db: AsyncSession = Depends(get_db),
) -> List[JsonDict]:
    await _ensure_runtime(project_id)
    await _hydrate_runtime_compat_state(project_id, project_uuid, db)
    plan = _get_plan(project_id, plan_id)
    _refresh_plan_status(plan)
    _ensure_plan_active(plan)
    ready = [
        deepcopy(step)
        for step in plan.get("steps", [])
        if step.get("status") == "pending"
        and step.get("approval_required_by") is None
        and _dependencies_satisfied(plan, step)
    ]
    return ready


@router.post("/projects/{project_id}/plans/{plan_id}/steps/{step_id}/complete")
async def complete_plan_step(
    project_id: str,
    plan_id: str,
    step_id: str,
    body: CompleteStepBody,
    project_uuid: uuid.UUID = Depends(require_project_access),
    db: AsyncSession = Depends(get_db),
) -> JsonDict:
    await _ensure_runtime(project_id)
    await _hydrate_runtime_compat_state(project_id, project_uuid, db)
    plan = _get_plan(project_id, plan_id)
    step = _find_plan_step(plan, step_id)
    _ensure_step_can_complete(plan, step, body.status)
    step["input"] = deepcopy(body.input)
    step["output"] = deepcopy(body.output)
    step["status"] = body.status
    now = _utcnow()
    step["started_at"] = step.get("started_at") or now
    step["completed_at"] = now
    plan["updated_at"] = now
    _refresh_plan_status(plan)
    await _persist_runtime_compat_state(project_id, project_uuid, db)
    return deepcopy(plan)


@router.post("/projects/{project_id}/plans/{plan_id}/steps/{step_id}/approve")
async def approve_plan_step(
    project_id: str,
    plan_id: str,
    step_id: str,
    body: ApproveStepBody,
    project_uuid: uuid.UUID = Depends(require_project_access),
    db: AsyncSession = Depends(get_db),
) -> JsonDict:
    await _ensure_runtime(project_id)
    await _hydrate_runtime_compat_state(project_id, project_uuid, db)
    plan = _get_plan(project_id, plan_id)
    _ensure_plan_active(plan)
    step = _find_plan_step(plan, step_id)
    _ensure_step_can_approve(step, body.approver_id)
    step["status"] = "approved"
    step["approval_reason"] = body.note or step.get("approval_reason")
    now = _utcnow()
    step["completed_at"] = now
    plan["updated_at"] = now
    _refresh_plan_status(plan)
    await _persist_runtime_compat_state(project_id, project_uuid, db)
    return deepcopy(plan)


@router.get("/projects/{project_id}/execution-intents")
async def list_project_execution_intents(
    project_id: str,
    agent_id: Optional[str] = Query(default=None),
    project_uuid: uuid.UUID = Depends(require_project_access),
    db: AsyncSession = Depends(get_db),
) -> List[JsonDict]:
    await _ensure_runtime(project_id)
    await _hydrate_runtime_compat_state(project_id, project_uuid, db)
    intents = _intent_store(project_id).values()
    rows = [
        deepcopy(intent)
        for intent in intents
        if agent_id is None or intent.get("agent_id") == agent_id
    ]
    rows.sort(key=lambda item: item.get("created_at", ""))
    return rows


@router.post("/projects/{project_id}/execution-intents")
async def create_project_execution_intent(
    project_id: str,
    body: CreateExecutionIntentBody,
    project_uuid: uuid.UUID = Depends(require_project_access),
    db: AsyncSession = Depends(get_db),
) -> JsonDict:
    await _ensure_runtime(project_id)
    await _hydrate_runtime_compat_state(project_id, project_uuid, db)
    now = _utcnow()
    intent_id = f"intent-{uuid.uuid4()}"
    intent = {
        "intent_id": intent_id,
        "project_id": project_id,
        "runtime_id": _runtime_id(project_id),
        "created_by": "pm",
        "agent_id": body.agent_id,
        "agent_role": body.agent_role,
        "kind": body.kind,
        "title": body.title.strip(),
        "description": body.description.strip(),
        "target": body.target.strip(),
        "connector_id": body.connector_id.strip(),
        "payload": deepcopy(body.payload),
        "status": PENDING_INTENT_STATUS if body.requires_approval else APPROVED_INTENT_STATUS,
        "requires_approval": body.requires_approval,
        "created_at": now,
        "updated_at": now,
        "approved_at": None,
        "resolved_at": None,
        "note": None,
        "result_summary": None,
        "result_payload": None,
    }
    _intent_store(project_id)[intent_id] = intent
    await _persist_runtime_compat_state(project_id, project_uuid, db)
    return deepcopy(intent)


@router.post("/projects/{project_id}/execution-intents/{intent_id}/decision")
async def decide_execution_intent(
    project_id: str,
    intent_id: str,
    body: DecideExecutionIntentBody,
    project_uuid: uuid.UUID = Depends(require_project_access),
    db: AsyncSession = Depends(get_db),
) -> JsonDict:
    await _ensure_runtime(project_id)
    await _hydrate_runtime_compat_state(project_id, project_uuid, db)
    intent = _get_intent(project_id, intent_id)
    if intent.get("status") != PENDING_INTENT_STATUS:
        raise HTTPException(status_code=400, detail="Execution intent is not pending approval")
    now = _utcnow()
    if body.action == "approved":
        intent["status"] = APPROVED_INTENT_STATUS
        intent["approved_at"] = now
    elif body.action == "rejected":
        intent["status"] = "rejected"
        intent["resolved_at"] = now
    else:
        intent["status"] = PENDING_INTENT_STATUS
    if body.note:
        intent["note"] = body.note.strip()
    intent["updated_at"] = now
    await _persist_runtime_compat_state(project_id, project_uuid, db)
    return deepcopy(intent)


@router.post("/projects/{project_id}/execution-intents/{intent_id}/complete")
async def complete_execution_intent(
    project_id: str,
    intent_id: str,
    body: CompleteExecutionIntentBody,
    project_uuid: uuid.UUID = Depends(require_project_access),
    db: AsyncSession = Depends(get_db),
) -> JsonDict:
    await _ensure_runtime(project_id)
    await _hydrate_runtime_compat_state(project_id, project_uuid, db)
    intent = _get_intent(project_id, intent_id)
    if intent.get("status") != APPROVED_INTENT_STATUS:
        raise HTTPException(status_code=400, detail="Execution intent is not approved")
    now = _utcnow()
    intent["status"] = body.status
    intent["result_summary"] = body.result_summary.strip()
    intent["result_payload"] = deepcopy(body.result_payload)
    intent["resolved_at"] = now
    intent["updated_at"] = now
    if body.note:
        intent["note"] = body.note.strip()
    await _persist_runtime_compat_state(project_id, project_uuid, db)
    return deepcopy(intent)

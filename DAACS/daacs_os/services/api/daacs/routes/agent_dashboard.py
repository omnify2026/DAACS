"""Agent dashboard routes.

Provides per-agent dashboard payloads and read-only IDE file browsing under a
project-scoped workspace directory.
"""

from __future__ import annotations

import os
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from ..agents.base_roles import AGENT_META, AgentRole
from ..application.workflow_service import manager_action
from ..core.deps import require_project_access

router = APIRouter(prefix="/api/dashboard", tags=["dashboard"])


class DashboardResponse(BaseModel):
    role: str
    display_name: str
    status: str
    tabs: List[Dict[str, Any]]
    updated_at: str


class CostReportResponse(BaseModel):
    date: str
    daily_cap_usd: float
    spent_usd: float
    remaining_usd: float
    is_over_budget: bool
    total_calls: int
    by_role: Dict[str, float]
    by_model: Dict[str, float]


class SafetyReportResponse(BaseModel):
    turn_limit: Dict[str, Any]
    spend_cap: Dict[str, Any]


_spend_guards: Dict[str, Any] = {}
_turn_guards: Dict[str, Any] = {}
_workspaces: Dict[str, Any] = {}


_TEXT_EXTENSIONS = {
    ".py", ".ts", ".tsx", ".js", ".jsx", ".json", ".md", ".yaml", ".yml",
    ".toml", ".ini", ".css", ".scss", ".html", ".sql", ".sh", ".txt",
}
_MAX_IDE_FILES = 500
_MAX_FILE_READ_BYTES = 256 * 1024


def _get_spend_guard(project_id: str):
    if project_id not in _spend_guards:
        from ..safety.spend_cap import SpendCapGuard

        _spend_guards[project_id] = SpendCapGuard(daily_cap_usd=1.00)
    return _spend_guards[project_id]


def _get_turn_guard(project_id: str):
    if project_id not in _turn_guards:
        from ..safety.turn_limit import TurnLimitGuard

        _turn_guards[project_id] = TurnLimitGuard()
    return _turn_guards[project_id]


def _get_workspace(project_id: str):
    return _workspaces.get(project_id)


def _workspace_dir(project_id: str) -> Path:
    safe_project = "".join(ch for ch in project_id if ch.isalnum() or ch in ("-", "_"))
    if safe_project != project_id:
        raise HTTPException(status_code=400, detail="Invalid project_id")
    root = Path(os.getenv("DAACS_WORKSPACE_ROOT", "workspace")).resolve()
    return (root / safe_project).resolve()


def _ensure_subpath(parent: Path, child: Path):
    parent_resolved = parent.resolve()
    child_resolved = child.resolve()
    if child_resolved != parent_resolved and parent_resolved not in child_resolved.parents:
        raise HTTPException(status_code=400, detail="Invalid path")


def _infer_language(path: str) -> str:
    ext = Path(path).suffix.lower()
    mapping = {
        ".py": "python",
        ".ts": "typescript",
        ".tsx": "tsx",
        ".js": "javascript",
        ".jsx": "jsx",
        ".json": "json",
        ".md": "markdown",
        ".yaml": "yaml",
        ".yml": "yaml",
        ".toml": "toml",
        ".css": "css",
        ".scss": "scss",
        ".html": "html",
        ".sql": "sql",
        ".sh": "bash",
    }
    return mapping.get(ext, "text")


def _build_ceo_tabs(project_id: str, _agent_state: Dict[str, Any]) -> List[Dict[str, Any]]:
    report = _get_spend_guard(project_id).get_report()
    return [
        {
            "id": "kpi",
            "label": "KPI Summary",
            "data": {
                "spend_today_usd": report["spent_usd"],
                "budget_remaining_usd": report["remaining_usd"],
                "total_api_calls": report["total_calls"],
                "agent_count": len(AGENT_META),
                "by_role_cost": report["by_role"],
            },
        },
        {
            "id": "alerts",
            "label": "Alert Stream",
            "data": {"alerts": []},
        },
    ]


def _build_pm_tabs(project_id: str, agent_state: Dict[str, Any]) -> List[Dict[str, Any]]:
    ws = _get_workspace(project_id)
    kanban = ws.task_tree.to_kanban() if ws else {}
    return [
        {
            "id": "kanban",
            "label": "Kanban Board",
            "data": kanban if kanban else {"ready": [], "in_progress": [], "review": [], "done": []},
        },
        {
            "id": "timeline",
            "label": "Timeline",
            "data": {"current_task": agent_state.get("current_task")},
        },
    ]


def _build_developer_tabs(_project_id: str, agent_state: Dict[str, Any]) -> List[Dict[str, Any]]:
    return [
        {
            "id": "code",
            "label": "Code Editor",
            "data": {
                "current_task": agent_state.get("current_task"),
                "last_output": agent_state.get("message"),
            },
        },
        {
            "id": "git",
            "label": "Git Status",
            "data": {"recent_commits": []},
        },
    ]


def _build_reviewer_tabs(_project_id: str, _agent_state: Dict[str, Any]) -> List[Dict[str, Any]]:
    return [
        {"id": "pr_list", "label": "PR List", "data": {"pull_requests": []}},
        {
            "id": "checklist",
            "label": "Review Checklist",
            "data": {
                "items": [
                    {"label": "Type safety", "checked": False},
                    {"label": "Error handling", "checked": False},
                    {"label": "Unit tests", "checked": False},
                    {"label": "No hardcoded secrets", "checked": False},
                    {"label": "Performance benchmark", "checked": False},
                ]
            },
        },
    ]


def _build_verifier_tabs(_project_id: str, agent_state: Dict[str, Any]) -> List[Dict[str, Any]]:
    return [
        {
            "id": "check_matrix",
            "label": "Check Matrix",
            "data": {
                "current_task": agent_state.get("current_task"),
                "items": [
                    {"label": "Tests executed", "checked": False},
                    {"label": "Build passes", "checked": False},
                    {"label": "Lint/type checks pass", "checked": False},
                    {"label": "Acceptance criteria covered", "checked": False},
                    {"label": "Regression evidence captured", "checked": False},
                ],
            },
        },
        {
            "id": "evidence",
            "label": "Evidence Log",
            "data": {
                "last_output": agent_state.get("message"),
                "artifacts": [],
            },
        },
    ]


def _build_devops_tabs(_project_id: str, _agent_state: Dict[str, Any]) -> List[Dict[str, Any]]:
    return [
        {"id": "server", "label": "Server Status", "data": {"containers": []}},
        {"id": "deploy_log", "label": "Deploy Logs", "data": {"logs": []}},
    ]


def _build_marketer_tabs(_project_id: str, _agent_state: Dict[str, Any]) -> List[Dict[str, Any]]:
    return [
        {"id": "seo", "label": "SEO Score", "data": {}},
        {"id": "content", "label": "Content Plan", "data": {"items": []}},
    ]


def _build_designer_tabs(_project_id: str, _agent_state: Dict[str, Any]) -> List[Dict[str, Any]]:
    return [
        {"id": "preview", "label": "UI Preview", "data": {}},
        {"id": "assets", "label": "Asset Library", "data": {"assets": []}},
    ]


def _build_cfo_tabs(project_id: str, _agent_state: Dict[str, Any]) -> List[Dict[str, Any]]:
    spend = _get_spend_guard(project_id)
    report = spend.get_report()
    history = spend.get_history(7)
    return [
        {
            "id": "runway",
            "label": "Runway",
            "data": {
                "daily_cap_usd": report["daily_cap_usd"],
                "today_spent_usd": report["spent_usd"],
                "today_remaining_usd": report["remaining_usd"],
                "history_7d": history,
            },
        },
        {
            "id": "cost_breakdown",
            "label": "Cost Breakdown",
            "data": {
                "by_role": report["by_role"],
                "by_model": report["by_model"],
                "total_calls": report["total_calls"],
            },
        },
    ]


_TAB_BUILDERS = {
    AgentRole.CEO: _build_ceo_tabs,
    AgentRole.PM: _build_pm_tabs,
    AgentRole.DEVELOPER: _build_developer_tabs,
    AgentRole.REVIEWER: _build_reviewer_tabs,
    AgentRole.VERIFIER: _build_verifier_tabs,
    AgentRole.DEVOPS: _build_devops_tabs,
    AgentRole.MARKETER: _build_marketer_tabs,
    AgentRole.DESIGNER: _build_designer_tabs,
    AgentRole.CFO: _build_cfo_tabs,
}


async def _ensure_runtime(project_id: str) -> None:
    try:
        await manager_action(project_id, "has_manager", timeout_seconds=5.0)
    except KeyError as exc:
        raise HTTPException(
            status_code=404,
            detail=f"Project {project_id} not found. POST /api/projects/{project_id}/clock-in first.",
        ) from exc
    except TimeoutError as exc:
        raise HTTPException(status_code=503, detail=f"Runtime timeout for project {project_id}") from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=f"Runtime unavailable: {exc}") from exc


@router.get("/{project_id}/{role}")
async def get_agent_dashboard(
    project_id: str,
    role: str,
    _project_id: str = Depends(require_project_access),
) -> DashboardResponse:
    await _ensure_runtime(project_id)

    try:
        agent_role = AgentRole(role)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"Unknown role: {role}") from exc

    agent_state = await manager_action(
        project_id,
        "get_agent_state",
        {"role": agent_role.value},
        timeout_seconds=10.0,
    )
    if agent_state is None:
        raise HTTPException(status_code=404, detail=f"Agent {role} not found")

    builder = _TAB_BUILDERS.get(agent_role)
    tabs = builder(project_id, agent_state) if builder else []
    meta = AGENT_META.get(agent_role, {})

    return DashboardResponse(
        role=role,
        display_name=meta.get("display_name", role),
        status=agent_state.get("status", "idle"),
        tabs=tabs,
        updated_at=datetime.now().isoformat(),
    )


@router.get("/{project_id}/cost-report")
async def get_cost_report(
    project_id: str,
    _project_id: str = Depends(require_project_access),
) -> CostReportResponse:
    await _ensure_runtime(project_id)
    report = _get_spend_guard(project_id).get_report()
    return CostReportResponse(**report)


@router.get("/{project_id}/safety-report")
async def get_safety_report(
    project_id: str,
    _project_id: str = Depends(require_project_access),
) -> SafetyReportResponse:
    await _ensure_runtime(project_id)
    return SafetyReportResponse(
        spend_cap=_get_spend_guard(project_id).get_report(),
        turn_limit=_get_turn_guard(project_id).get_report(),
    )


@router.get("/{project_id}/worktree")
async def get_worktree_status(
    project_id: str,
    _project_id: str = Depends(require_project_access),
) -> Dict[str, Any]:
    await _ensure_runtime(project_id)
    ws = _get_workspace(project_id)
    if ws is None:
        return {"status": "no_workspace", "locks": {}, "tasks": {}}
    return ws.get_workspace_state()


@router.get("/{project_id}/ide/tree")
async def get_ide_tree(
    project_id: str,
    _project_id: str = Depends(require_project_access),
) -> Dict[str, Any]:
    await _ensure_runtime(project_id)
    root = _workspace_dir(project_id)
    if not root.exists():
        return {
            "project_id": project_id,
            "exists": False,
            "root": str(root),
            "files": [],
        }

    files: List[Dict[str, Any]] = []
    for file_path in root.rglob("*"):
        if not file_path.is_file():
            continue
        if file_path.suffix.lower() not in _TEXT_EXTENSIONS:
            continue

        try:
            rel = str(file_path.relative_to(root)).replace("\\", "/")
            stat = file_path.stat()
        except OSError:
            continue

        files.append(
            {
                "path": rel,
                "size_bytes": stat.st_size,
                "modified_at": datetime.fromtimestamp(stat.st_mtime).isoformat(),
                "language": _infer_language(rel),
            }
        )
        if len(files) >= _MAX_IDE_FILES:
            break

    files.sort(key=lambda item: item["path"])
    return {
        "project_id": project_id,
        "exists": True,
        "root": str(root),
        "files": files,
        "read_only": True,
    }


@router.get("/{project_id}/ide/file")
async def get_ide_file(
    project_id: str,
    path: str,
    _project_id: str = Depends(require_project_access),
) -> Dict[str, Any]:
    await _ensure_runtime(project_id)
    root = _workspace_dir(project_id)
    if not root.exists():
        raise HTTPException(status_code=404, detail="Workspace not found")

    target = (root / path).resolve()
    _ensure_subpath(root, target)

    if not target.exists() or not target.is_file():
        raise HTTPException(status_code=404, detail=f"File not found: {path}")
    if target.stat().st_size > _MAX_FILE_READ_BYTES:
        raise HTTPException(status_code=413, detail="File too large for IDE preview")

    try:
        content = target.read_text(encoding="utf-8")
    except UnicodeDecodeError as exc:
        raise HTTPException(status_code=415, detail="Binary or non-utf8 file is not supported") from exc
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Failed to read file: {exc}") from exc

    rel = str(target.relative_to(root)).replace("\\", "/")
    return {
        "project_id": project_id,
        "path": rel,
        "language": _infer_language(rel),
        "content": content,
        "read_only": True,
    }

"""Workflow orchestration service boundaries with distributed runtime support."""

from __future__ import annotations

import asyncio
import logging
import os
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

from ..agents.base_roles import AgentRole
from ..agents.manager import AgentManager
from ..application.persistence_service import (
    ACTIVE_WORKFLOW_STATUSES,
    RESUMABLE_WORKFLOW_STATUSES,
    load_active_workflow_for_project_from_db,
    load_workflow_from_db,
    persist_workflow_started,
    persist_workflow_status,
)
from ..core import distributed_runtime
from ..graph.engine import WorkflowEngine
from ..llm.executor import LLMExecutor
from ..safety.spend_cap import SpendCapGuard
from ..safety.turn_limit import TurnLimitGuard

logger = logging.getLogger("daacs.application.workflow_service")

_managers: Dict[str, AgentManager] = {}
_workflow_tasks: Dict[str, asyncio.Task] = {}
_project_executors: Dict[str, Any] = {}
_project_workflow_locks: Dict[str, asyncio.Lock] = {}
_owner_refresh_task: asyncio.Task | None = None
_distributed_runtime_started = False

_WORKFLOW_DEFAULT_GOALS: Dict[str, str] = {
    "feature_development": "Implement the requested feature end-to-end with tests and deployment readiness.",
    "bug_fix": "Diagnose, fix, and verify the reported bug with regression safety.",
    "marketing_campaign": "Design and execute a practical marketing campaign with measurable outcomes.",
}

_WORKFLOW_STEP_ROLE_BY_NODE: Dict[str, str] = {
    "plan": "pm",
    "execute_backend": "developer",
    "execute_frontend": "developer",
    "review": "reviewer",
    "judge": "reviewer",
    "verification": "verifier",
    "verify": "verifier",
    "replanning": "pm",
    "replan": "pm",
}


class WorkflowConflictError(Exception):
    """Raised when workflow lifecycle action conflicts with current workflow state."""


def get_manager(project_id: str) -> AgentManager:
    manager = _managers.get(project_id)
    if manager is None:
        raise KeyError(f"Project {project_id} not found. POST /api/projects/{project_id}/clock-in first.")
    return manager


def register_manager(project_id: str, manager: AgentManager) -> None:
    _managers[project_id] = manager


def remove_manager(project_id: str) -> None:
    _managers.pop(project_id, None)


def release_project_executor(project_id: str) -> None:
    _project_executors.pop(project_id, None)


def _workflow_lock_for_project(project_id: str) -> asyncio.Lock:
    lock = _project_workflow_locks.get(project_id)
    if lock is None:
        lock = asyncio.Lock()
        _project_workflow_locks[project_id] = lock
    return lock


async def _owner_refresh_loop() -> None:
    interval = max(5, distributed_runtime.owner_ttl_seconds() // 3)
    while True:
        try:
            project_ids = list(_managers.keys())
            for project_id in project_ids:
                await distributed_runtime.refresh_project_owner(project_id)
            await asyncio.sleep(interval)
        except asyncio.CancelledError:
            break
        except Exception as exc:
            logger.warning("Owner refresh loop warning: %s", exc)
            await asyncio.sleep(2)


async def _rpc_handler(payload: Dict[str, Any]) -> Any:
    kind = str(payload.get("kind") or "")
    project_id = str(payload.get("project_id") or "")
    action = str(payload.get("action") or "")
    args = payload.get("args") or {}
    if not project_id:
        raise ValueError("project_id is required")
    if not action:
        raise ValueError("action is required")

    if kind == "manager_action":
        return await _handle_manager_action_local(project_id, action, args)
    if kind == "workflow_action":
        return await _handle_workflow_action_local(project_id, action, args)
    raise ValueError(f"Unsupported RPC kind: {kind}")


async def start_distributed_runtime() -> None:
    global _distributed_runtime_started, _owner_refresh_task
    if _distributed_runtime_started:
        return
    await distributed_runtime.start_rpc_server(_rpc_handler)
    _owner_refresh_task = asyncio.create_task(_owner_refresh_loop())
    _distributed_runtime_started = True


async def stop_distributed_runtime() -> None:
    global _distributed_runtime_started, _owner_refresh_task
    if not _distributed_runtime_started:
        return

    if _owner_refresh_task is not None:
        _owner_refresh_task.cancel()
        try:
            await _owner_refresh_task
        except asyncio.CancelledError:
            pass
        _owner_refresh_task = None

    for project_id in list(_managers.keys()):
        await distributed_runtime.release_project_owner(project_id)
    await distributed_runtime.stop_rpc_server()
    _distributed_runtime_started = False


def local_manager_exists(project_id: str) -> bool:
    return project_id in _managers


async def owner_for_project(project_id: str) -> Optional[str]:
    owner = await distributed_runtime.get_project_owner(project_id)
    self_id = distributed_runtime.instance_id()

    if owner == self_id and project_id not in _managers:
        await distributed_runtime.release_project_owner(project_id)
        owner = None

    if owner is None and project_id in _managers:
        owner = await distributed_runtime.ensure_project_owner(project_id)
    return owner


async def ensure_project_runtime_exists(project_id: str) -> bool:
    if project_id in _managers:
        await distributed_runtime.refresh_project_owner(project_id)
        return True
    owner = await owner_for_project(project_id)
    return bool(owner)


async def register_manager_with_ownership(project_id: str, manager: AgentManager) -> str:
    owner = await distributed_runtime.ensure_project_owner(project_id)
    local_id = distributed_runtime.instance_id()
    if owner and owner != local_id:
        return owner
    _managers[project_id] = manager
    await distributed_runtime.ensure_project_owner(project_id)
    return local_id


async def remove_manager_with_ownership(project_id: str) -> None:
    remove_manager(project_id)
    release_project_executor(project_id)
    _project_workflow_locks.pop(project_id, None)
    await distributed_runtime.release_project_owner(project_id)


def _resolve_allowed_project_roots() -> List[Path]:
    repo_root = Path(__file__).resolve().parents[4]
    roots = {
        repo_root.resolve(),
        (repo_root / "projects").resolve(),
        Path.cwd().resolve(),
    }

    for anchor in (repo_root, Path.cwd().resolve()):
        checkout_root = _discover_git_checkout_root(anchor)
        if checkout_root is not None:
            roots.add(checkout_root)

    extra_roots = os.getenv("DAACS_ALLOWED_CWD_ROOTS", "")
    for raw in extra_roots.split(os.pathsep):
        item = raw.strip()
        if not item:
            continue
        try:
            candidate = Path(item).expanduser().resolve(strict=True)
        except OSError:
            continue
        roots.add(candidate)

    return list(roots)


def _discover_git_checkout_root(start: Path) -> Path | None:
    for candidate in (start, *start.parents):
        git_marker = candidate / ".git"
        if not git_marker.exists():
            continue
        try:
            return candidate.resolve(strict=True)
        except OSError:
            continue
    return None


def _is_within_root(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def sanitize_project_cwd(project_cwd: Optional[str]) -> Optional[str]:
    if not project_cwd:
        return None

    try:
        candidate = Path(project_cwd).expanduser().resolve(strict=True)
    except OSError:
        logger.warning("Ignoring invalid project_cwd: %s", project_cwd)
        return None

    if not candidate.is_dir():
        logger.warning("Ignoring non-directory project_cwd: %s", candidate)
        return None

    for root in _resolve_allowed_project_roots():
        if _is_within_root(candidate, root):
            return str(candidate)

    logger.warning("Rejected project_cwd outside allowed roots: %s", candidate)
    return None


async def ensure_parallel_runtime(
    project_id: str,
    manager: AgentManager,
    project_cwd: Optional[str] = None,
):
    resolved_cwd = sanitize_project_cwd(project_cwd) or getattr(manager, "project_cwd", None)
    if resolved_cwd:
        manager.set_project_cwd(resolved_cwd)

    executor = _project_executors.get(project_id)
    if executor is None or (
        resolved_cwd
        and str(getattr(executor, "workspace_dir", "") or "").strip() != resolved_cwd
    ):
        spend_guard = SpendCapGuard.from_config({"daily_spend_cap_usd": 1.00})
        turn_guard = TurnLimitGuard()
        executor = LLMExecutor(
            project_id=project_id,
            spend_guard=spend_guard,
            turn_guard=turn_guard,
            workspace_dir=resolved_cwd,
            llm_overrides=getattr(manager, "llm_overrides", {}),
        )
        _project_executors[project_id] = executor

    manager.set_llm_executor(executor)
    await manager.start_all()


def _finalize_workflow_task(workflow_id: str, task: asyncio.Task) -> None:
    current = _workflow_tasks.get(workflow_id)
    if current is task:
        _workflow_tasks.pop(workflow_id, None)


def set_workflow_task(workflow_id: str, task: asyncio.Task) -> None:
    previous = _workflow_tasks.get(workflow_id)
    if previous is not None and previous is not task and not previous.done():
        previous.cancel()
    _workflow_tasks[workflow_id] = task
    task.add_done_callback(lambda done_task, wf_id=workflow_id: _finalize_workflow_task(wf_id, done_task))


def get_workflow_task(workflow_id: str) -> Optional[asyncio.Task]:
    return _workflow_tasks.get(workflow_id)


def cancel_workflow(workflow_id: str) -> bool:
    task = _workflow_tasks.get(workflow_id)
    if task and not task.done():
        task.cancel()
        return True
    return False


def _event_broadcaster(project_id: str):
    def _broadcast(event):
        try:
            from ..routes.agents_ws import ws_manager

            loop = asyncio.get_running_loop()
            loop.create_task(ws_manager.broadcast_to_project(project_id, event))
        except RuntimeError:
            pass
        except Exception as exc:
            logger.warning("Event broadcast failed for project=%s: %s", project_id, exc)

    return _broadcast


def _workflow_steps_from_result(result: Dict[str, Any]) -> List[Dict[str, Any]]:
    handoff_history = list(result.get("handoff_history", []) or [])
    if not handoff_history:
        handoff_history = [
            {
                "node": str(node_name),
                "role": _WORKFLOW_STEP_ROLE_BY_NODE.get(str(node_name), "system"),
                "iteration": int(result.get("iteration", 0) or 0),
            }
            for node_name in list(result.get("completed_handoffs", []) or [])
            if str(node_name).strip()
        ]

    steps: List[Dict[str, Any]] = []
    for index, handoff in enumerate(handoff_history, start=1):
        node = str(handoff.get("node") or "").strip()
        if not node:
            continue
        role = str(handoff.get("role") or _WORKFLOW_STEP_ROLE_BY_NODE.get(node, "system"))
        try:
            iteration = int(handoff.get("iteration", 0) or 0)
        except (TypeError, ValueError):
            iteration = 0
        step = {
            "id": f"handoff-{index}",
            "title": f"{role}:{node}",
            "node": node,
            "role": role,
            "status": "done",
            "iteration": iteration,
        }
        if node in {"verification", "verify"}:
            qa_profile = str(result.get("qa_profile") or "").strip()
            if qa_profile:
                step["qa_profile"] = qa_profile
            try:
                step["verification_confidence"] = int(result.get("verification_confidence", 0) or 0)
            except (TypeError, ValueError):
                step["verification_confidence"] = 0
            step["verification_gaps"] = [
                str(item).strip()
                for item in list(result.get("verification_gaps", []) or [])
                if str(item).strip()
            ]
        steps.append(step)
    return steps


async def _start_workflow_local(
    project_id: str,
    workflow_name: str,
    goal: str,
    params: Dict[str, Any],
) -> Dict[str, Any]:
    manager = get_manager(project_id)
    active_workflow = await load_active_workflow_for_project_from_db(project_id)
    if active_workflow is not None:
        raise WorkflowConflictError(
            f"workflow_conflict:active:{active_workflow['id']}:{active_workflow.get('status', 'unknown')}"
        )
    workflow_id = str(uuid.uuid4())

    spend_guard = SpendCapGuard.from_config({"daily_spend_cap_usd": 1.00})
    turn_guard = TurnLimitGuard()
    executor = LLMExecutor(
        project_id=project_id,
        spend_guard=spend_guard,
        turn_guard=turn_guard,
        llm_overrides=getattr(manager, "llm_overrides", {}),
    )
    engine = WorkflowEngine(
        project_id=project_id,
        llm_executor=executor,
        agent_manager=manager,
        event_broadcaster=_event_broadcaster(project_id),
    )

    async def _run_workflow():
        try:
            result = await engine.run(
                goal=goal,
                workflow_name=workflow_name,
                params=params,
            )
            steps = _workflow_steps_from_result(result)
            await persist_workflow_status(
                workflow_id,
                status=result.get("final_status", "completed"),
                steps=steps,
            )
        except asyncio.CancelledError:
            await persist_workflow_status(workflow_id, status="cancelled")
            raise
        except Exception as exc:
            logger.error("Workflow %s failed: %s", workflow_id, exc, exc_info=True)
            await persist_workflow_status(workflow_id, status="error")

    await persist_workflow_started(
        workflow_id=workflow_id,
        project_id=project_id,
        workflow_name=workflow_name,
        goal=goal,
        params=params,
    )

    task = asyncio.create_task(_run_workflow())
    set_workflow_task(workflow_id, task)
    return {
        "status": "started",
        "project_id": project_id,
        "workflow_id": workflow_id,
        "workflow_name": workflow_name,
        "goal": goal,
    }


async def _stop_workflow_local(project_id: str, workflow_id: str) -> Dict[str, Any]:
    wf = await load_workflow_from_db(project_id, workflow_id)
    if wf is None:
        raise KeyError(f"Workflow {workflow_id} not found")
    current_status = str(wf.get("status") or "unknown")

    if current_status in {"cancelled", "completed"}:
        return {"status": current_status, "workflow_id": workflow_id}

    task = get_workflow_task(workflow_id)
    if task and not task.done():
        cancel_workflow(workflow_id)
        await persist_workflow_status(workflow_id, status="cancelled")
        logger.info("Workflow %s cancelled", workflow_id)
        return {"status": "cancelled", "workflow_id": workflow_id}

    await persist_workflow_status(workflow_id, status="cancelled")
    return {"status": "cancelled", "workflow_id": workflow_id}


async def _resume_workflow_local(
    project_id: str,
    workflow_id: str,
    workflow_name: str,
    goal: str,
    params: Dict[str, Any],
) -> str:
    persisted = await load_workflow_from_db(project_id, workflow_id)
    if persisted is None:
        raise KeyError(f"Workflow {workflow_id} not found")

    current_status = str(persisted.get("status") or "unknown")
    if current_status in ACTIVE_WORKFLOW_STATUSES:
        return "workflow_already_running"
    if current_status not in RESUMABLE_WORKFLOW_STATUSES:
        raise WorkflowConflictError(f"workflow_conflict:not_resumable:{current_status}")

    task = get_workflow_task(workflow_id)
    if task and not task.done():
        return "workflow_already_running"

    manager = get_manager(project_id)
    resolved_workflow_name = (workflow_name or "").strip() or str(
        persisted.get("workflow_name") or "feature_development"
    )
    resolved_goal = (goal or "").strip() or str(persisted.get("goal") or "").strip() or _WORKFLOW_DEFAULT_GOALS.get(
        resolved_workflow_name,
        f"Execute workflow '{resolved_workflow_name}' successfully.",
    )
    resolved_params = dict(persisted.get("params") or {})
    resolved_params.update(params or {})

    spend_guard = SpendCapGuard.from_config({"daily_spend_cap_usd": 1.00})
    turn_guard = TurnLimitGuard()
    executor = LLMExecutor(
        project_id=project_id,
        spend_guard=spend_guard,
        turn_guard=turn_guard,
        llm_overrides=getattr(manager, "llm_overrides", {}),
    )
    engine = WorkflowEngine(
        project_id=project_id,
        llm_executor=executor,
        agent_manager=manager,
        event_broadcaster=_event_broadcaster(project_id),
    )

    async def _run_workflow():
        try:
            result = await engine.run(
                goal=resolved_goal,
                workflow_name=resolved_workflow_name,
                params=resolved_params,
            )
            steps = _workflow_steps_from_result(result)
            await persist_workflow_status(
                workflow_id,
                status=result.get("final_status", "completed"),
                steps=steps,
            )
        except asyncio.CancelledError:
            await persist_workflow_status(workflow_id, status="cancelled")
            raise
        except Exception as exc:
            logger.error("Resumed workflow %s failed: %s", workflow_id, exc, exc_info=True)
            await persist_workflow_status(workflow_id, status="error")

    await persist_workflow_status(workflow_id, status="running")
    run_task = asyncio.create_task(_run_workflow())
    set_workflow_task(workflow_id, run_task)
    return "workflow_resumed"


async def _handle_manager_action_local(project_id: str, action: str, args: Dict[str, Any]) -> Any:
    manager = get_manager(project_id)
    await distributed_runtime.refresh_project_owner(project_id)

    if action == "has_manager":
        return {"ok": True}
    if action == "get_all_states":
        return manager.get_all_states()
    if action == "get_agent_state":
        role = AgentRole(str(args["role"]))
        return manager.get_agent_state(role)
    if action == "send_command":
        role = AgentRole(str(args["role"]))
        return await manager.send_command(role, str(args.get("command") or ""))
    if action == "set_llm_overrides":
        manager.set_llm_overrides(args.get("llm") or {})
        return {"status": "saved"}
    if action == "clock_out":
        await manager.stop_all()
        await manager.stop_server()
        await remove_manager_with_ownership(project_id)
        return {"status": "clocked_out", "project_id": project_id}
    if action == "launch_stream_task":
        role = AgentRole(str(args["role"]))
        instruction = str(args.get("instruction") or "").strip()
        context = args.get("context") or None

        async def _run():
            try:
                await manager.execute_with_stream(role, instruction, context=context)
            except Exception as exc:
                logger.error("stream-task error project=%s role=%s: %s", project_id, role.value, exc)

        asyncio.create_task(_run())
        return {"status": "streaming", "agent": role.value}
    if action == "get_server_status":
        server = manager.agent_server
        if server is None or not server.is_started:
            return {"started": False, "project_id": project_id}
        return server.get_status()
    if action == "start_parallel":
        await ensure_parallel_runtime(project_id, manager, args.get("project_cwd"))
        return {
            "status": "parallel_started",
            "project_id": project_id,
            **manager.get_parallel_status(),
        }
    if action == "stop_parallel":
        await manager.stop_all()
        return {"status": "parallel_stopped", "project_id": project_id}
    if action == "parallel_status":
        return manager.get_parallel_status()
    if action == "submit_task":
        role = AgentRole(str(args["role"]))
        task_id = manager.submit_task(role, str(args.get("instruction") or ""), args.get("context") or None)
        return {"task_id": task_id}
    if action == "get_task_result":
        role = AgentRole(str(args["role"]))
        return manager.get_task_result(role, str(args.get("task_id") or ""))
    if action == "broadcast_task":
        roles_raw = args.get("roles")
        roles = [AgentRole(str(item)) for item in roles_raw] if roles_raw else None
        return manager.broadcast_task(str(args.get("instruction") or ""), roles, args.get("context") or None)
    if action == "submit_team_task":
        from ..agents.teams import AgentTeam

        team = AgentTeam(str(args["team"]))
        await ensure_parallel_runtime(project_id, manager, args.get("project_cwd"))
        return manager.submit_team_task(
            team=team,
            instruction=str(args.get("instruction") or ""),
            context=args.get("context") or None,
        )
    if action == "submit_parallel_team_primitives":
        from ..agents.teams import AgentTeam

        await ensure_parallel_runtime(project_id, manager, args.get("project_cwd"))
        submitted: Dict[str, Any] = {}
        for item in args.get("team_items") or []:
            team = AgentTeam(str(item["team"]))
            task_ids = manager.submit_team_task(
                team=team,
                instruction=str(item.get("instruction") or ""),
                context=item.get("context") or None,
            )
            submitted[team.value] = task_ids
        return submitted
    if action == "get_skill_bundle":
        role = AgentRole(str(args["role"]))
        agent = manager.get_agent(role)
        if agent is None or agent.skill_bundle is None:
            return {"loaded": False, "role": role.value}
        bundle = agent.skill_bundle
        return {
            "loaded": True,
            "role": role.value,
            "description": bundle.description,
            "core_skills": [s.name for s in bundle.core_skills],
            "support_skills": [s.name for s in bundle.support_skills],
            "shared_skills": [s.name for s in bundle.shared_skills],
            "total": len(bundle.all_skills),
        }
    if action == "get_multi_agent_results":
        from ..agents.manager import get_multi_agent_results

        return get_multi_agent_results(manager, args.get("task_ids") or {})

    raise ValueError(f"Unsupported manager action: {action}")


async def _handle_workflow_action_local(project_id: str, action: str, args: Dict[str, Any]) -> Any:
    async with _workflow_lock_for_project(project_id):
        if action == "start":
            workflow_name = str(args.get("workflow_name") or "feature_development").strip() or "feature_development"
            raw_goal = str(args.get("goal") or "").strip()
            resolved_goal = raw_goal or _WORKFLOW_DEFAULT_GOALS.get(
                workflow_name,
                f"Execute workflow '{workflow_name}' successfully.",
            )
            return await _start_workflow_local(
                project_id=project_id,
                workflow_name=workflow_name,
                goal=resolved_goal,
                params=args.get("params") or {},
            )
        if action == "stop":
            return await _stop_workflow_local(project_id, str(args.get("workflow_id") or ""))
        if action == "resume":
            return await _resume_workflow_local(
                project_id=project_id,
                workflow_id=str(args.get("workflow_id") or ""),
                workflow_name=str(args.get("workflow_name") or "feature_development"),
                goal=str(args.get("goal") or ""),
                params=args.get("params") or {},
            )
        raise ValueError(f"Unsupported workflow action: {action}")


async def manager_action(
    project_id: str,
    action: str,
    args: Optional[Dict[str, Any]] = None,
    timeout_seconds: float = 15.0,
) -> Any:
    safe_args = args or {}
    if project_id in _managers:
        return await _handle_manager_action_local(project_id, action, safe_args)

    owner = await owner_for_project(project_id)
    if owner is None:
        raise KeyError(f"Project {project_id} not found. POST /api/projects/{project_id}/clock-in first.")
    if owner == distributed_runtime.instance_id():
        return await _handle_manager_action_local(project_id, action, safe_args)

    return await distributed_runtime.rpc_call(
        owner,
        {
            "kind": "manager_action",
            "project_id": project_id,
            "action": action,
            "args": safe_args,
        },
        timeout_seconds=timeout_seconds,
    )


async def workflow_action(
    project_id: str,
    action: str,
    args: Optional[Dict[str, Any]] = None,
    timeout_seconds: float = 20.0,
) -> Any:
    safe_args = args or {}
    if project_id in _managers:
        return await _handle_workflow_action_local(project_id, action, safe_args)

    owner = await owner_for_project(project_id)
    if owner is None:
        raise KeyError(f"Project {project_id} not found. POST /api/projects/{project_id}/clock-in first.")
    if owner == distributed_runtime.instance_id():
        return await _handle_workflow_action_local(project_id, action, safe_args)

    try:
        return await distributed_runtime.rpc_call(
            owner,
            {
                "kind": "workflow_action",
                "project_id": project_id,
                "action": action,
                "args": safe_args,
            },
            timeout_seconds=timeout_seconds,
        )
    except RuntimeError as exc:
        if str(exc).startswith("workflow_conflict:"):
            raise WorkflowConflictError(str(exc)) from exc
        raise


async def start_workflow_distributed(
    project_id: str,
    workflow_name: str,
    goal: str,
    params: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    payload = {
        "workflow_name": workflow_name,
        "goal": goal,
        "params": params or {},
    }
    return await workflow_action(project_id, "start", payload)


async def stop_workflow_distributed(project_id: str, workflow_id: str) -> Dict[str, Any]:
    return await workflow_action(project_id, "stop", {"workflow_id": workflow_id})


async def resume_workflow_distributed(
    project_id: str,
    workflow_id: str,
    workflow_name: str,
    goal: str,
    params: Optional[Dict[str, Any]] = None,
) -> str:
    payload = {
        "workflow_id": workflow_id,
        "workflow_name": workflow_name,
        "goal": goal,
        "params": params or {},
    }
    result = await workflow_action(project_id, "resume", payload)
    return str(result)


async def submit_parallel_team_primitives(
    project_id: str,
    team_items: List[Dict[str, Any]],
    project_cwd: Optional[str] = None,
) -> Dict[str, Any]:
    """Reusable primitive for collaboration/team parallel dispatch."""
    normalized: List[Dict[str, Any]] = []
    for item in team_items:
        team = item["team"]
        normalized.append(
            {
                "team": getattr(team, "value", str(team)),
                "instruction": item.get("instruction", ""),
                "context": item.get("context"),
            }
        )
    return await manager_action(
        project_id,
        "submit_parallel_team_primitives",
        {
            "team_items": normalized,
            "project_cwd": project_cwd,
        },
        timeout_seconds=30.0,
    )


__all__ = [
    "_WORKFLOW_DEFAULT_GOALS",
    "WorkflowConflictError",
    "start_distributed_runtime",
    "stop_distributed_runtime",
    "owner_for_project",
    "ensure_project_runtime_exists",
    "register_manager_with_ownership",
    "remove_manager_with_ownership",
    "local_manager_exists",
    "manager_action",
    "workflow_action",
    "start_workflow_distributed",
    "stop_workflow_distributed",
    "resume_workflow_distributed",
    "ensure_parallel_runtime",
    "get_manager",
    "get_workflow_task",
    "register_manager",
    "remove_manager",
    "release_project_executor",
    "sanitize_project_cwd",
    "set_workflow_task",
    "cancel_workflow",
    "submit_parallel_team_primitives",
]

"""Best-effort DB persistence helpers for runtime in-memory state."""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Sequence

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from ..orchestration.collaboration_orchestrator import enrich_collaboration_artifact
from ..db.models import (
    AgentEventLog,
    CollaborationArtifact,
    CollaborationRound,
    CollaborationSession,
    Task,
    WorkflowRun,
)
from ..db.session import get_engine

logger = logging.getLogger("daacs.application.persistence")

ACTIVE_WORKFLOW_STATUSES = frozenset({"queued", "running", "recovering"})
RESUMABLE_WORKFLOW_STATUSES = frozenset({"paused", "needs_human", "stopped_with_report", "error", "recovering"})


def _to_uuid(value: str) -> Optional[uuid.UUID]:
    try:
        return uuid.UUID(str(value))
    except ValueError:
        return None


def _session_factory() -> async_sessionmaker[AsyncSession]:
    return async_sessionmaker(get_engine(), class_=AsyncSession, expire_on_commit=False)


def _serialize_workflow_run(row: WorkflowRun) -> Dict[str, Any]:
    return {
        "id": str(row.id),
        "project_id": str(row.project_id),
        "workflow_name": row.workflow_name,
        "goal": row.goal,
        "params": row.params or {},
        "overnight_config": row.overnight_config or {},
        "deadline_at": row.deadline_at.isoformat() if row.deadline_at else None,
        "spent_usd": float(row.spent_usd or 0),
        "status": row.status,
        "current_step": row.current_step,
        "total_steps": row.total_steps,
        "steps": row.steps or [],
    }


def _serialize_task(row: Task) -> Dict[str, Any]:
    return {
        "id": str(row.id),
        "project_id": str(row.project_id),
        "agent_role": row.agent_role,
        "description": row.description,
        "status": row.status,
        "priority": int(row.priority or 0),
        "result": row.result or {},
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "started_at": row.started_at.isoformat() if row.started_at else None,
        "completed_at": row.completed_at.isoformat() if row.completed_at else None,
    }


def _serialize_agent_event(row: AgentEventLog) -> Dict[str, Any]:
    return {
        "id": str(row.id),
        "project_id": str(row.project_id),
        "agent_role": row.agent_role,
        "event_type": row.event_type,
        "data": row.data or {},
        "created_at": row.created_at.isoformat() if row.created_at else None,
    }


async def persist_workflow_started(
    workflow_id: str,
    project_id: str,
    workflow_name: str,
    goal: str,
    params: Optional[Dict[str, Any]] = None,
) -> None:
    wf_uuid = _to_uuid(workflow_id)
    project_uuid = _to_uuid(project_id)
    if wf_uuid is None or project_uuid is None:
        return
    try:
        factory = _session_factory()
        async with factory() as db:
            row = await db.get(WorkflowRun, wf_uuid)
            if row is None:
                db.add(
                    WorkflowRun(
                        id=wf_uuid,
                        project_id=project_uuid,
                        workflow_name=workflow_name,
                        goal=goal,
                        params=params or {},
                        status="running",
                        current_step=0,
                        total_steps=0,
                        steps=[],
                    )
                )
            await db.commit()
    except Exception as exc:  # pragma: no cover - best effort
        logger.warning("persist_workflow_started failed: %s", exc)


async def persist_workflow_status(
    workflow_id: str,
    status: str,
    steps: Optional[List[Dict[str, Any]]] = None,
) -> None:
    wf_uuid = _to_uuid(workflow_id)
    if wf_uuid is None:
        return
    try:
        factory = _session_factory()
        async with factory() as db:
            row = await db.get(WorkflowRun, wf_uuid)
            if row is None:
                return
            row.status = status
            if steps is not None:
                row.steps = steps
                row.total_steps = len(steps)
                completed_steps = sum(1 for s in steps if s.get("status") == "done")
                row.current_step = completed_steps
            await db.commit()
    except Exception as exc:  # pragma: no cover - best effort
        logger.warning("persist_workflow_status failed: %s", exc)


async def update_workflow_fields(workflow_id: str, fields: Dict[str, Any]) -> None:
    wf_uuid = _to_uuid(workflow_id)
    if wf_uuid is None or not fields:
        return
    allowed = {
        "status",
        "params",
        "overnight_config",
        "deadline_at",
        "spent_usd",
        "current_step",
        "total_steps",
        "steps",
        "completed_at",
    }
    safe_updates = {k: v for k, v in fields.items() if k in allowed}
    if not safe_updates:
        return
    try:
        factory = _session_factory()
        async with factory() as db:
            row = await db.get(WorkflowRun, wf_uuid)
            if row is None:
                return
            for key, value in safe_updates.items():
                setattr(row, key, value)
            await db.commit()
    except Exception as exc:  # pragma: no cover - best effort
        logger.warning("update_workflow_fields failed: %s", exc)


async def persist_workflow_overview(
    workflow_id: str,
    status: str,
    spent_usd: Optional[float] = None,
    completed_at: Optional[datetime] = None,
) -> None:
    payload: Dict[str, Any] = {"status": status}
    if spent_usd is not None:
        payload["spent_usd"] = spent_usd
    if completed_at is not None:
        payload["completed_at"] = completed_at
    await update_workflow_fields(workflow_id, payload)


async def load_workflow_from_db(project_id: str, workflow_id: str) -> Optional[Dict[str, Any]]:
    wf_uuid = _to_uuid(workflow_id)
    project_uuid = _to_uuid(project_id)
    if wf_uuid is None or project_uuid is None:
        return None
    try:
        factory = _session_factory()
        async with factory() as db:
            row = await db.get(WorkflowRun, wf_uuid)
            if row is None or row.project_id != project_uuid:
                return None
            return _serialize_workflow_run(row)
    except Exception as exc:  # pragma: no cover - best effort
        logger.warning("load_workflow_from_db failed: %s", exc)
        return None


async def load_active_workflow_for_project_from_db(
    project_id: str,
    statuses: Optional[Sequence[str]] = None,
) -> Optional[Dict[str, Any]]:
    project_uuid = _to_uuid(project_id)
    if project_uuid is None:
        return None

    candidate_statuses = tuple((statuses or ACTIVE_WORKFLOW_STATUSES))
    if not candidate_statuses:
        return None

    try:
        factory = _session_factory()
        async with factory() as db:
            row = (
                await db.execute(
                    select(WorkflowRun)
                    .where(
                        WorkflowRun.project_id == project_uuid,
                        WorkflowRun.status.in_(candidate_statuses),
                    )
                    .order_by(WorkflowRun.started_at.desc())
                    .limit(1)
                )
            ).scalars().first()
            if row is None:
                return None
            return _serialize_workflow_run(row)
    except Exception as exc:  # pragma: no cover - best effort
        logger.warning("load_active_workflow_for_project_from_db failed: %s", exc)
        return None


async def load_workflows_for_project_from_db(project_id: str) -> List[Dict[str, Any]]:
    project_uuid = _to_uuid(project_id)
    if project_uuid is None:
        return []
    try:
        factory = _session_factory()
        async with factory() as db:
            rows = (
                await db.execute(
                    select(WorkflowRun)
                    .where(WorkflowRun.project_id == project_uuid)
                    .order_by(WorkflowRun.started_at.desc())
                )
            ).scalars().all()
            return [_serialize_workflow_run(row) for row in rows]
    except Exception as exc:  # pragma: no cover - best effort
        logger.warning("load_workflows_for_project_from_db failed: %s", exc)
        return []


async def persist_collaboration_session(session: Dict[str, Any]) -> None:
    session_uuid = _to_uuid(str(session.get("session_id", "")))
    project_uuid = _to_uuid(str(session.get("project_id", "")))
    if session_uuid is None or project_uuid is None:
        return
    try:
        factory = _session_factory()
        async with factory() as db:
            row = await db.get(CollaborationSession, session_uuid)
            if row is None:
                db.add(
                    CollaborationSession(
                        id=session_uuid,
                        project_id=project_uuid,
                        shared_goal=str(session.get("shared_goal", "")),
                        participants=list(session.get("participants", [])),
                    )
                )
            await db.commit()
    except Exception as exc:  # pragma: no cover - best effort
        logger.warning("persist_collaboration_session failed: %s", exc)


async def persist_collaboration_round(
    session_id: str,
    round_payload: Dict[str, Any],
    artifact: Dict[str, Any],
) -> None:
    session_uuid = _to_uuid(session_id)
    round_uuid = _to_uuid(str(round_payload.get("round_id", "")))
    if session_uuid is None or round_uuid is None:
        return
    try:
        factory = _session_factory()
        async with factory() as db:
            if await db.get(CollaborationRound, round_uuid) is None:
                db.add(
                    CollaborationRound(
                        id=round_uuid,
                        session_id=session_uuid,
                        prompt=str(round_payload.get("prompt", "")),
                        status=str(round_payload.get("status", "completed")),
                    )
                )

            artifact_uuid = _to_uuid(str(artifact.get("artifact_id", ""))) or uuid.uuid4()
            db.add(
                CollaborationArtifact(
                    id=artifact_uuid,
                    session_id=session_uuid,
                    round_id=round_uuid,
                    decision=str(artifact.get("decision", "")),
                    open_questions=list(artifact.get("open_questions", [])),
                    next_actions=list(artifact.get("next_actions", [])),
                    contributions=list(artifact.get("contributions", [])),
                )
            )
            await db.commit()
    except Exception as exc:  # pragma: no cover - best effort
        logger.warning("persist_collaboration_round failed: %s", exc)


async def load_collaboration_session_from_db(
    project_id: str,
    session_id: str,
) -> Optional[Dict[str, Any]]:
    project_uuid = _to_uuid(project_id)
    session_uuid = _to_uuid(session_id)
    if project_uuid is None or session_uuid is None:
        return None

    try:
        factory = _session_factory()
        async with factory() as db:
            session_row = await db.get(CollaborationSession, session_uuid)
            if session_row is None or session_row.project_id != project_uuid:
                return None

            rounds_rows = (
                await db.execute(
                    select(CollaborationRound).where(CollaborationRound.session_id == session_uuid)
                )
            ).scalars().all()
            artifacts_rows = (
                await db.execute(
                    select(CollaborationArtifact).where(CollaborationArtifact.session_id == session_uuid)
                )
            ).scalars().all()

            rounds = [
                {
                    "round_id": str(r.id),
                    "prompt": r.prompt,
                    "status": r.status,
                    "created_at": r.created_at.timestamp() if r.created_at else None,
                }
                for r in rounds_rows
            ]
            artifacts = [
                enrich_collaboration_artifact({
                    "artifact_id": str(a.id),
                    "session_id": str(a.session_id),
                    "round_id": str(a.round_id),
                    "decision": a.decision,
                    "open_questions": a.open_questions,
                    "next_actions": a.next_actions,
                    "contributions": a.contributions,
                }, shared_goal=session_row.shared_goal)
                for a in artifacts_rows
            ]
            return {
                "session_id": str(session_row.id),
                "project_id": str(session_row.project_id),
                "shared_goal": session_row.shared_goal,
                "participants": session_row.participants,
                "rounds": rounds,
                "artifacts": artifacts,
                "created_at": session_row.created_at.timestamp() if session_row.created_at else None,
            }
    except Exception as exc:  # pragma: no cover - best effort
        logger.warning("load_collaboration_session_from_db failed: %s", exc)
        return None


async def persist_task_submitted(project_id: str, task_id: str, agent_role: str, instruction: str) -> None:
    project_uuid = _to_uuid(project_id)
    task_uuid = _to_uuid(task_id)
    if project_uuid is None or task_uuid is None:
        return
    try:
        factory = _session_factory()
        async with factory() as db:
            row = await db.get(Task, task_uuid)
            if row is None:
                db.add(
                    Task(
                        id=task_uuid,
                        project_id=project_uuid,
                        agent_role=agent_role,
                        description=instruction,
                        status="queued",
                        priority=0,
                        dependencies=[],
                    )
                )
            else:
                row.agent_role = agent_role
                row.description = instruction
                row.status = "queued"
                row.result = {}
                row.started_at = None
                row.completed_at = None
            await db.commit()
    except Exception as exc:  # pragma: no cover - best effort
        logger.warning("persist_task_submitted failed: %s", exc)


async def persist_task_started(task_id: str) -> None:
    task_uuid = _to_uuid(task_id)
    if task_uuid is None:
        return
    try:
        factory = _session_factory()
        async with factory() as db:
            row = await db.get(Task, task_uuid)
            if row is None:
                return
            row.status = "running"
            row.started_at = datetime.now(timezone.utc)
            await db.commit()
    except Exception as exc:  # pragma: no cover - best effort
        logger.warning("persist_task_started failed: %s", exc)


async def persist_task_completed(task_id: str, result: Dict[str, Any]) -> None:
    task_uuid = _to_uuid(task_id)
    if task_uuid is None:
        return
    try:
        factory = _session_factory()
        async with factory() as db:
            row = await db.get(Task, task_uuid)
            if row is None:
                return
            row.status = "completed"
            row.result = result or {}
            row.completed_at = datetime.now(timezone.utc)
            await db.commit()
    except Exception as exc:  # pragma: no cover - best effort
        logger.warning("persist_task_completed failed: %s", exc)


async def persist_task_failed(task_id: str, error: str) -> None:
    task_uuid = _to_uuid(task_id)
    if task_uuid is None:
        return
    try:
        factory = _session_factory()
        async with factory() as db:
            row = await db.get(Task, task_uuid)
            if row is None:
                return
            row.status = "failed"
            row.result = {"error": (error or "")[:2000]}
            row.completed_at = datetime.now(timezone.utc)
            await db.commit()
    except Exception as exc:  # pragma: no cover - best effort
        logger.warning("persist_task_failed failed: %s", exc)


async def persist_agent_event(project_id: str, agent_role: str, event_type: str, data: Dict[str, Any]) -> None:
    project_uuid = _to_uuid(project_id)
    if project_uuid is None:
        return
    try:
        factory = _session_factory()
        async with factory() as db:
            db.add(
                AgentEventLog(
                    project_id=project_uuid,
                    agent_role=agent_role,
                    event_type=event_type,
                    data=data or {},
                )
            )
            await db.commit()
    except Exception as exc:  # pragma: no cover - best effort
        logger.warning("persist_agent_event failed: %s", exc)


async def load_task_history(project_id: str, agent_role: str, limit: int = 50) -> List[Dict[str, Any]]:
    project_uuid = _to_uuid(project_id)
    if project_uuid is None:
        return []
    safe_limit = max(1, min(int(limit), 200))
    try:
        factory = _session_factory()
        async with factory() as db:
            rows = (
                await db.execute(
                    select(Task)
                    .where(
                        Task.project_id == project_uuid,
                        Task.agent_role == agent_role,
                    )
                    .order_by(Task.created_at.desc())
                    .limit(safe_limit)
                )
            ).scalars().all()
            return [_serialize_task(row) for row in rows]
    except Exception as exc:  # pragma: no cover - best effort
        logger.warning("load_task_history failed: %s", exc)
        return []


async def load_agent_events(
    project_id: str,
    agent_role: str,
    event_type: Optional[str] = None,
    limit: int = 50,
) -> List[Dict[str, Any]]:
    project_uuid = _to_uuid(project_id)
    if project_uuid is None:
        return []
    safe_limit = max(1, min(int(limit), 200))
    try:
        factory = _session_factory()
        async with factory() as db:
            query = select(AgentEventLog).where(
                AgentEventLog.project_id == project_uuid,
                AgentEventLog.agent_role == agent_role,
            )
            if event_type:
                query = query.where(AgentEventLog.event_type == event_type)
            rows = (await db.execute(query.order_by(AgentEventLog.created_at.desc()).limit(safe_limit))).scalars().all()
            return [_serialize_agent_event(row) for row in rows]
    except Exception as exc:  # pragma: no cover - best effort
        logger.warning("load_agent_events failed: %s", exc)
        return []

"""Overnight-only guards for persistent budget/time/policy."""

from __future__ import annotations

import asyncio
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Iterable, Optional

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from ..db.models import CostLog
from ..db.session import get_engine


def _to_uuid(value: str) -> Optional[uuid.UUID]:
    try:
        return uuid.UUID(str(value))
    except (ValueError, TypeError):
        return None


class BudgetExceededError(Exception):
    def __init__(self, run_id: str, spent: float, cap: float, estimated: float = 0.0):
        self.run_id = run_id
        self.spent = spent
        self.cap = cap
        self.estimated = estimated
        super().__init__(
            f"Overnight budget exceeded for run={run_id}: spent={spent:.4f}, cap={cap:.4f}, estimated={estimated:.4f}"
        )


class TimeExceededError(Exception):
    def __init__(self, run_id: str, deadline_at: datetime):
        self.run_id = run_id
        self.deadline_at = deadline_at
        super().__init__(f"Overnight deadline reached for run={run_id}: {deadline_at.isoformat()}")


class OvernightBudgetGuard:
    """Persistent run-level budget guard backed by cost_log."""

    def __init__(
        self,
        run_id: str,
        project_id: str,
        budget_usd: float,
        session_factory: async_sessionmaker[AsyncSession] | None = None,
    ):
        self.run_id = run_id
        self.project_id = project_id
        self.budget_usd = float(budget_usd)
        self._lock = asyncio.Lock()
        self._session_factory = session_factory or async_sessionmaker(
            get_engine(),
            class_=AsyncSession,
            expire_on_commit=False,
        )

    async def spent_so_far(self) -> float:
        run_uuid = _to_uuid(self.run_id)
        if run_uuid is None:
            return 0.0
        async with self._session_factory() as db:
            total = (
                await db.execute(
                    select(func.coalesce(func.sum(CostLog.cost_usd), 0)).where(CostLog.run_id == run_uuid)
                )
            ).scalar_one()
        return float(total or 0.0)

    async def check_or_raise(self, estimated_cost: float = 0.0) -> None:
        spent = await self.spent_so_far()
        if spent + float(estimated_cost) > self.budget_usd:
            raise BudgetExceededError(self.run_id, spent, self.budget_usd, float(estimated_cost))

    async def record(
        self,
        agent_role: str,
        model: str,
        input_tokens: int,
        output_tokens: int,
        cost_usd: float,
        task_complexity: str | None = None,
    ) -> None:
        run_uuid = _to_uuid(self.run_id)
        project_uuid = _to_uuid(self.project_id)
        if run_uuid is None or project_uuid is None:
            return

        async with self._lock:
            async with self._session_factory() as db:
                db.add(
                    CostLog(
                        project_id=project_uuid,
                        run_id=run_uuid,
                        agent_role=agent_role,
                        model=model,
                        input_tokens=input_tokens,
                        output_tokens=output_tokens,
                        cost_usd=Decimal(str(cost_usd)),
                        task_complexity=task_complexity,
                    )
                )
                await db.commit()


@dataclass
class TimeGuard:
    run_id: str
    deadline_at: datetime

    @classmethod
    def from_minutes(cls, run_id: str, max_runtime_minutes: int) -> "TimeGuard":
        now = datetime.now(timezone.utc)
        deadline = now + timedelta(minutes=max(1, int(max_runtime_minutes)))
        return cls(run_id=run_id, deadline_at=deadline)

    def check_or_raise(self) -> None:
        now = datetime.now(timezone.utc)
        deadline = self.deadline_at
        if deadline.tzinfo is None:
            deadline = deadline.replace(tzinfo=timezone.utc)
        if now >= deadline:
            raise TimeExceededError(self.run_id, deadline)

    def seconds_remaining(self) -> float:
        now = datetime.now(timezone.utc)
        deadline = self.deadline_at
        if deadline.tzinfo is None:
            deadline = deadline.replace(tzinfo=timezone.utc)
        return max(0.0, (deadline - now).total_seconds())


class CommandPolicyGuard:
    def __init__(self, blocked_commands: Iterable[str]):
        self.blocked_commands = tuple(c.strip() for c in blocked_commands if str(c).strip())

    def check_command(self, command: str) -> None:
        cmd = (command or "").strip().lower()
        for blocked in self.blocked_commands:
            if blocked.lower() in cmd:
                raise PermissionError(f"Blocked command detected: {blocked}")

    def check_logs(self, logs: Iterable[str]) -> tuple[bool, str]:
        lowered = [str(l).lower() for l in (logs or [])]
        for blocked in self.blocked_commands:
            token = blocked.lower()
            if any(token in line for line in lowered):
                return False, f"Blocked command footprint detected: {blocked}"
        return True, "No blocked command footprint detected"

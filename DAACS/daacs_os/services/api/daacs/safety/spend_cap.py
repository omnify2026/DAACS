"""
DAACS OS — Daily Spend Cap Guard
일일 LLM API 비용 상한 ($1.00 기본)

daacs_config.yaml safety.daily_spend_cap_usd 기반.
상한 초과 시 LLM 호출을 차단하여 예상치 못한 과금을 방지한다.
"""
import asyncio
import logging
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any, Dict, Optional

logger = logging.getLogger("daacs.safety.spend_cap")


@dataclass
class UsageRecord:
    """단일 LLM 호출 기록"""
    agent_role: str
    model: str
    input_tokens: int
    output_tokens: int
    cost_usd: float
    timestamp: datetime = field(default_factory=datetime.now)


class SpendCapGuard:
    """
    일일 비용 상한 가드.

    사용법:
        guard = SpendCapGuard(daily_cap_usd=1.00)
        if guard.can_spend(estimated_cost=0.05):
            # LLM 호출 진행
            result = await call_llm(...)
            guard.record(agent_role="developer", model="gpt-4o",
                         input_tokens=500, output_tokens=200, cost_usd=0.03)
        else:
            # 상한 초과 — 차단
            raise BudgetExceededError(guard.today_spent, guard.daily_cap_usd)
    """

    def __init__(self, daily_cap_usd: float = 1.00):
        self.daily_cap_usd = daily_cap_usd
        self._records: list[UsageRecord] = []
        self._daily_totals: Dict[str, float] = defaultdict(float)  # date_str → total
        self._lock = asyncio.Lock()

    @classmethod
    def from_config(cls, config: Dict[str, Any]) -> "SpendCapGuard":
        """daacs_config.yaml safety 섹션에서 생성"""
        return cls(daily_cap_usd=config.get("daily_spend_cap_usd", 1.00))

    # ─── 상태 조회 ───

    @property
    def today_key(self) -> str:
        return date.today().isoformat()

    @property
    def today_spent(self) -> float:
        return self._daily_totals.get(self.today_key, 0.0)

    @property
    def today_remaining(self) -> float:
        return max(0.0, self.daily_cap_usd - self.today_spent)

    @property
    def is_over_budget(self) -> bool:
        return self.today_spent >= self.daily_cap_usd

    # ─── 핵심 API ───

    def can_spend(self, estimated_cost: float = 0.0) -> bool:
        """예상 비용 포함 시 상한 내인지 확인"""
        return (self.today_spent + estimated_cost) <= self.daily_cap_usd

    async def record(
        self,
        agent_role: str,
        model: str,
        input_tokens: int,
        output_tokens: int,
        cost_usd: float,
    ) -> UsageRecord:
        """LLM 호출 비용 기록"""
        rec = UsageRecord(
            agent_role=agent_role,
            model=model,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            cost_usd=cost_usd,
        )
        async with self._lock:
            self._records.append(rec)
            self._daily_totals[self.today_key] += cost_usd

        if self.is_over_budget:
            logger.warning(
                f"SPEND CAP REACHED: ${self.today_spent:.4f} / "
                f"${self.daily_cap_usd:.2f} — blocking further calls"
            )
        else:
            logger.debug(
                f"Spend: +${cost_usd:.4f} → ${self.today_spent:.4f} / "
                f"${self.daily_cap_usd:.2f}"
            )
        return rec

    def check_or_raise(self, estimated_cost: float = 0.0) -> None:
        """상한 초과 시 예외 발생"""
        if not self.can_spend(estimated_cost):
            raise BudgetExceededError(
                spent=self.today_spent,
                cap=self.daily_cap_usd,
                estimated=estimated_cost,
            )

    # ─── 리포트 ───

    def get_report(self) -> Dict[str, Any]:
        """오늘의 비용 리포트"""
        today_records = [
            r for r in self._records
            if r.timestamp.date() == date.today()
        ]
        by_role: Dict[str, float] = defaultdict(float)
        by_model: Dict[str, float] = defaultdict(float)
        for r in today_records:
            by_role[r.agent_role] += r.cost_usd
            by_model[r.model] += r.cost_usd

        return {
            "date": self.today_key,
            "daily_cap_usd": self.daily_cap_usd,
            "spent_usd": round(self.today_spent, 6),
            "remaining_usd": round(self.today_remaining, 6),
            "is_over_budget": self.is_over_budget,
            "total_calls": len(today_records),
            "by_role": dict(by_role),
            "by_model": dict(by_model),
        }

    def get_history(self, days: int = 7) -> Dict[str, float]:
        """최근 N일 일별 비용"""
        return dict(
            sorted(self._daily_totals.items(), reverse=True)[:days]
        )


class BudgetExceededError(Exception):
    """일일 비용 상한 초과"""
    def __init__(self, spent: float, cap: float, estimated: float = 0.0):
        self.spent = spent
        self.cap = cap
        self.estimated = estimated
        super().__init__(
            f"Daily spend cap exceeded: ${spent:.4f} spent "
            f"(cap: ${cap:.2f}, estimated: ${estimated:.4f})"
        )

"""
DAACS OS — Token Tracker
LLM 호출별 토큰 사용량 추적 + SpendCapGuard 피드.

Source: DAACS_v2-dy/daacs/monitoring/token_tracker.py
"""
import logging
import time
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

logger = logging.getLogger("daacs.monitoring.token_tracker")


@dataclass
class TokenUsage:
    """단일 LLM 호출의 토큰 사용 기록."""
    project_id: str
    agent_role: str
    model: str
    input_tokens: int
    output_tokens: int
    cost_usd: float
    elapsed_sec: float
    timestamp: float = field(default_factory=time.time)
    node_name: str = ""


class TokenTracker:
    """
    프로젝트별 토큰 사용량 추적.

    싱글톤 패턴 — 전역 인스턴스로 모든 LLM 호출을 기록.
    SpendCapGuard의 record()와 별도로 동작하며, 상세 분석용.
    """

    _instance: Optional["TokenTracker"] = None

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance._initialized = False
        return cls._instance

    def __init__(self):
        if self._initialized:
            return
        self._records: List[TokenUsage] = []
        self._by_project: Dict[str, List[TokenUsage]] = defaultdict(list)
        self._by_role: Dict[str, List[TokenUsage]] = defaultdict(list)
        self._by_model: Dict[str, List[TokenUsage]] = defaultdict(list)
        self._initialized = True

    def track(
        self,
        project_id: str,
        agent_role: str,
        model: str,
        input_tokens: int,
        output_tokens: int,
        cost_usd: float,
        elapsed_sec: float = 0.0,
        node_name: str = "",
    ) -> TokenUsage:
        """LLM 호출 기록."""
        usage = TokenUsage(
            project_id=project_id,
            agent_role=agent_role,
            model=model,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            cost_usd=cost_usd,
            elapsed_sec=elapsed_sec,
            node_name=node_name,
        )
        self._records.append(usage)
        self._by_project[project_id].append(usage)
        self._by_role[agent_role].append(usage)
        self._by_model[model].append(usage)

        logger.debug(
            f"Token tracked: {agent_role}@{model} "
            f"in={input_tokens} out={output_tokens} cost=${cost_usd:.4f}"
        )
        return usage

    def get_project_summary(self, project_id: str) -> Dict[str, Any]:
        """프로젝트별 토큰 사용 요약."""
        records = self._by_project.get(project_id, [])
        if not records:
            return {"project_id": project_id, "total_calls": 0}

        total_input = sum(r.input_tokens for r in records)
        total_output = sum(r.output_tokens for r in records)
        total_cost = sum(r.cost_usd for r in records)
        total_time = sum(r.elapsed_sec for r in records)

        by_role: Dict[str, Dict[str, Any]] = {}
        for r in records:
            if r.agent_role not in by_role:
                by_role[r.agent_role] = {"calls": 0, "tokens": 0, "cost": 0.0}
            by_role[r.agent_role]["calls"] += 1
            by_role[r.agent_role]["tokens"] += r.input_tokens + r.output_tokens
            by_role[r.agent_role]["cost"] += r.cost_usd

        return {
            "project_id": project_id,
            "total_calls": len(records),
            "total_input_tokens": total_input,
            "total_output_tokens": total_output,
            "total_cost_usd": round(total_cost, 6),
            "total_elapsed_sec": round(total_time, 1),
            "by_role": {k: {**v, "cost": round(v["cost"], 6)} for k, v in by_role.items()},
        }

    def get_global_summary(self) -> Dict[str, Any]:
        """전체 토큰 사용 요약."""
        total_input = sum(r.input_tokens for r in self._records)
        total_output = sum(r.output_tokens for r in self._records)
        total_cost = sum(r.cost_usd for r in self._records)

        return {
            "total_calls": len(self._records),
            "total_input_tokens": total_input,
            "total_output_tokens": total_output,
            "total_cost_usd": round(total_cost, 6),
            "projects": list(self._by_project.keys()),
            "models_used": list(self._by_model.keys()),
        }

    def reset(self, project_id: Optional[str] = None):
        """기록 초기화."""
        if project_id:
            self._by_project.pop(project_id, None)
            self._records = [r for r in self._records if r.project_id != project_id]
        else:
            self._records.clear()
            self._by_project.clear()
            self._by_role.clear()
            self._by_model.clear()

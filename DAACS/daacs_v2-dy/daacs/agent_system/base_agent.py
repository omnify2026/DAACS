"""
Lightweight Agent System Base Classes (Cycle 9 POC).
"""
from typing import Any, Dict, List


class BaseAgent:
    def __init__(self, name: str, model: str):
        self.name = name
        self.model = model
        self.plan_history: List[List[str]] = []

    def plan(self, goal: str) -> List[str]:
        """단계 분해 로직을 구현하세요."""
        raise NotImplementedError("plan() must be implemented by subclasses")

    def execute(self, plan: List[str]) -> Dict[str, Any]:
        """계획을 실행하고 결과를 반환합니다."""
        raise NotImplementedError("execute() must be implemented by subclasses")

    def summarize(self, plan: List[str], execution: Dict[str, Any]) -> Dict[str, Any]:
        """기획-실행 결과 요약."""
        return {
            "agent": self.name,
            "model": self.model,
            "plan_steps": plan,
            "execution": execution,
        }

"""CFO Agent — 재무 관리, 비용 추적, 런웨이 분석 (TokenTracker 연동)"""
from typing import Any, Dict, Optional

from .base import BaseAgent
from .base_roles import AgentRole
from .protocol import AgentMessage, MessageType

SYSTEM_PROMPT = (
    "You are a CFO managing API costs and budget. "
    "You analyze spending patterns, calculate runway, identify cost optimization opportunities, "
    "and provide financial reports. "
    "Use data provided to give concrete numbers and recommendations."
)


class CFOAgent(BaseAgent):
    def __init__(self, project_id: Optional[str] = None):
        super().__init__(AgentRole.CFO, project_id)
        self.daily_costs: Dict[str, float] = {}  # date → total_cost

    async def process_message(self, message: AgentMessage):
        if message.type == MessageType.TASK:
            self.set_task("재무 분석 중")
            result = await self.execute(str(message.content))
            self.complete_task()

        elif message.type == MessageType.INFO:
            if isinstance(message.content, dict) and "cost_usd" in message.content:
                self._record_cost(message.content)

        elif message.type == MessageType.COMMAND:
            self.set_task(f"명령 처리: {message.content}")
            result = await self.execute(str(message.content))
            self.complete_task()

    async def execute(self, instruction: str, context: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """CFO 핵심 로직: LLM 기반 비용 리포트 + 런웨이 분석"""
        self.logger.info(f"CFO executing: {instruction}")

        # 비용 데이터를 프롬프트에 포함
        cost_summary = f"\n\nCurrent cost data: {self.daily_costs}" if self.daily_costs else ""

        llm_response = await self.execute_task(
            prompt=instruction + cost_summary,
            system_prompt=SYSTEM_PROMPT,
        )

        return {
            "role": self.role.value,
            "action": "financial_analysis",
            "instruction": instruction,
            "llm_response": llm_response,
            "daily_costs": self.daily_costs,
            "status": "completed",
        }

    def _record_cost(self, cost_data: Dict[str, Any]):
        from datetime import date
        today = date.today().isoformat()
        self.daily_costs[today] = self.daily_costs.get(today, 0.0) + cost_data.get("cost_usd", 0.0)

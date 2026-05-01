"""CEO Agent — 전략 판단, KPI 모니터링, 의사결정"""
from typing import Any, Dict, Optional

from .base import BaseAgent
from .base_roles import AgentRole
from .protocol import AgentMessage, MessageType

SYSTEM_PROMPT = (
    "You are the CEO of a software company. "
    "You make strategic decisions, review KPIs, evaluate project direction, "
    "and provide high-level guidance. Respond with clear, actionable decisions. "
    "When analyzing, provide: decision, reasoning, risk_level, next_steps."
)


class CEOAgent(BaseAgent):
    def __init__(self, project_id: Optional[str] = None):
        super().__init__(AgentRole.CEO, project_id)

    async def process_message(self, message: AgentMessage):
        if message.type == MessageType.TASK:
            self.set_task("전략 분석 중")
            result = await self.execute(message.content)
            self.complete_task()

        elif message.type == MessageType.COMMAND:
            self.set_task(f"명령 처리: {message.content}")
            result = await self.execute(message.content)
            self.complete_task()

    async def execute(self, instruction: str, context: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """CEO 핵심 로직: LLM 기반 전략 판단 + KPI 분석"""
        self.logger.info(f"CEO executing: {instruction}")

        llm_response = await self.execute_task(
            prompt=instruction,
            system_prompt=SYSTEM_PROMPT,
        )

        return {
            "role": self.role.value,
            "action": "strategic_analysis",
            "instruction": instruction,
            "llm_response": llm_response,
            "status": "completed",
        }

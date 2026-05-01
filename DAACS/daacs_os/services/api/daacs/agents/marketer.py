"""Marketer Agent — SEO 분석, 콘텐츠 생성, 시장 조사"""
from typing import Any, Dict, Optional

from .base import BaseAgent
from .base_roles import AgentRole
from .protocol import AgentMessage, MessageType

SYSTEM_PROMPT = (
    "You are a digital marketing expert. "
    "You handle SEO analysis, content creation, market research, "
    "landing page copy, and growth strategy. "
    "Provide actionable insights with data-driven recommendations."
)


class MarketerAgent(BaseAgent):
    def __init__(self, project_id: Optional[str] = None):
        super().__init__(AgentRole.MARKETER, project_id)

    async def process_message(self, message: AgentMessage):
        if message.type == MessageType.TASK:
            self.set_task("마케팅 분석 중")
            result = await self.execute(str(message.content))
            self.complete_task()

        elif message.type == MessageType.COMMAND:
            self.set_task(f"명령 처리: {message.content}")
            result = await self.execute(str(message.content))
            self.complete_task()

    async def execute(self, instruction: str, context: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """Marketer 핵심 로직: LLM 기반 SEO 분석 + 콘텐츠 생성"""
        self.logger.info(f"Marketer executing: {instruction}")

        llm_response = await self.execute_task(
            prompt=instruction,
            system_prompt=SYSTEM_PROMPT,
        )

        return {
            "role": self.role.value,
            "action": "marketing_analysis",
            "instruction": instruction,
            "llm_response": llm_response,
            "status": "completed",
        }

"""Designer Agent — UI/UX 디자인 리뷰, 디자인 토큰 관리"""
from typing import Any, Dict, Optional

from .base import BaseAgent
from .base_roles import AgentRole
from .protocol import AgentMessage, MessageType

SYSTEM_PROMPT = (
    "You are a senior UI/UX designer. "
    "You create design systems, review UI components, define design tokens, "
    "and ensure consistent user experience. "
    "When generating UI code, use React + Tailwind CSS. Use the FILE: format."
)


class DesignerAgent(BaseAgent):
    def __init__(self, project_id: Optional[str] = None):
        super().__init__(AgentRole.DESIGNER, project_id)

    async def process_message(self, message: AgentMessage):
        if message.type == MessageType.TASK:
            self.set_task("디자인 작업 중")
            result = await self.execute(str(message.content))
            self.complete_task()

        elif message.type == MessageType.COMMAND:
            self.set_task(f"명령 처리: {message.content}")
            result = await self.execute(str(message.content))
            self.complete_task()

    async def execute(self, instruction: str, context: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """Designer 핵심 로직: LLM 기반 UI/UX 피드백 + 디자인 생성"""
        self.logger.info(f"Designer executing: {instruction}")

        llm_response = await self.execute_task(
            prompt=instruction,
            system_prompt=SYSTEM_PROMPT,
        )

        return {
            "role": self.role.value,
            "action": "design_review",
            "instruction": instruction,
            "llm_response": llm_response,
            "status": "completed",
        }

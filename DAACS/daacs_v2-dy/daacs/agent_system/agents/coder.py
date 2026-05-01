from typing import Any
from ..base import BaseAgent
from ..protocol import AgentMessage, MessageType, AgentStatus
from ...llm.cli_executor import SessionBasedCLIClient
from ...graph.config_loader import DAACSConfig

class CoderAgent(BaseAgent):
    """
    Coder Agent: Generates code based on plans.
    """
    def __init__(self, agent_id: str, cli_client: SessionBasedCLIClient):
        super().__init__(agent_id, role="coder")
        self.cli = cli_client
        self.config = DAACSConfig.get_instance().get_constraints()

    async def process_message(self, message: AgentMessage):
        if message.type == MessageType.TASK:
            self.update_status(AgentStatus.BUSY)
            await self._implement_code(message.content)
            self.update_status(AgentStatus.IDLE)

    async def _implement_code(self, task_info: Any):
        file_name = task_info.get("file", "unknown.py")
        instruction = task_info.get("instruction", "")
        
        self.logger.info(f"Implementing {file_name}: {instruction}")
        
        # 🆕 Inject Config Constraints directly into the prompt
        constraints_prompt = (
            f"Global Configuration Constraints (MUST FOLLOW):\n"
            f"- Backend Port: {self.config.get('port', 8000)}\n"
            f"- API Prefix: {self.config.get('api_prefix', '/api/v1')}\n"
            f"- If writing Frontend code, use 'http://localhost:{self.config.get('port', 8000)}{self.config.get('api_prefix', '/api/v1')}' as the base URL.\n"
        )

        # 🆕 Inject Quality Guidelines
        guidelines = DAACSConfig.get_instance().config.get("guidelines", {})
        common_guides = guidelines.get("common", [])
        
        specific_guides = []
        if file_name.endswith(".py"):
             specific_guides = guidelines.get("backend", [])
        elif file_name.endswith((".js", ".html", ".css", ".ts", ".tsx", ".jsx")):
             specific_guides = guidelines.get("frontend", [])

        guidelines_prompt = "Quality Guidelines (MUST FOLLOW):\n"
        for g in common_guides + specific_guides:
            guidelines_prompt += f"- {g}\n"
        
        prompt = (
            f"You are a senior python developer.\n"
            f"Task: Write the full content of the file '{file_name}'.\n"
            f"Requirement: {instruction}\n"
            f"{constraints_prompt}\n"
            f"{guidelines_prompt}\n"
            f"Output ONLY the code content, no markdown formatting."
        )
        
        code = self.cli.execute(prompt)
        # Clean up possible markdown
        code = code.replace("```python", "").replace("```", "").strip()
        
        # Send for review
        await self.send_message(
            receiver="reviewer-01",
            content={"file": file_name, "code": code},
            msg_type=MessageType.REQUEST
        )

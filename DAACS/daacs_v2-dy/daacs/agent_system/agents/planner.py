from typing import Any
from ..base import BaseAgent
from ..protocol import AgentMessage, MessageType, AgentStatus
from ...llm.cli_executor import SessionBasedCLIClient

class PlannerAgent(BaseAgent):
    """
    Planner Agent: Analyzes requirements and creates execution plans.
    """
    def __init__(self, agent_id: str, cli_client: SessionBasedCLIClient):
        super().__init__(agent_id, role="planner")
        self.cli = cli_client

    async def process_message(self, message: AgentMessage):
        if message.type == MessageType.TASK:
            self.update_status(AgentStatus.BUSY)
            await self._analyze_and_plan(message.content)
            self.update_status(AgentStatus.IDLE)
        
        elif message.type == MessageType.REJECT:
            # Handle Rejection -> Self-Correction Loop
            content = message.content
            file_name = content.get("file")
            feedback = content.get("feedback")
            score = content.get("score")
            
            self.logger.warning(f"Task Rejected: {file_name} (Score: {score}). Feedback: {feedback}")
            
            # Create Fix Task
            fix_instruction = f"Fix issues in {file_name}. Feedback: {feedback}. Improve code robustness, add docstrings and error handling."
            
            await self.send_message(
                receiver="coder-01",
                content={"file": file_name, "instruction": fix_instruction},
                msg_type=MessageType.TASK
            )

        elif message.type == MessageType.INFO:
            self.logger.info(f"Info received: {message.content}")

    async def _analyze_and_plan(self, goal: str):
        self.logger.info(f"Analyzing goal: {goal}")
        
        # 🆕 Intelligence: Retrieve Past Experiences
        past_experiences = []
        try:
            from ...memory.long_term import memory_manager
            past_experiences = memory_manager.retrieve_experience(goal)
            if past_experiences:
                self.logger.info(f"Brain Recall: Found {len(past_experiences)} similar past experiences.")
        except Exception as e:
            self.logger.warning(f"Memory retrieval failed: {e}")

        # Construct Memory Context
        memory_context = ""
        if past_experiences:
            memory_context = "\n\n[Reference Plans (Success History)]:\n"
            for i, exp in enumerate(past_experiences):
                memory_context += f"--- Example {i+1} (Score: {exp['score']}) ---\nGoal: {exp['goal']}\nPlan: {exp['plan']}\n"

        # 1. Use LLM to create a plan
        prompt = (
            f"You are a software architect. Analyze the following goal and create a step-by-step implementation plan.\n"
            f"Goal: {goal}\n"
            f"{memory_context}\n"
            f"Output ONLY a raw JSON list of tasks, where each task has 'file' and 'instruction' keys.\n"
            f"Example: [{{\"file\": \"main.py\", \"instruction\": \"Create entry point\"}}]"
        )
        
        try:
            response = self.cli.execute(prompt)
            # Remove markdown code blocks if any
            clean_response = response.replace("```json", "").replace("```", "").strip()
            import json
            tasks = json.loads(clean_response)
            
            # Store for memory saving
            self.last_goal = goal
            self.last_plan = tasks
            
            self.logger.info(f"Plan created with {len(tasks)} tasks")

            # 2. Assign tasks to Coder
            for task in tasks:
                 await self.send_message(
                    receiver="coder-01",
                    content=task,
                    msg_type=MessageType.TASK
                )
                
        except Exception as e:
            self.logger.error(f"Planning failed: {e}")
            # Fallback for demo
            fallback_task = {"file": "app.py", "instruction": f"Implement {goal} in a single file"}
            await self.send_message(
                receiver="coder-01",
                content=fallback_task,
                msg_type=MessageType.TASK
            )

    def save_success_to_memory(self, score: float = 10.0):
        """Save the current goal and plan to long-term memory."""
        if hasattr(self, 'last_goal') and hasattr(self, 'last_plan'):
            try:
                from ...memory.long_term import memory_manager
                memory_manager.save_experience(self.last_goal, self.last_plan, score)
                self.logger.info("🧠 Brain Consolidated: Experience saved to long-term memory.")
            except Exception as e:
                self.logger.error(f"Failed to save experience: {e}")

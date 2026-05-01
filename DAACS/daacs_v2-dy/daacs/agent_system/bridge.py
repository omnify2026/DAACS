import asyncio
from typing import Dict, Any

from .manager import AgentRegistry, MessageBus
from .agents.planner import PlannerAgent
from .agents.coder import CoderAgent
from .agents.reviewer import ReviewerAgent
from .protocol import MessageType, AgentMessage
from ..llm.cli_executor import SessionBasedCLIClient
from ..utils import setup_logger

logger = setup_logger("AgentBridge")

async def run_agent_system(goal: str, project_dir: str):
    """
    Run the Multi-Agent System to achieve a goal.
    """
    logger.info("Initializing Agent System...")
    
    # 1. Setup Infrastructure
    registry = AgentRegistry()
    bus = MessageBus(registry)
    
    # 2. Initialize Agents
    # Note: sharing CLI client for POC, but could be separate
    cli = SessionBasedCLIClient(cwd=project_dir, cli_type="codex", client_name="agent-system")
    
    planner = PlannerAgent("planner-01", cli)
    coder = CoderAgent("coder-01", cli)
    reviewer = ReviewerAgent("reviewer-01")
    
    # 3. Connect Agents to Bus
    for agent in [planner, coder, reviewer]:
        agent.set_message_bus(bus)
        registry.register(agent)
    
    # 3. Setup Communication Bridge (Visualization)
    from ..routes.stream import stream_manager
    bus.add_listener(stream_manager.broadcast)

    # 4. Run System
    logger.info(f"Agents Assembling... Goal: {user_goal}")
    try:
        # Initial Task
        await planner.send_message(
            receiver="planner-01", 
            content=user_goal, 
            msg_type=MessageType.TASK
        )
    except Exception as e:
        logger.error(f"Failed to start system: {e}")

    # 5. Wait for Completion (POC: primitive wait)
    # In a real system, we'd wait for a terminal state or specific event
    try:
        await asyncio.sleep(5) # Increased wait for demo
        logger.info("Agent System Execution Finished (POC timeout)")
        
        # Save Experience to Memory
        planner.save_success_to_memory(score=9.5) # Assuming high score for successful completion
        
    except Exception as e:
        logger.error(f"Agent execution failed: {e}")

    return "Agent System Run Complete"

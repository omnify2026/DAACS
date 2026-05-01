from typing import Dict, List, Optional
import asyncio
import logging

from .base import BaseAgent
from .protocol import AgentMessage, MessageType
from ..utils import setup_logger

class AgentRegistry:
    """
    Central Registry for all active agents.
    """
    def __init__(self):
        self._agents: Dict[str, BaseAgent] = {}
        self.logger = setup_logger("AgentRegistry")

    def register(self, agent: BaseAgent):
        if agent.agent_id in self._agents:
            self.logger.warning(f"Agent {agent.agent_id} already registered. Overwriting.")
        self._agents[agent.agent_id] = agent
        self.logger.info(f"Registered agent: {agent.agent_id} ({agent.role})")

    def get_agent(self, agent_id: str) -> Optional[BaseAgent]:
        return self._agents.get(agent_id)

    def get_agents_by_role(self, role: str) -> List[BaseAgent]:
        return [a for a in self._agents.values() if a.role == role]

    def list_agents(self) -> List[str]:
        return list(self._agents.keys())


class MessageBus:
    """
    Message Bus for routing messages between agents.
    """
    def __init__(self, registry: AgentRegistry):
        self.registry = registry
        self.logger = setup_logger("MessageBus")
        self.listeners = []

    def add_listener(self, listener):
        """Add a listener (callable) that receives all routed messages"""
        self.listeners.append(listener)

    async def route_message(self, message: AgentMessage):
        """Route a message to its destination"""
        self.logger.debug(f"Routing message: {message.sender} -> {message.receiver} [{message.type}]")
        
        # Notify listeners (e.g., Visualization Stream)
        for listener in self.listeners:
            try:
                if asyncio.iscoroutinefunction(listener):
                    asyncio.create_task(listener(message))
                else:
                    listener(message)
            except Exception as e:
                self.logger.error(f"Error in message listener: {e}")

        if message.receiver == "broadcast":
            await self.broadcast(message)
            return

        receiver_agent = self.registry.get_agent(message.receiver)
        if receiver_agent:
            # Use create_task to prevent recursion depth issues and enable true async
            asyncio.create_task(receiver_agent.receive_message(message))
        else:
            self.logger.error(f"Receiver agent not found: {message.receiver}")
            # Optionally send error back to sender

    async def broadcast(self, message: AgentMessage):
        """Send message to all agents except sender"""
        for agent_id, agent in self.registry._agents.items():
            if agent_id != message.sender:
                asyncio.create_task(agent.receive_message(message))

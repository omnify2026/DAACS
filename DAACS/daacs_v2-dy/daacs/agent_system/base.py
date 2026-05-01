from abc import ABC, abstractmethod
from typing import List, Optional, Callable, Dict, Any
import logging

from .protocol import AgentMessage, AgentStatus, MessageType
from ..utils import setup_logger

class BaseAgent(ABC):
    """
    Abstract Base Agent Class for DAACS Multi-Agent System
    """
    def __init__(self, agent_id: str, role: str):
        self.agent_id = agent_id
        self.role = role
        self.status = AgentStatus.IDLE
        self.inbox: List[AgentMessage] = []
        self.logger = setup_logger(f"Agent-{agent_id}")
        self._message_bus = None  # Injected by Manager

    def set_message_bus(self, bus):
        """Inject MessageBus instance"""
        self._message_bus = bus

    async def send_message(self, receiver: str, content: Any, msg_type: MessageType = MessageType.INFO):
        """Send a message to another agent or broadcast"""
        if not self._message_bus:
            self.logger.error("MessageBus not connected!")
            return

        msg = AgentMessage(
            sender=self.agent_id,
            receiver=receiver,
            type=msg_type,
            content=content
        )
        await self._message_bus.route_message(msg)

    async def receive_message(self, message: AgentMessage):
        """Receive a message into inbox"""
        self.logger.info(f"Received message from {message.sender}: {message.type}")
        self.inbox.append(message)
        await self.process_message(message)

    @abstractmethod
    async def process_message(self, message: AgentMessage):
        """Process incoming message (Implement in subclasses)"""
        pass

    def update_status(self, status: AgentStatus):
        self.status = status
        self.logger.info(f"Status changed to: {status}")
        # Could broadcast status change here

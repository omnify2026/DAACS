from fastapi import APIRouter
from sse_starlette.sse import EventSourceResponse
import asyncio
from typing import Dict, Any

from daacs.server_context import ServerContext
from daacs.agent_system.protocol import AgentMessage

class StreamManager:
    """
    Manages SSE connections for Agent Visualization.
    """
    def __init__(self):
        self.message_queue = asyncio.Queue()
        self.active_connections = 0

    async def broadcast(self, message: Any):
        """Put message into the queue for streaming. Accepts AgentMessage or dict."""
        if hasattr(message, "to_dict"):
             msg_dict = message.to_dict()
        elif isinstance(message, dict):
             msg_dict = message
        else:
             # Fallback for AgentMessage if not using to_dict (legacy compat)
             msg_dict = {
                "message_id": getattr(message, "message_id", "unknown"),
                "sender": getattr(message, "sender", "system"),
                "receiver": getattr(message, "receiver", "all"),
                "type": getattr(message, "type", "info"),
                "content": getattr(message, "content", str(message)),
                "timestamp": getattr(message, "timestamp", 0)
            }
        
        await self.message_queue.put(msg_dict)

    async def event_generator(self):
        """Yields messages as SSE events with heartbeat"""
        self.active_connections += 1
        try:
            while True:
                try:
                    # Wait with timeout for next message (15 seconds)
                    data = await asyncio.wait_for(self.message_queue.get(), timeout=15.0)
                    yield {
                        "event": "message",
                        "data": data
                    }
                except asyncio.TimeoutError:
                    # Send heartbeat to keep connection alive
                    yield {
                        "event": "heartbeat",
                        "data": {"type": "ping", "timestamp": __import__("time").time()}
                    }
        except asyncio.CancelledError:
            self.active_connections -= 1
            print(f"Stream client disconnected. Active: {self.active_connections}")


# Global Stream Manager Instance
stream_manager = StreamManager()

def init_stream_routes(ctx: ServerContext) -> APIRouter:
    router = APIRouter(prefix="/api/stream", tags=["Visualization"])

    @router.get("/events")
    async def run_stream():
        """
        SSE Endpoint for Real-time Agent Messages
        """
        return EventSourceResponse(stream_manager.event_generator())

    return router

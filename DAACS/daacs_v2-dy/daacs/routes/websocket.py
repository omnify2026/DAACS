import json
import asyncio
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from ..server_context import ServerContext

def init_websocket_routes(ctx: ServerContext) -> APIRouter:
    router = APIRouter()
    manager = ctx.manager

    @router.websocket("/ws/projects/{project_id}")
    async def websocket_endpoint(websocket: WebSocket, project_id: str):
        await manager.connect(project_id, websocket)
        try:
            while True:
                # Keep connection alive and listen for client messages
                data = await websocket.receive_text()
                try:
                    msg = json.loads(data)
                    if msg.get("type") == "ping":
                        await websocket.send_json({"type": "pong"})
                except json.JSONDecodeError:
                    pass
        except WebSocketDisconnect:
            manager.disconnect(project_id, websocket)
        except Exception as e:
            ctx.logger.error(f"WebSocket error for project {project_id}: {e}")
            manager.disconnect(project_id, websocket)
            
    return router

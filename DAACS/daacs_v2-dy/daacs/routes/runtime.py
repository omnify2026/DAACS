import threading
import time

import requests
from fastapi import APIRouter, HTTPException, Response, WebSocket, WebSocketDisconnect

from ..server_context import ServerContext
from ..config import HTTP_REQUEST_TIMEOUT_SEC
from ..monitoring.token_tracker import token_tracker


def init_runtime_routes(ctx: ServerContext) -> APIRouter:
    router = APIRouter()

    @router.websocket("/ws/projects/{project_id}/logs")
    async def websocket_endpoint(websocket: WebSocket, project_id: str):
        import asyncio
        await ctx.manager.connect(project_id, websocket)
        try:
            # WebSocket with timeout to prevent resource leaks
            WEBSOCKET_TIMEOUT_SEC = 300  # 5 minutes
            while True:
                try:
                    # Wait for message with timeout
                    await asyncio.wait_for(
                        websocket.receive_text(),
                        timeout=WEBSOCKET_TIMEOUT_SEC
                    )
                except asyncio.TimeoutError:
                    # Send ping to check if client is still alive
                    try:
                        await websocket.send_text('{"type":"ping"}')
                    except (RuntimeError, OSError):
                        break  # Client disconnected
        except WebSocketDisconnect:
            pass
        finally:
            ctx.manager.disconnect(project_id, websocket)

    @router.post("/api/projects/{project_id}/run")
    async def run_project(project_id: str):
        import asyncio
        from ..server_runtime import _start_orchestrator_thread
        
        with ctx.projects_lock:
            p_info = ctx.projects.get(project_id)
        if not p_info:
            raise HTTPException(status_code=404, detail="Project not found")

        with ctx.locked_project(p_info):
            existing = p_info.get("run_thread")
            if isinstance(existing, threading.Thread) and existing.is_alive():
                info = p_info.get("run_info") or {}
                return {
                    "status": "already_running",
                    "backend_port": info.get("backend_port"),
                    "frontend_port": info.get("frontend_port"),
                    "frontend_entry": info.get("frontend_entry", "/"),
                }
            project_status = p_info.get("status", "created")

        # 🆕 For completed/failed projects, just start servers (no workflow)
        if project_status in ("completed", "completed_with_warnings", "failed"):
            ctx.reset_project_runtime_state(p_info, clear_logs=True, clear_messages=False)
            with ctx.locked_project(p_info):
                p_info["run_info"] = {
                    "backend_port": None,
                    "frontend_port": None,
                    "frontend_entry": "/",
                }
                thread = threading.Thread(target=ctx.run_servers_sync, args=(project_id,))
                thread.daemon = True
                p_info["run_thread"] = thread
                info = p_info.get("run_info") or {}
            thread.start()
            return {
                "status": "started",
                "backend_port": info.get("backend_port"),
                "frontend_port": info.get("frontend_port"),
                "frontend_entry": info.get("frontend_entry", "/"),
            }

        # 🆕 For new/created/planning projects: Use _start_orchestrator_thread
        #    This ensures orchestrator is created if missing (e.g., after server restart)
        main_loop = asyncio.get_running_loop()
        status = _start_orchestrator_thread(project_id, main_loop, apply_source=False)
        
        with ctx.locked_project(p_info):
            info = p_info.get("run_info") or {}
        
        return {
            "status": status,
            "backend_port": info.get("backend_port"),
            "frontend_port": info.get("frontend_port"),
            "frontend_entry": info.get("frontend_entry", "/"),
        }


    @router.get("/api/projects/{project_id}/run/status")
    async def get_run_status(project_id: str):
        p_info = ctx.get_project_or_404(project_id)
        with ctx.locked_project(p_info):
            info = p_info.get("run_info") or {}
        backend_port = info.get("backend_port")
        frontend_port = info.get("frontend_port")
        frontend_entry = info.get("frontend_entry", "/")

        return {
            "backend": {"running": backend_port is not None, "port": backend_port},
            "frontend": {"running": frontend_port is not None, "port": frontend_port, "entry": frontend_entry},
        }

    @router.post("/api/projects/{project_id}/run/stop")
    async def stop_run(project_id: str):
        with ctx.projects_lock:
            p_info = ctx.projects.get(project_id)
        if not p_info:
            raise HTTPException(status_code=404, detail="Project not found")

        workdir = p_info.get("workdir", "")
        ctx.request_orchestrator_stop(p_info, reason="stop")
        ctx.stop_project_servers(project_id, workdir)
        with ctx.locked_project(p_info):
            p_info["run_info"] = {"backend_port": None, "frontend_port": None, "frontend_entry": "/"}
            existing = p_info.get("run_thread")
            if not (isinstance(existing, threading.Thread) and existing.is_alive()):
                if p_info.get("status") not in ("completed", "completed_with_warnings", "failed"):
                    p_info["status"] = "stopped"
        ctx.save_project_state(project_id)
        await ctx.manager.broadcast_log(project_id, "[RUN_STOP] Servers stopped", node="DAACS")
        return {"status": "stopped"}

    @router.post("/api/projects/{project_id}/stop")
    async def stop_project(project_id: str):
        return await stop_run(project_id)

    @router.get("/api/projects/{project_id}/preview/{path:path}")
    async def preview_proxy(project_id: str, path: str = ""):
        """Preview 서버로의 프록시 엔드포인트."""
        # Security: Validate path to prevent SSRF/path traversal
        if '..' in path or path.startswith('/') or '://' in path:
            raise HTTPException(status_code=400, detail="Invalid path")
        
        p_info = ctx.get_project_or_404(project_id)
        with ctx.locked_project(p_info):
            run_info = p_info.get("run_info") or {}
        frontend_port = run_info.get("frontend_port")

        if not frontend_port:
            raise HTTPException(status_code=503, detail="Preview server not running")

        # Only allow localhost connections
        target_url = f"http://127.0.0.1:{frontend_port}/{path}"

        last_error = None
        for attempt in range(3):
            try:
                resp = requests.get(
                    target_url, 
                    timeout=HTTP_REQUEST_TIMEOUT_SEC,
                    allow_redirects=False  # Security: no redirects
                )
                content_type = resp.headers.get("Content-Type", "text/html")

                return Response(
                    content=resp.content,
                    status_code=resp.status_code,
                    media_type=content_type,
                )
            except requests.exceptions.ConnectionError as e:
                last_error = e
                time.sleep(0.5 * (attempt + 1))
            except requests.exceptions.Timeout as e:
                last_error = e
                time.sleep(0.5 * (attempt + 1))

        if isinstance(last_error, requests.exceptions.Timeout):
            raise HTTPException(status_code=504, detail="Preview server timeout")
        raise HTTPException(status_code=503, detail="Preview server connection failed")

    @router.get("/api/monitoring/token-summary")
    async def token_summary(limit: int = 20):
        """토큰/비용 통계."""
        sanitized = max(1, min(limit, 100))
        return token_tracker.get_summary(recent_limit=sanitized)

    return router

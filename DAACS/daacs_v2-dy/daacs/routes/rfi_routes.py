import json
import asyncio
import logging
from typing import Dict, List, Optional, Any, Literal
from fastapi import APIRouter, WebSocket, WebSocketDisconnect, HTTPException

from ..server_context import ServerContext
from ..server_state import logger
from ..graph.config_loader import DAACSConfig
from ..llm.cli_executor import SessionBasedCLIClient
from ..orchestrator.rfi.conversational_rfi import run_conversational_rfi, process_user_rfi_answer, is_go_command
from ..utils.chat_history import save_chat_history, load_chat_history
from ..orchestrator_agent import OrchestratorAgent  # 🆕 For finalize_rfp

# Logger for RFI routes
rfi_logger = logging.getLogger("RFI_Routes")

class DualRfiManager:
    """Manages WebSocket connections and sufficiency status for dual PM RFI sessions"""
    
    def __init__(self) -> None:
        # project_id -> list of websockets
        self.ui_connections: Dict[str, List[WebSocket]] = {}
        self.tech_connections: Dict[str, List[WebSocket]] = {}
        # project_id -> sufficiency status
        self.ui_sufficient: Dict[str, bool] = {}
        self.tech_sufficient: Dict[str, bool] = {}

    async def connect(self, project_id: str, websocket: WebSocket, role: Literal["ui", "tech"]) -> None:
        await websocket.accept()
        if role == "ui":
            if project_id not in self.ui_connections:
                self.ui_connections[project_id] = []
            self.ui_connections[project_id].append(websocket)
        elif role == "tech":
            if project_id not in self.tech_connections:
                self.tech_connections[project_id] = []
            self.tech_connections[project_id].append(websocket)

    def disconnect(self, project_id: str, websocket: WebSocket, role: Literal["ui", "tech"]) -> None:
        if role == "ui":
            if project_id in self.ui_connections and websocket in self.ui_connections[project_id]:
                self.ui_connections[project_id].remove(websocket)
                if not self.ui_connections[project_id]:
                    del self.ui_connections[project_id]
        elif role == "tech":
            if project_id in self.tech_connections and websocket in self.tech_connections[project_id]:
                self.tech_connections[project_id].remove(websocket)
                if not self.tech_connections[project_id]:
                    del self.tech_connections[project_id]

    async def broadcast_status(self, project_id: str):
        status = {
            "type": "sufficiency",
            "role": "system",
            "ui_sufficient": self.ui_sufficient.get(project_id, False),
            "tech_sufficient": self.tech_sufficient.get(project_id, False)
        }
        await self._broadcast(project_id, status)

    async def _broadcast(self, project_id: str, message: dict):
        # Broadcast to UI
        if project_id in self.ui_connections:
            for ws in self.ui_connections[project_id]:
                try:
                    await ws.send_json(message)
                except Exception as e:
                    rfi_logger.debug(f"[DualRFI] Failed to send to UI ws: {e}")
        # Broadcast to Tech
        if project_id in self.tech_connections:
            for ws in self.tech_connections[project_id]:
                try:
                    await ws.send_json(message)
                except Exception as e:
                    rfi_logger.debug(f"[DualRFI] Failed to send to Tech ws: {e}")

    def mark_sufficient(self, project_id: str, role: Literal["ui", "tech"], sufficient: bool) -> None:
        if role == "ui":
            self.ui_sufficient[project_id] = sufficient
        elif role == "tech":
            self.tech_sufficient[project_id] = sufficient

    def get_status(self, project_id: str) -> Dict[str, Any]:
        return {
            "active": True,
            "ui_connected": project_id in self.ui_connections and len(self.ui_connections[project_id]) > 0,
            "tech_connected": project_id in self.tech_connections and len(self.tech_connections[project_id]) > 0,
            "ui_sufficient": self.ui_sufficient.get(project_id, False),
            "tech_sufficient": self.tech_sufficient.get(project_id, False)
        }

rfi_manager = DualRfiManager()


# ==================== 🆕 Unified RFI Manager (Single Analyst) ====================

class UnifiedRfiManager:
    """Manages WebSocket connections for single analyst RFI sessions"""
    
    def __init__(self) -> None:
        self.connections: Dict[str, List[WebSocket]] = {}
        self.sufficient: Dict[str, bool] = {}

    async def connect(self, project_id: str, websocket: WebSocket) -> None:
        await websocket.accept()
        if project_id not in self.connections:
            self.connections[project_id] = []
        self.connections[project_id].append(websocket)
        rfi_logger.info(f"[UnifiedRFI] Connected: {project_id}")

    def disconnect(self, project_id: str, websocket: WebSocket) -> None:
        if project_id in self.connections and websocket in self.connections[project_id]:
            self.connections[project_id].remove(websocket)
            if not self.connections[project_id]:
                del self.connections[project_id]
        rfi_logger.info(f"[UnifiedRFI] Disconnected: {project_id}")

    async def broadcast(self, project_id: str, message: dict) -> None:
        if project_id in self.connections:
            for ws in self.connections[project_id]:
                try:
                    await ws.send_json(message)
                except Exception as e:
                    rfi_logger.debug(f"[UnifiedRFI] Failed to broadcast: {e}")

    def mark_sufficient(self, project_id: str, sufficient: bool) -> None:
        self.sufficient[project_id] = sufficient

    def get_status(self, project_id: str) -> Dict[str, Any]:
        return {
            "active": True,
            "connected": project_id in self.connections and len(self.connections[project_id]) > 0,
            "sufficient": self.sufficient.get(project_id, False)
        }

unified_rfi_manager = UnifiedRfiManager()

class LLMWrapper:
    """Wrapper to adapt SessionBasedCLIClient to run_conversational_rfi expectations"""
    def __init__(self, client: SessionBasedCLIClient):
        self.client = client

    def invoke(self, prompt: str) -> str:
        # conversational_rfi handles parsing, so just return the string
        return self.client.execute(prompt, raise_on_error=False)

    def invoke_structured(self, prompt: str) -> str:
        # Same as invoke for this client
        return self.client.execute(prompt, raise_on_error=False)

def _build_goal_context(goal: str, rfi_state: Dict[str, Any], chat_history: List[Dict[str, Any]]) -> str:
    refined_goal = (rfi_state or {}).get("refined_goal")
    if refined_goal:
        return refined_goal

    conversation_history = (rfi_state or {}).get("conversation_history", [])
    if conversation_history:
        parts = [goal]
        for qa in conversation_history:
            question = (qa.get("question") or "").strip()
            answer = (qa.get("answer") or "").strip()
            if question or answer:
                parts.append(f"{question} {answer}".strip())
        return " ".join(parts)

    user_text = " ".join(
        msg.get("content", "").strip()
        for msg in chat_history
        if msg.get("role") == "user" and msg.get("content")
    ).strip()
    return f"{goal}. {user_text}" if user_text else goal

async def _finalize_rfp_for_project(
    p_info: Dict[str, Any],
    goal_context: str,
) -> Dict[str, Any]:
    agent = OrchestratorAgent(workdir=p_info.get("workdir", "."))
    rfp_result = await asyncio.to_thread(agent.finalize_rfp, goal_context)

    parsed_rfp = None
    if isinstance(rfp_result, str):
        try:
            parsed_rfp = json.loads(rfp_result)
        except (TypeError, ValueError):
            parsed_rfp = None
    elif isinstance(rfp_result, dict):
        parsed_rfp = rfp_result

    refined_goal = None
    if isinstance(parsed_rfp, dict):
        refined_goal = parsed_rfp.get("goal")

    return {
        "rfp_result": rfp_result,
        "rfp_data": parsed_rfp or rfp_result,
        "refined_goal": refined_goal or goal_context,
    }

def _build_rfp_summary(rfp_data: Any, refined_goal: str) -> str:
    if not isinstance(rfp_data, dict):
        return """🚀 기본 설정으로 진행합니다:
• 플랫폼: 웹앱 (React + Vite)
• 백엔드: FastAPI
• 데이터베이스: SQLite

계획서 생성을 시작하려면 '계획 수립 진행' 버튼을 클릭하세요."""

    specs = rfp_data.get("specs", [])
    blueprint = rfp_data.get("blueprint", {}) or {}

    lines = [
        "🚀 프로젝트 분석 완료!",
        "",
        f"**목표**: {refined_goal}",
        "",
        "**기술 스택**:",
    ]
    for spec in specs:
        if spec.get("type") == "tech":
            desc = (spec.get("description") or "")[:50]
            lines.append(f"• {spec.get('title', 'N/A')}: {desc}")

    if blueprint.get("components"):
        lines.append("")
        lines.append(f"**구성요소**: {', '.join(blueprint.get('components', []))}")

    lines.append("")
    lines.append("계획서 생성을 시작하려면 '계획 수립 진행' 버튼을 클릭하세요.")
    return "\n".join(lines)

def init_rfi_routes(ctx: ServerContext) -> APIRouter:
    router = APIRouter()
    
    # Load config once or per request? Per request is safer if config changes, but once is efficient.
    # Instantiate config here to check defaults
    try:
        global_config = DAACSConfig()
    except Exception:
        global_config = DAACSConfig() # Fallback

    async def _handle_conversation(websocket: WebSocket, project_id: str, role: str, msg_content: Optional[str] = None):
        """Shared logic for handling RFI conversation flow"""
        p_info = ctx.get_project_or_404(project_id)
        
        # Initialize or retrieve RFI state - separated by role
        rfi_state_key = f"{role}_rfi_state"
        with ctx.locked_project(p_info):
            if rfi_state_key not in p_info:
                p_info[rfi_state_key] = {
                    "conversation_history": [],
                    "refined_goal": p_info.get("goal", ""),
                    "rfi_iteration": 0,
                    "rfi_question": "",
                    "rfi_phase": "start" # start, asking, complete
                }
            
            # Chat history storage - already separated by role
            chat_history_key = f"{role}_chat_history"
            if chat_history_key not in p_info:
                p_info[chat_history_key] = []
            
            if msg_content:
                p_info[chat_history_key].append({"role": "user", "content": msg_content})
                # 🆕 Save after user message
                save_chat_history(project_id, role, p_info[chat_history_key])
        
        # Prepare LLM client
        # We create a new client each time or reuse? SessionID persistence is good.
        # Use project_id as session_id to maintain context in CLI if supported.
        project_dir = global_config.config.get("project_dir", ".")
        cli_type = global_config.get_llm_source("orchestrator") # Use orchestrator LLM for RFI
        
        # Get model from project config or fall back to environment variable
        from ..config import PLANNER_MODEL
        orchestrator_model = PLANNER_MODEL  # Default from env
        p_info_model = p_info.get("config", {}).get("orchestrator_model")
        if p_info_model:
            orchestrator_model = p_info_model
        
        client = SessionBasedCLIClient(
            cwd=project_dir,
            cli_type=cli_type,
            client_name=f"rfi_{role}",
            project_id=project_id,
            session_id=f"{project_id}_{role}",
            model_name=orchestrator_model
        )
        llm = LLMWrapper(client)

        current_state = p_info[rfi_state_key]
        
        # Logic Flow
        response_content = ""
        rfi_response = {}

        if msg_content:
            # ROI: Process Answer
            # Run in thread to avoid blocking event loop
            result = await asyncio.to_thread(
                process_user_rfi_answer, 
                current_state, 
                msg_content
            )

            if result.get("action") == "auto_complete":
                base_goal = current_state.get("refined_goal") or p_info.get("goal", "")
                try:
                    agent = OrchestratorAgent(workdir=p_info.get("workdir", "."))
                    enriched_goal = await asyncio.to_thread(agent.auto_complete_specs, base_goal)
                except Exception as e:
                    rfi_logger.error(f"[DualRFI] auto_complete_specs failed: {e}")
                    enriched_goal = base_goal

                with ctx.locked_project(p_info):
                    p_info[rfi_state_key]["rfi_phase"] = "complete"
                    p_info[rfi_state_key]["refined_goal"] = enriched_goal
                    rfi_manager.mark_sufficient(project_id, role, True)
                    await rfi_manager.broadcast_status(project_id)
                    response_content = "No response received. Auto-completed basic specs. We are ready to proceed."
            else:
                # Update state with result
                with ctx.locked_project(p_info):
                    if result.get("action") == "finalize" or result.get("rfi_phase") == "complete":
                        p_info[rfi_state_key]["rfi_phase"] = "complete"
                        p_info[rfi_state_key]["refined_goal"] = result.get("refined_goal", p_info[rfi_state_key]["refined_goal"])
                        # Mark sufficiency
                        rfi_manager.mark_sufficient(project_id, role, True)
                        await rfi_manager.broadcast_status(project_id)
                        response_content = "RFI Completed. Thank you! We are ready to proceed."
                    else:
                        # Update history and iteration
                        p_info[rfi_state_key]["conversation_history"] = result.get("conversation_history", [])
                        p_info[rfi_state_key]["refined_goal"] = result.get("refined_goal", p_info[rfi_state_key]["refined_goal"])
                        p_info[rfi_state_key]["rfi_iteration"] = result.get("rfi_iteration", 0)
        
        # If not complete, ask next question
        if p_info[rfi_state_key]["rfi_phase"] != "complete":
            # Run conversational RFI logic
            rfi_next = await asyncio.to_thread(
                run_conversational_rfi,
                p_info.get("goal", ""),
                llm,
                p_info[rfi_state_key],
                "thinking" # Always thinking mode for interaction
            )
            
            with ctx.locked_project(p_info):
                if rfi_next.get("rfi_phase") == "asking":
                    question = rfi_next.get("rfi_question")
                    options = rfi_next.get("rfi_options", [])
                    p_info[rfi_state_key]["rfi_question"] = question
                    p_info[rfi_state_key]["rfi_phase"] = "asking"
                    
                    response_content = question
                    if options:
                        response_content += f"\n\nOptions: {', '.join(options)}"
                elif rfi_next.get("rfi_phase") == "complete":
                     p_info[rfi_state_key]["rfi_phase"] = "complete"
                     response_content = "Analysis complete. I have sufficient information."
                     rfi_manager.mark_sufficient(project_id, role, True)
                     await rfi_manager.broadcast_status(project_id)

        # Send response to user
        if response_content:
            response_msg = {
                "type": "pm",
                "role": role,
                "content": response_content
            }
            await websocket.send_json(response_msg)
            
            with ctx.locked_project(p_info):
                p_info[f"{role}_chat_history"].append({"role": "pm", "content": response_content})
                # 🆕 Save chat history to disk
                save_chat_history(project_id, role, p_info[f"{role}_chat_history"])


    @router.websocket("/ws/projects/{project_id}/rfi/ui")
    async def ui_rfi_endpoint(websocket: WebSocket, project_id: str):
        await rfi_manager.connect(project_id, websocket, "ui")
        try:
            # Send initial status
            await websocket.send_json({
                "type": "sufficiency",
                "role": "ui",
                "ui_sufficient": rfi_manager.ui_sufficient.get(project_id, False),
                "tech_sufficient": rfi_manager.tech_sufficient.get(project_id, False)
            })
            
            # 🆕 Load existing chat history from disk
            p_check = ctx.projects.get(project_id)
            if p_check:
                loaded_history = load_chat_history(project_id, "ui")
                if loaded_history:
                    with ctx.locked_project(p_check):
                        p_check["ui_chat_history"] = loaded_history
                    rfi_logger.info(f"[UI RFI] Loaded {len(loaded_history)} messages from disk")
                    # Send loaded messages to client
                    for msg in loaded_history:
                        await websocket.send_json({
                            "type": "pm" if msg["role"] == "pm" else "user",
                            "role": "ui",
                            "content": msg["content"]
                        })
                elif not p_check.get("ui_chat_history"):
                    # No history, start conversation
                    await _handle_conversation(websocket, project_id, "ui", None)

            while True:
                data = await websocket.receive_text()
                try:
                    msg = json.loads(data)
                    content = msg.get("content")
                    if content:
                        await _handle_conversation(websocket, project_id, "ui", content)
                except json.JSONDecodeError:
                    pass
        except WebSocketDisconnect:
            rfi_manager.disconnect(project_id, websocket, "ui")
        except Exception as e:
            logger.error(f"UI RFI Error: {e}")
            rfi_manager.disconnect(project_id, websocket, "ui")

    @router.websocket("/ws/projects/{project_id}/rfi/tech")
    async def tech_rfi_endpoint(websocket: WebSocket, project_id: str):
        await rfi_manager.connect(project_id, websocket, "tech")
        try:
            await websocket.send_json({
                "type": "sufficiency",
                "role": "tech",
                "ui_sufficient": rfi_manager.ui_sufficient.get(project_id, False),
                "tech_sufficient": rfi_manager.tech_sufficient.get(project_id, False)
            })
            
            # 🆕 Load existing chat history from disk
            p_check = ctx.projects.get(project_id)
            if p_check:
                loaded_history = load_chat_history(project_id, "tech")
                if loaded_history:
                    with ctx.locked_project(p_check):
                        p_check["tech_chat_history"] = loaded_history
                    rfi_logger.info(f"[Tech RFI] Loaded {len(loaded_history)} messages from disk")
                    # Send loaded messages to client
                    for msg in loaded_history:
                        await websocket.send_json({
                            "type": "pm" if msg["role"] == "pm" else "user",
                            "role": "tech",
                            "content": msg["content"]
                        })
                elif not p_check.get("tech_chat_history"):
                    # No history, start conversation
                    await _handle_conversation(websocket, project_id, "tech", None)

            while True:
                data = await websocket.receive_text()
                try:
                    msg = json.loads(data)
                    content = msg.get("content")
                    if content:
                        await _handle_conversation(websocket, project_id, "tech", content)
                except json.JSONDecodeError:
                    pass
        except WebSocketDisconnect:
            rfi_manager.disconnect(project_id, websocket, "tech")
        except Exception as e:
            logger.error(f"Tech RFI Error: {e}")
            rfi_manager.disconnect(project_id, websocket, "tech")

    @router.get("/api/projects/{project_id}/rfi/status")
    async def get_rfi_status(project_id: str):
        return rfi_manager.get_status(project_id)
        
    @router.get("/api/projects/{project_id}/chat-history")
    async def get_chat_history(project_id: str):
        p_info = ctx.get_project_or_404(project_id)
        with ctx.locked_project(p_info):
            ui_messages = p_info.get("ui_chat_history", [])
            tech_messages = p_info.get("tech_chat_history", [])
            unified_messages = p_info.get("chat_history", [])

        if not ui_messages:
            ui_messages = load_chat_history(project_id, "ui")
            if ui_messages:
                with ctx.locked_project(p_info):
                    p_info["ui_chat_history"] = ui_messages

        if not tech_messages:
            tech_messages = load_chat_history(project_id, "tech")
            if tech_messages:
                with ctx.locked_project(p_info):
                    p_info["tech_chat_history"] = tech_messages

        if not unified_messages:
            unified_messages = load_chat_history(project_id, "unified")
            if unified_messages:
                with ctx.locked_project(p_info):
                    p_info["chat_history"] = unified_messages

        return {
            "ui_messages": ui_messages,
            "tech_messages": tech_messages,
            "messages": unified_messages  # 🆕 Unified history
        }

    # ==================== 🆕 Unified RFI Endpoints (Single Analyst) ====================

    @router.websocket("/ws/projects/{project_id}/rfi")
    async def unified_rfi_endpoint(websocket: WebSocket, project_id: str):
        """Single analyst RFI WebSocket endpoint"""
        await unified_rfi_manager.connect(project_id, websocket)
        try:
            p_info = ctx.get_project_or_404(project_id)
            
            # 🆕 Check if build is already completed - skip RFI entirely
            with ctx.locked_project(p_info):
                current_status = p_info.get("status", "")
                final_status = p_info.get("final_status", "")
            
            completed_statuses = {"completed", "completed_with_warnings", "delivered", "saved"}
            if current_status in completed_statuses or final_status in completed_statuses:
                rfi_logger.info(f"[UnifiedRFI] Build already complete on connect (status={current_status}), sending completion notice")
                await websocket.send_json({
                    "type": "pm",
                    "content": "✅ 빌드가 이미 완료되었습니다. 새 프로젝트를 시작하려면 새 프로젝트를 생성해주세요."
                })
                # Keep connection open but don't start RFI flow
                while True:
                    await websocket.receive_text()  # Just consume messages without processing
                return
            
            # Load existing chat history - only send PM messages (user already has their own)
            loaded_history = load_chat_history(project_id, "unified")
            if loaded_history:
                with ctx.locked_project(p_info):
                    p_info["chat_history"] = loaded_history
                rfi_logger.info(f"[UnifiedRFI] Loaded {len(loaded_history)} messages from disk")
                # Only send PM messages, user will display their own locally
                for msg in loaded_history:
                    if msg.get("role") == "pm":
                        await websocket.send_json({
                            "type": "pm",
                            "content": msg.get("content", "")
                        })
            
            # Initialize RFI state if not exists
            with ctx.locked_project(p_info):
                if "rfi_state" not in p_info:
                    p_info["rfi_state"] = {
                        "conversation_history": [],
                        "refined_goal": p_info.get("goal", ""),
                        "rfi_iteration": 0,
                        "rfi_question": "",
                        "rfi_phase": "start"
                    }
                if "chat_history" not in p_info:
                    p_info["chat_history"] = []

                if p_info.get("rfp_data"):
                    p_info["rfi_state"]["rfi_phase"] = "complete"
                    if isinstance(p_info["rfp_data"], dict) and p_info["rfp_data"].get("goal"):
                        p_info["rfi_state"]["refined_goal"] = p_info["rfp_data"]["goal"]

                if not p_info["chat_history"] and p_info.get("goal"):
                    p_info["chat_history"].append({"role": "user", "content": p_info["goal"]})
                    save_chat_history(project_id, "unified", p_info["chat_history"])

                chat_history_snapshot = list(p_info.get("chat_history", []))
                rfi_phase = p_info["rfi_state"].get("rfi_phase")
                has_pm = any(msg.get("role") == "pm" for msg in chat_history_snapshot)
            
            # Send initial question if no PM message yet and RFI not complete
            if rfi_phase != "complete" and not has_pm:
                await _handle_unified_conversation(websocket, project_id, None)
            
            # Message loop
            while True:
                data = await websocket.receive_text()
                try:
                    msg = json.loads(data)
                    content = msg.get("content")
                    if content:
                        await _handle_unified_conversation(websocket, project_id, content)
                except json.JSONDecodeError:
                    pass
                    
        except WebSocketDisconnect:
            unified_rfi_manager.disconnect(project_id, websocket)
        except Exception as e:
            logger.error(f"[UnifiedRFI] Error: {e}")
            unified_rfi_manager.disconnect(project_id, websocket)

    async def _handle_unified_conversation(websocket: WebSocket, project_id: str, msg_content: Optional[str] = None):
        """Handle single analyst RFI conversation"""
        p_info = ctx.get_project_or_404(project_id)
        
        # 🆕 Check if build is already completed - prevent RFI restart
        with ctx.locked_project(p_info):
            current_status = p_info.get("status", "")
            final_status = p_info.get("final_status", "")
        
        completed_statuses = {"completed", "completed_with_warnings", "delivered", "saved"}
        if current_status in completed_statuses or final_status in completed_statuses:
            rfi_logger.info(f"[UnifiedRFI] Build already complete (status={current_status}, final={final_status}), skipping RFI")
            await websocket.send_json({
                "type": "pm",
                "content": "✅ 빌드가 이미 완료되었습니다. 새 프로젝트를 시작하려면 새 프로젝트를 생성해주세요."
            })
            return
        
        # Save user message
        if msg_content:
            with ctx.locked_project(p_info):
                p_info["chat_history"].append({"role": "user", "content": msg_content})
                save_chat_history(project_id, "unified", p_info["chat_history"])
        
        # Prepare LLM client
        project_dir = global_config.config.get("project_dir", ".")
        cli_type = global_config.get_llm_source("orchestrator")
        
        # Get model from project config or fall back to environment variable
        from ..config import PLANNER_MODEL
        orchestrator_model = PLANNER_MODEL  # Default from env
        p_info_model = p_info.get("config", {}).get("orchestrator_model")
        if p_info_model:
            orchestrator_model = p_info_model
        
        client = SessionBasedCLIClient(
            cwd=project_dir,
            cli_type=cli_type,
            client_name="rfi_analyst",
            project_id=project_id,
            session_id=f"{project_id}_analyst",
            model_name=orchestrator_model
        )
        llm = LLMWrapper(client)
        
        current_state = p_info["rfi_state"]
        response_content = ""
        
        # 🚀 Fast-path: Skip RFI entirely if first input is 'go'
        if msg_content and is_go_command(msg_content) and current_state.get("rfi_iteration", 0) == 0:
            rfi_logger.info(f"[UnifiedRFI] Fast-path: 'go' as first input, skipping RFI LLM calls")
            with ctx.locked_project(p_info):
                p_info["rfi_state"]["rfi_phase"] = "complete"
                p_info["rfi_state"]["refined_goal"] = p_info.get("goal", "")
            
            goal_context = p_info.get("goal", "")
            try:
                existing_rfp = p_info.get("rfp_data")
                if existing_rfp:
                    response_content = _build_rfp_summary(existing_rfp, goal_context)
                else:
                    rfp_payload = await _finalize_rfp_for_project(p_info, goal_context)
                    with ctx.locked_project(p_info):
                        p_info["rfp_data"] = rfp_payload["rfp_data"]
                        p_info["rfi_state"]["refined_goal"] = rfp_payload["refined_goal"]
                    response_content = _build_rfp_summary(rfp_payload["rfp_data"], rfp_payload["refined_goal"])
            except Exception as e:
                rfi_logger.error(f"[UnifiedRFI] finalize_rfp failed (fast-path): {e}")
                response_content = "🚀 기본 설정으로 진행합니다. 이제 계획 수립을 시작할 수 있습니다."
            
            unified_rfi_manager.mark_sufficient(project_id, True)
            await websocket.send_json({"type": "sufficiency", "sufficient": True})
            await websocket.send_json({"type": "pm", "content": response_content})
            with ctx.locked_project(p_info):
                p_info["chat_history"].append({"role": "pm", "content": response_content})
                save_chat_history(project_id, "unified", p_info["chat_history"])
            return
        
        if msg_content:
            # Process user answer
            result = await asyncio.to_thread(
                process_user_rfi_answer,
                current_state,
                msg_content
            )
            
            if result.get("action") == "auto_complete":
                base_goal = current_state.get("refined_goal") or p_info.get("goal", "")
                try:
                    agent = OrchestratorAgent(workdir=p_info.get("workdir", "."))
                    enriched_goal = await asyncio.to_thread(agent.auto_complete_specs, base_goal)
                except Exception as e:
                    rfi_logger.error(f"[UnifiedRFI] auto_complete_specs failed: {e}")
                    enriched_goal = base_goal

                with ctx.locked_project(p_info):
                    p_info["rfi_state"]["rfi_phase"] = "complete"
                    p_info["rfi_state"]["refined_goal"] = enriched_goal
                    p_info["rfi_state"]["auto_completed"] = True

                goal_context = _build_goal_context(p_info.get("goal", ""), p_info["rfi_state"], p_info.get("chat_history", []))
                try:
                    existing_rfp = p_info.get("rfp_data")
                    if existing_rfp:
                        response_content = _build_rfp_summary(existing_rfp, p_info["rfi_state"]["refined_goal"])
                    else:
                        rfp_payload = await _finalize_rfp_for_project(p_info, goal_context)
                        with ctx.locked_project(p_info):
                            p_info["rfp_data"] = rfp_payload["rfp_data"]
                            p_info["rfi_state"]["refined_goal"] = rfp_payload["refined_goal"]
                        response_content = _build_rfp_summary(rfp_payload["rfp_data"], rfp_payload["refined_goal"])
                except Exception as e:
                    rfi_logger.error(f"[UnifiedRFI] finalize_rfp failed: {e}")
                    response_content = "입력 없이 진행하셨습니다. 기본 스펙을 자동완성했습니다. 이제 계획 수립을 진행할 수 있습니다."

                unified_rfi_manager.mark_sufficient(project_id, True)
                await websocket.send_json({"type": "sufficiency", "sufficient": True})
            elif result.get("action") == "finalize" or result.get("rfi_phase") == "complete":
                with ctx.locked_project(p_info):
                    p_info["rfi_state"]["rfi_phase"] = "complete"
                    p_info["rfi_state"]["refined_goal"] = result.get("refined_goal", p_info["rfi_state"]["refined_goal"])

                goal_context = _build_goal_context(p_info.get("goal", ""), p_info["rfi_state"], p_info.get("chat_history", []))
                try:
                    existing_rfp = p_info.get("rfp_data")
                    if existing_rfp:
                        response_content = _build_rfp_summary(existing_rfp, p_info["rfi_state"]["refined_goal"])
                    else:
                        rfp_payload = await _finalize_rfp_for_project(p_info, goal_context)
                        with ctx.locked_project(p_info):
                            p_info["rfp_data"] = rfp_payload["rfp_data"]
                            p_info["rfi_state"]["refined_goal"] = rfp_payload["refined_goal"]
                        response_content = _build_rfp_summary(rfp_payload["rfp_data"], rfp_payload["refined_goal"])
                except Exception as e:
                    rfi_logger.error(f"[UnifiedRFI] finalize_rfp failed: {e}")
                    response_content = "분석이 완료되었습니다. 이제 계획 수립을 진행할 수 있습니다."

                unified_rfi_manager.mark_sufficient(project_id, True)
                await websocket.send_json({"type": "sufficiency", "sufficient": True})
            else:
                with ctx.locked_project(p_info):
                    p_info["rfi_state"]["conversation_history"] = result.get("conversation_history", [])
                    p_info["rfi_state"]["refined_goal"] = result.get("refined_goal", p_info["rfi_state"]["refined_goal"])
                    p_info["rfi_state"]["rfi_iteration"] = result.get("rfi_iteration", 0)
        
        # Generate next question if not complete
        if p_info["rfi_state"]["rfi_phase"] != "complete":
            rfi_next = await asyncio.to_thread(
                run_conversational_rfi,
                p_info.get("goal", ""),
                llm,
                p_info["rfi_state"],
                "thinking"
            )

            if rfi_next.get("rfi_phase") == "asking":
                with ctx.locked_project(p_info):
                    question = rfi_next.get("rfi_question", "")
                    options = rfi_next.get("rfi_options", [])
                    hint = rfi_next.get("rfi_hint", "")
                    p_info["rfi_state"]["rfi_question"] = question
                    p_info["rfi_state"]["rfi_phase"] = "asking"

                response_content = question
                if options:
                    response_content += f"\n\n선택지: {', '.join(options)}"
                # 🆕 Add hint about 'go' command
                if hint and p_info["rfi_state"].get("rfi_iteration", 0) == 0:
                    response_content += f"\n\n💡 {hint}"
            elif rfi_next.get("rfi_phase") == "complete":
                with ctx.locked_project(p_info):
                    p_info["rfi_state"]["rfi_phase"] = "complete"
                    rfi_state_snapshot = dict(p_info.get("rfi_state", {}))
                    chat_history_snapshot = list(p_info.get("chat_history", []))
                    existing_rfp = p_info.get("rfp_data")

                goal_context = _build_goal_context(p_info.get("goal", ""), rfi_state_snapshot, chat_history_snapshot)
                try:
                    if existing_rfp:
                        response_content = _build_rfp_summary(existing_rfp, rfi_state_snapshot.get("refined_goal", goal_context))
                    else:
                        rfp_payload = await _finalize_rfp_for_project(p_info, goal_context)
                        with ctx.locked_project(p_info):
                            p_info["rfp_data"] = rfp_payload["rfp_data"]
                            p_info["rfi_state"]["refined_goal"] = rfp_payload["refined_goal"]
                        response_content = _build_rfp_summary(rfp_payload["rfp_data"], rfp_payload["refined_goal"])
                except Exception as e:
                    rfi_logger.error(f"[UnifiedRFI] finalize_rfp failed after completion: {e}")
                    response_content = "분석이 완료되었습니다. 충분한 정보가 수집되었습니다."

                unified_rfi_manager.mark_sufficient(project_id, True)
                await websocket.send_json({"type": "sufficiency", "sufficient": True})
        
        # Send response
        if response_content:
            await websocket.send_json({"type": "pm", "content": response_content})
            with ctx.locked_project(p_info):
                p_info["chat_history"].append({"role": "pm", "content": response_content})
                save_chat_history(project_id, "unified", p_info["chat_history"])

    @router.get("/api/projects/{project_id}/rfi/unified/status")
    async def get_unified_rfi_status(project_id: str):
        return unified_rfi_manager.get_status(project_id)

    # 🆕 POST /rfi/complete - Finalize RFI and generate plan
    @router.post("/api/projects/{project_id}/rfi/complete")
    async def complete_rfi(project_id: str):
        """Complete RFI process and generate the full plan"""
        p_info = ctx.get_project_or_404(project_id)

        with ctx.locked_project(p_info):
            goal = p_info.get("goal", "")
            rfi_state = dict(p_info.get("rfi_state", {}))
            chat_history = list(p_info.get("chat_history", []))
            existing_rfp = p_info.get("rfp_data")

        try:
            parsed_rfp = None
            rfp_result = existing_rfp
            enriched_goal = goal

            if existing_rfp:
                if isinstance(existing_rfp, dict):
                    parsed_rfp = existing_rfp
                elif isinstance(existing_rfp, str):
                    try:
                        parsed_rfp = json.loads(existing_rfp)
                    except (TypeError, ValueError):
                        parsed_rfp = None
            else:
                goal_context = _build_goal_context(goal, rfi_state, chat_history)
                rfp_payload = await _finalize_rfp_for_project(p_info, goal_context)
                rfp_result = rfp_payload["rfp_result"]
                parsed_rfp = rfp_payload["rfp_data"] if isinstance(rfp_payload["rfp_data"], dict) else None
                enriched_goal = rfp_payload["refined_goal"]
            
            # Store the result
            with ctx.locked_project(p_info):
                p_info["rfp_data"] = parsed_rfp or rfp_result
                p_info["plan_status"] = "pending_confirmation"
                p_info["status"] = "draft"  # Ready for building
                
                # Also update the goal if enriched
                if enriched_goal != goal:
                    p_info["goal"] = enriched_goal
                
                # Add log entry
                p_info["logs"].append({
                    "timestamp": __import__('datetime').datetime.now().isoformat(),
                    "node": "DAACS",
                    "message": f"[RFP_FINALIZED] Plan generated successfully",
                    "level": "info"
                })
            
            return {
                "status": "success",
                "message": "RFI completed and plan generated",
                "rfp": rfp_result
            }
        except Exception as e:
            rfi_logger.error(f"Failed to complete RFI: {e}")
            raise HTTPException(status_code=500, detail=str(e))

    return router

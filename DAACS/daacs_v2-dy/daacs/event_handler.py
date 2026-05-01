"""
DAACS Event Handler
오케스트레이터 이벤트 콜백 처리 (공룡 함수 리팩토링)
"""
import json
import asyncio
import re
from datetime import datetime, timezone
from typing import Dict, Any, Callable, Optional

from .utils import setup_logger
from .server_helpers import save_project_context

logger = setup_logger("EventHandler")


class EventHandler:
    """
    오케스트레이터 이벤트 핸들러
    create_project의 거대한 event_cb 함수를 분리
    """
    
    def __init__(
        self,
        project_id: str,
        p_info: Dict[str, Any],
        emit_to_nova: Callable,
        broadcast_log: Callable,
        save_state: Callable,
        main_loop: asyncio.AbstractEventLoop = None
    ):
        self.project_id = project_id
        self.p_info = p_info
        self.emit_to_nova = emit_to_nova
        self.broadcast_log = broadcast_log
        self.save_state = save_state
        self.save_state = save_state
        self.main_loop = main_loop
        
        # Issue 86: Safety check for main_loop if needed in future, 
        # though currently we handle None in _broadcast_websocket
        if self.main_loop is None:
            logger.debug(f"EventHandler initialized without main_loop for project {project_id}")
    
    def handle(self, event_type: str, data: Dict[str, Any]):
        """이벤트 처리 메인 핸들러"""
        lock = self.p_info.get("lock")
        # 1. 메시지 저장
        if lock:
            with lock:
                self._store_message(event_type, data)
        else:
            self._store_message(event_type, data)
        
        # 2. Nova로 전송
        self._emit_to_nova_safe(event_type, data)
        
        # 3. WebSocket 브로드캐스트
        self._broadcast_websocket(event_type, data)
        
        # 4. SSE 브로드캐스트 (New for Visualization)
        self._broadcast_sse(event_type, data)
        
        # 5. 상태 저장
        if lock:
            with lock:
                self.save_state(self.project_id)
        else:
            self.save_state(self.project_id)
    
    def _store_message(self, event_type: str, data: Dict[str, Any]):
        """이벤트별 메시지 저장"""
        handlers = {
            "RFI_QUESTION": self._handle_rfi_question,
            "message": self._handle_message,
            "RFP_FINALIZED": self._handle_rfp_finalized,
            "BUILD_START": self._handle_build_start,
            "PLAN_CREATED": self._handle_plan_created,
            "ACTION_START": self._handle_action_start,
            "ACTION_DONE": self._handle_action_done,
            "BUILD_COMPLETE": self._handle_build_complete,
            "WORKFLOW_NODE": self._handle_workflow_node,
        }
        
        handler = handlers.get(event_type)
        if handler:
            handler(data)
        else:
            logger.debug("No handler for event type: %s", event_type)
    
    def _add_message(self, content: str, role: str = "daacs"):
        """메시지 추가 헬퍼"""
        if not content:
            return
        self.p_info["messages"].append({
            "id": len(self.p_info["messages"]) + 1,
            "projectId": self.project_id,  # Keep as string, don't convert to int
            "role": role,
            "content": content,
            "createdAt": datetime.now(timezone.utc).isoformat()
        })
    
    def _format_elapsed(self, data: Dict[str, Any]) -> str:
        """경과 시간 포맷팅"""
        elapsed = data.get("elapsed_sec")
        # Issue 91: Strict type checking for elapsed time
        if isinstance(elapsed, (int, float)):
            return f" ({elapsed:.1f}s)"
        return ""
    
    def _handle_rfi_question(self, data: Dict[str, Any]):
        """RFI 질문 처리"""
        content = data.get("question", "")
        if content:
            content = f"{content}{self._format_elapsed(data)}"
            self._add_message(content)
    
    def _handle_message(self, data: Dict[str, Any]):
        """일반 메시지 처리"""
        content = data.get("content", "")
        self._add_message(content)
    
    def _handle_rfp_finalized(self, data: Dict[str, Any]):
        """RFP 확정 처리"""
        structured = data.get("structured_rfp", {})
        if structured:
            self.p_info["rfp"] = structured
        
        if structured and structured.get("goal"):
            content = f"✅ RFP 확정: {structured.get('goal')}"
        elif data.get("rfp"):
            content = "✅ RFP가 확정되었습니다."
        else:
            content = "✅ 요구사항 분석이 완료되었습니다. 빌드를 시작합니다."
        
        content = f"{content}{self._format_elapsed(data)}"
        self._add_message(content)
    
    def _handle_build_start(self, data: Dict[str, Any]):
        """빌드 시작 처리"""
        self.p_info["status"] = "planning"
        self._add_message("🔨 빌드를 시작합니다...")
    
    def _handle_plan_created(self, data: Dict[str, Any]):
        """계획 생성 처리"""
        actions = data.get("actions", [])
        needs_backend = data.get("needs_backend")
        if needs_backend is not None:
            self.p_info["needs_backend"] = bool(needs_backend)
        needs_frontend = data.get("needs_frontend")
        if needs_frontend is not None:
            self.p_info["needs_frontend"] = bool(needs_frontend)
        api_spec = data.get("api_spec")
        if isinstance(api_spec, dict):
            self.p_info["api_spec"] = api_spec
        try:
            self.p_info["plan"] = json.dumps({"actions": actions}, ensure_ascii=False, indent=2)
        except (TypeError, ValueError):
            logger.debug("Failed to serialize plan with ensure_ascii=False", exc_info=True)
            self.p_info["plan"] = json.dumps({"actions": actions})
        self.p_info["plan_status"] = "pending_confirmation"
        
        content = f"📋 {len(actions)}개의 작업 계획이 생성되었습니다.{self._format_elapsed(data)}"
        self._add_message(content)
    
    def _handle_action_start(self, data: Dict[str, Any]):
        """작업 시작 처리"""
        action = data.get("action", {}) or {}
        client = data.get("client", "")
        action_type = (action.get("type") or "").lower()
        if action_type in {"planning", "replanning", "judgment"}:
            self.p_info["status"] = "planning"
        else:
            self.p_info["status"] = "running"
        
        comment = (action.get("comment") or "").strip()
        instruction = (action.get("instruction") or "").strip().replace("\n", " ")
        summary = comment or instruction[:120] or "작업"
        
        if client:
            summary = f"[{client}] {summary}"
        
        self._add_message(f"▶️ 작업 시작: {summary}")
    
    def _handle_action_done(self, data: Dict[str, Any]):
        """작업 완료 처리"""
        review = data.get("review", {}) or {}
        ok = bool(review.get("success"))
        action = data.get("action", {}) or {}
        action_type = (action.get("type") or "").lower()
        
        comment = (action.get("comment") or "").strip()
        instruction = (action.get("instruction") or "").strip().replace("\n", " ")
        summary = comment or instruction[:120] or "작업"
        
        # 실패 이유 추출
        reason = ""
        try:
            verdicts = (review.get("verify") or {}).get("verdicts") or []
            # Issue 92: Robust iteration over verdicts
            if isinstance(verdicts, list):
                failed = [v for v in verdicts if isinstance(v, dict) and not v.get("ok")]
                if failed:
                    reason = failed[0].get("reason", "") or ""
            else:
                 logger.warning(f"Invalid verdicts format: {type(verdicts)}")
        except (TypeError, KeyError, AttributeError):
            logger.debug("Failed to extract verification reason", exc_info=True)
        
        if reason in ("[]", "{}", "None"):
            reason = ""
        if not reason and not ok:
            fallback = (review.get("summary") or data.get("result") or "").strip()
            reason = fallback[:160]

        status_text = "✅ 완료" if ok else "❌ 실패"
        status_text = f"{status_text}{self._format_elapsed(data)}"
        if not ok:
            if reason:
                status_text = f"{status_text} ({reason})"
            else:
                status_text = f"{status_text} (상세 로그 확인 필요)"
        
        self._add_message(f"{status_text}: {summary}")

        if action_type == "code_review":
            score = review.get("score")
            if score is None:
                result_text = data.get("result", "")
                match = re.search(r"(\d+)\s*/\s*10", result_text)
                if match:
                    score = int(match.group(1))
            self.p_info["quality"] = {
                "code_review_score": score,
                "code_review_passed": bool(review.get("success")),
                "critical_issues": review.get("critical_issues"),
                "goal_aligned": review.get("goal_aligned"),
                "summary": data.get("result", "")
            }
            self.p_info["code_review_score"] = score
            self.p_info["code_review_passed"] = bool(review.get("success"))
            self.p_info["code_review_critical_issues"] = review.get("critical_issues")
            self.p_info["code_review_goal_aligned"] = review.get("goal_aligned")
    
            self.p_info["code_review_critical_issues"] = review.get("critical_issues")
            self.p_info["code_review_goal_aligned"] = review.get("goal_aligned")

    def _handle_workflow_node(self, data: Dict[str, Any]):
        """워크플로우 노드 상태 저장"""
        node_id = data.get("node_id")
        if node_id:
            self.p_info.setdefault("workflow_state", {})[node_id] = data
    
    def _handle_build_complete(self, data: Dict[str, Any]):
        """빌드 완료 처리"""
        status = data.get("status", "")
        self._add_message(f"🏁 빌드 종료: {status or 'Success'}")
        
        # 🆕 Save PROJECT_CONTEXT.md for future reference
        workdir = self.p_info.get("workdir", "")
        if workdir:
            save_project_context(workdir, self.p_info)
    
    def _emit_to_nova_safe(self, event_type: str, data: Dict[str, Any]):
        """Nova로 안전하게 전송 (큰 페이로드 제외)"""
        safe_data = data
        
        if event_type == "ACTION_DONE":
            safe_data = dict(data)
            result_text = safe_data.pop("result", None)
            if isinstance(result_text, str):
                safe_data["result_len"] = len(result_text)
                safe_data["result_preview"] = result_text[-2000:]
        
        try:
             # Issue 87: Exception handling for Nova emission
             self.emit_to_nova(self.project_id, event_type, safe_data)
        except Exception as e:
             logger.error(f"Failed to emit to Nova ({event_type}): {e}")
    
    def _broadcast_websocket(self, event_type: str, data: Dict[str, Any]):
        """WebSocket으로 브로드캐스트"""
        # Issue 88: Ensure loop is running and valid
        if not self.main_loop or self.main_loop.is_closed() or not self.main_loop.is_running():
            return
        
        safe_data = data
        if event_type == "ACTION_DONE":
            safe_data = dict(data)
            safe_data.pop("result", None)
        
        try:
            asyncio.run_coroutine_threadsafe(
                self.broadcast_log(
                    self.project_id,
                    f"[{event_type}] {json.dumps(safe_data)}",
                    node="DAACS"
                ),
                self.main_loop
            )
        except Exception as e:
            logger.warning(f"Failed to broadcast: {e}")

    def _broadcast_sse(self, event_type: str, data: Dict[str, Any]):
        """SSE로 브로드캐스트 (Visualization)"""
        # Issue 88: Ensure loop is running and valid
        if not self.main_loop or self.main_loop.is_closed() or not self.main_loop.is_running():
            return

        # Lazy import to avoid circular dependency
        from .routes.stream import stream_manager

        # Prepare Payload
        # WorkflowVisualizer expects specific event types or data shapes.
        # Here we wrap generic DAACS events into a structure Frontend can parse.
        
        payload = {
            "type": event_type,
            "data": data,
            "project_id": self.project_id,
            "timestamp": datetime.now(timezone.utc).isoformat()
        }

        try:
            asyncio.run_coroutine_threadsafe(
                stream_manager.broadcast(payload),
                self.main_loop
            )
        except Exception as e:
            logger.warning(f"Failed to broadcast SSE: {e}")


def create_event_callback(
    project_id: str,
    p_info: Dict[str, Any],
    emit_to_nova: Callable,
    broadcast_log: Callable,
    save_state: Callable,
    main_loop: asyncio.AbstractEventLoop = None
) -> Callable:
    """이벤트 콜백 팩토리 함수"""
    handler = EventHandler(
        project_id=project_id,
        p_info=p_info,
        emit_to_nova=emit_to_nova,
        broadcast_log=broadcast_log,
        save_state=save_state,
        main_loop=main_loop
    )
    return handler.handle

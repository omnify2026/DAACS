
import logging
import time
import json
from typing import Dict, Any, List, Optional, Callable

logger = logging.getLogger(__name__)

class Planner:
    def __init__(self, agent, context_manager, input_provider, event_emitter, stop_checker, stop_requester):
        self.agent = agent
        self.context_manager = context_manager
        self.input_provider = input_provider
        self._emit_event = event_emitter
        self._check_stop = stop_checker
        self._request_stop = stop_requester

    def run_rfi_phase(self, initial_goal: str) -> str:
        """RFI/RFP Phase: Clarify requirements with user."""
        current_goal = initial_goal
        history: List[Dict[str, str]] = []
        logger.info("[RFI] input_provider=%s", getattr(self.input_provider, "__name__", type(self.input_provider)))
        
        while True:
            if self._check_stop():
                return current_goal
                
            self._emit_event("message", {"content": "🧠 목표를 분석 중입니다... (잠시만 기다려주세요)"})
            t0 = time.monotonic()
            
            clarity = self.agent.clarify_goal(current_goal, history)
            elapsed_sec = round(time.monotonic() - t0, 3)
            logger.info(f"[DAACS RFI/RFP Analyst] {clarity.get('question')}")
            
            self._emit_event("RFI_QUESTION", {
                "question": clarity.get('question'), 
                "goal": current_goal, 
                "elapsed_sec": elapsed_sec,
                "options": ["go", "skip"] 
            })
            
            user_input = self.input_provider("답변 (빌드 시작: 'go', 자동 스펙: 엔터 두번, 건너뛰기: 'skip'): ")
            logger.info("[RFI] user_input=%r", user_input)
            
            if self._check_stop():
                return current_goal
                
            if user_input.lower() in ["stop", "cancel", "abort", "quit", "exit"]:
                self._request_stop("user")
                return current_goal
            
            # Flexible intent matching for "go"
            normalized_input = user_input.lower().strip()
            go_keywords = ['go', 'run', 'build', 'start', '진행', '시작']
            
            # Check for exact match or trigger words within short sentences
            is_go_signal = False
            if normalized_input in go_keywords:
                is_go_signal = True
            elif len(normalized_input) < 15 and any(k in normalized_input for k in go_keywords):
                # e.g. "go 라고", "빨리 go", "빌드 시작해"
                is_go_signal = True
                
            if is_go_signal:
                logger.info("수집된 정보를 바탕으로 최종 RFP를 생성합니다 (Structured)...")
                self._emit_event("message", {"content": "🧾 최종 RFP를 정리 중입니다... (잠시만 기다려주세요)"})
                
                # Pass TechContext for improved traceability
                tc_dict = self.context_manager.get_context_dict()
                
                t0 = time.monotonic()
                rfp_json_str = self.agent.finalize_rfp(current_goal, tech_context=tc_dict)
                rfp_elapsed_sec = round(time.monotonic() - t0, 3)
                
                try:
                    rfp_data = json.loads(rfp_json_str)
                    clean_goal = rfp_data.get("goal", current_goal)
                    logger.info(f"Finalized RFP (Goal): {clean_goal}")
                    
                    self._emit_event("RFP_FINALIZED", {
                        "rfp": clean_goal, # legacy support
                        "structured_rfp": rfp_data, # Phase 2 support
                        "elapsed_sec": rfp_elapsed_sec,
                    })
                    logger.info(f"[최종 RFP 확정]\n{clean_goal}\n")
                    current_goal = clean_goal
                    
                except json.JSONDecodeError:
                    logger.warning("Failed to parse RFP JSON, using raw text.")
                    self._emit_event("RFP_FINALIZED", {"rfp": rfp_json_str, "elapsed_sec": rfp_elapsed_sec})
                    logger.info(f"[최종 RFP 확정]\n{rfp_json_str}\n")
                    current_goal = rfp_json_str
                    
                break
                
            if user_input.lower() == 'skip':
                logger.info("User skipped clarification.")
                break
                
            if not user_input:
                if clarity.get("clear"):
                    logger.info("Goal clear, waiting for user confirmation.")
                    continue

                logger.info("사용자 답변 없음. 분석가가 최적의 스펙을 구성합니다...")
                current_goal = self.agent.auto_complete_specs(current_goal)
                logger.info(f"[RFP 생성 완료] 구체화된 목표: {current_goal}")
                continue
                
            history.append({
                "question": clarity.get("question", ""),
                "answer": user_input,
            })
            current_goal = f"{current_goal} (추가 요구사항: {user_input})"
            logger.info(f"Goal refined: {current_goal}")
        
        return current_goal

    def infer_needs_from_actions(self, actions: List[Dict[str, Any]]) -> Dict[str, bool]:
        clients = {str(action.get("client") or "").lower() for action in actions}
        clients.discard("")
        needs_backend = "backend" in clients
        needs_frontend = "frontend" in clients
        if not needs_backend and not needs_frontend:
            return {"needs_backend": True, "needs_frontend": True}
        return {"needs_backend": needs_backend, "needs_frontend": needs_frontend}

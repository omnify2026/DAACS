
import sys
import os
import time
import json
import logging
from typing import Dict, List, Any, Optional
from dataclasses import asdict

from daacs.utils import setup_logger
from daacs.codex_client import FrontendClient, BackendClient
from daacs.orchestrator_agent import OrchestratorAgent
from daacs.config import DEFAULT_LLM_TIMEOUT_SEC, MAX_TURNS, MIN_CODE_REVIEW_SCORE, DEFAULT_VERIFICATION_LANE

from daacs.graph.config_loader import DAACSConfig as LangGraphConfig

# Sub-modules
from .context import ContextManager
from .planner import Planner
from .executor import Executor
from .verifier import Verifier

logger = setup_logger("Orchestrator")

def get_multiline_input(prompt: str) -> str:
    sys.stdout.write(prompt)
    sys.stdout.flush()
    lines = []
    while True:
        line = sys.stdin.readline()
        if not line or line == "\n":
            break
        lines.append(line.rstrip("\n"))
    return "\n".join(lines)

class DAACSOrchestrator:
    def __init__(
        self, 
        analyst_model: Optional[str] = None,
        frontend_model: Optional[str] = None,
        backend_model: Optional[str] = None,
        workdir: str = ".",
        log_dir: str = "logs", 
        max_failures: int = 10,
        max_no_progress: int = 2,
        max_turns: int = 10,
        code_review_min_score: int = MIN_CODE_REVIEW_SCORE,
        allow_low_quality_delivery: bool = False,
        plateau_max_retries: int = 3,
        event_callback: Optional[callable] = None,
        input_provider: Optional[callable] = None,
        mode: Optional[str] = None,
        parallel_execution: Optional[bool] = None,
        force_backend: Optional[bool] = None,
        enable_quality_gates: Optional[bool] = None,  # 🆕 UI에서 설정 가능
        verification_lane: Optional[str] = None,  # 🆕 fast/full lane
    ):
        # Mode Normalization
        mode_value = mode if mode is not None else os.getenv("DAACS_MODE", "langgraph")
        normalized_mode = (mode_value or "langgraph").lower()
        if normalized_mode == "prod":
            normalized_mode = "langgraph"
        self.mode = normalized_mode
        self.constraints_enabled = self.mode == "test"
        
        codex_timeout = DEFAULT_LLM_TIMEOUT_SEC
        self.global_config = LangGraphConfig.get_instance()
        role_cli_types = self.global_config.get_role_cli_types()
        frontend_provider = role_cli_types.get("frontend", "codex")
        backend_provider = role_cli_types.get("backend", "codex")
        self.clients = {
            "frontend": FrontendClient(
                timeout_sec=codex_timeout,
                model_name=frontend_model,
                cwd=workdir,
                provider=frontend_provider,
            ),
            "backend": BackendClient(
                timeout_sec=codex_timeout,
                model_name=backend_model,
                cwd=workdir,
                provider=backend_provider,
            ),
        }
        
        self.agent = OrchestratorAgent(model_name=analyst_model, mode=self.mode, workdir=workdir)
        self.history: List[Dict[str, Any]] = []
        
        # Configuration
        self.workdir = workdir
        self.log_dir = os.path.join(workdir, log_dir)
        self.max_failures = max_failures
        self.max_no_progress = max(1, int(max_no_progress or 2))
        self.max_turns = max_turns
        self.code_review_min_score = max(code_review_min_score, MIN_CODE_REVIEW_SCORE)
        self.allow_low_quality_delivery = False 
        self.plateau_max_retries = plateau_max_retries
        self.event_callback = event_callback
        self.input_provider = input_provider or get_multiline_input
        # 🆕 UI 설정 우선, 없으면 환경변수 폴백
        if enable_quality_gates is not None:
            self.enable_quality_gates = enable_quality_gates
        else:
            self.enable_quality_gates = os.getenv("DAACS_ENABLE_QUALITY_GATES", "false").lower() == "true"
        self.quality_inserted = False
        self.stop_requested = False
        self.stop_reason = ""
        self.prefer_patch = False
        self.patch_targets = []
        self.parallel_execution = parallel_execution
        self.force_backend = force_backend
        self.skip_rfi = False
        lane = (verification_lane or DEFAULT_VERIFICATION_LANE or "full").strip().lower()
        if lane not in {"fast", "full"}:
            lane = DEFAULT_VERIFICATION_LANE or "full"
        self.verification_lane = lane
        
        # LangGraph Model Names
        self.analyst_model = analyst_model
        self.frontend_model = frontend_model
        self.backend_model = backend_model
        
        # Initialize Sub-modules
        self.ctx_manager = ContextManager(self._emit_event)
        self.verifier = Verifier(self.agent)
        
        self.planner_module = Planner(
             agent=self.agent, 
             context_manager=self.ctx_manager, 
             input_provider=self.input_provider, 
             event_emitter=self._emit_event,
             stop_checker=lambda: self.stop_requested,
             stop_requester=self.request_stop
        )
        
        self.executor = Executor(
             agent=self.agent, 
             clients=self.clients, 
             event_emitter=self._emit_event,
             verifier=self.verifier
        )
        
        logger.info(f"Orchestrator initialized. Analyst={self.agent.model_name}, Frontend={frontend_model}, Backend={backend_model}")

    def _emit_event(self, event_type: str, data: Dict[str, Any]):
        if self.event_callback:
            try:
                self.event_callback(event_type, data)
            except Exception as e:
                logger.error(f"Event callback error: {e}")

    def request_stop(self, reason: str = "user"):
        self.stop_requested = True
        self.stop_reason = reason or "user"
        logger.info(f"Stop requested: {self.stop_reason}")

    def reset_for_run(self) -> None:
        self.stop_requested = False
        self.stop_reason = ""
        self.quality_inserted = False
        self.history = []

    def apply_assumption_delta(self, delta) -> Dict[str, Any]:
        return self.ctx_manager.apply_assumption_delta(delta)

    # Exposed for property access if needed, though mostly internal
    @property
    def tech_context(self):
        return self.ctx_manager.tech_context

    @property
    def assumptions(self):
        return self.ctx_manager.assumptions
    
    @property
    def last_rfi_result(self):
        return self.ctx_manager.last_rfi_result
        
    def _run_build_loop(
        self, 
        current_goal: str, 
        scenario_id: str, 
        scenario_type: str
    ) -> Dict[str, Any]:
        turn = 0
        consecutive_failures = 0
        stop_reason = ""

        if self.stop_requested:
            return {"goal": current_goal, "turns": turn, "stop_reason": self.stop_reason or "user_stop"}
        
        self._emit_event("BUILD_START", {"goal": current_goal})
        self._emit_event("message", {"content": "📋 실행 계획을 수립 중입니다... (잠시만 기다려주세요)"})
        t0 = time.monotonic()
        
        plan = self.agent.create_plan(current_goal, self.ctx_manager.tech_context)
        plan_elapsed_sec = round(time.monotonic() - t0, 3)
        actions = plan.get("actions", [])
        logger.info(f"Plan created with {len(actions)} actions")
        
        plan_needs = self.planner_module.infer_needs_from_actions(actions)
        self._emit_event("PLAN_CREATED", {
            "actions": actions,
            "elapsed_sec": plan_elapsed_sec,
            **plan_needs
        })
        
        while turn < self.max_turns:
            if self.stop_requested:
                stop_reason = self.stop_reason or "user_stop"
                break
            turn += 1
            logger.info(f"--- Turn {turn} ---")
            self._emit_event("TURN_START", {"turn": turn})
            
            # Get next action
            action = self.agent.get_next_instruction(plan)
            if not action:
                logger.info("No more actions to execute.")
                break
            
            # Execute
            t0 = time.monotonic()
            result = self.executor.execute_action(action)
            action_elapsed_sec = round(time.monotonic() - t0, 3)
            
            # Verify
            review = self.verifier.verify_action(action, result)
            self._emit_event("ACTION_DONE", {
                "turn": turn,
                "action": action,
                "client": action.get("client") or "frontend",
                "elapsed_sec": action_elapsed_sec,
                "result": result,
                "review": review,
            })
            
            # Record history
            self._record_history(turn, current_goal, scenario_id, scenario_type, 
                               stop_reason, consecutive_failures, action, result, review)
            self.agent.add_feedback(action, result, review)
            
            if review["success"]:
                consecutive_failures = 0
                is_complete, self.quality_inserted, plan = self.executor.handle_success(
                    action, plan, self.enable_quality_gates, self.quality_inserted
                )
                if is_complete:
                    logger.info("All actions completed! Goal achieved.")
                    break
            else:
                consecutive_failures += 1
                if consecutive_failures >= self.max_failures:
                    stop_reason = "orchestrator_consecutive_failures"
                    logger.warning("Stopping due to orchestrator consecutive failures threshold.")
                    break
                
                failure_result = self.executor.handle_failure(
                    action, result, review, plan, current_goal, turn, consecutive_failures
                )
                
                if failure_result["action"] == "stop":
                    stop_reason = failure_result.get("reason", "")
                    logger.warning(f"Stopping due to planner signal: {stop_reason}")
                    break
                elif failure_result["action"] == "replan":
                    current_goal = failure_result["new_goal"]
                    # Replan using agent directly as Executor doesn't have tech_context
                    plan = self.agent.create_plan(current_goal, self.ctx_manager.tech_context)
                    consecutive_failures = 0
                    logger.info(f"Replanning with new goal: {current_goal}")
                elif failure_result.get("new_goal"):
                    current_goal = failure_result["new_goal"]
        
        logger.info("DAACS Build Loop Finished.")
        return {"goal": current_goal, "turns": turn, "stop_reason": stop_reason}

    def _record_history(
        self, turn: int, goal: str, scenario_id: str, scenario_type: str,
        stop_reason: str, consecutive_failures: int, 
        action: Dict, result: str, review: Dict
    ):
        try:
            failed_verdicts = [v for v in review.get("verify", {}).get("verdicts", []) if not v.get("ok")]
            self.history.append({
                "turn": turn,
                "goal": goal,
                "mode": self.mode,
                "constraints_enabled": self.constraints_enabled,
                "scenario_id": scenario_id,
                "scenario_type": scenario_type,
                "stop_reason": stop_reason,
                "consecutive_failures": consecutive_failures,
                "last_failed_verdicts": failed_verdicts,
                "failure_type": self.verifier.classify_failure(result, failed_verdicts) if not review["success"] else "",
                "current_goal": goal,
                "action": action,
                "result": result,
                "review": review
            })
        except Exception as e:
            logger.warning(f"Failed to record history: {e}")

    def _run_feedback_loop(self, current_goal: str, build_result: Dict) -> Optional[str]:
        if self.stop_requested:
            return None
        history_summary = f"Goal: {current_goal}, Turns: {build_result['turns']}, Status: {build_result['stop_reason'] or 'Success'}"
        logger.info("[DAACS Build Completed]")
        logger.info(f"Status: {history_summary}")
        
        feedback = self.input_provider("\n피드백을 입력하세요 (완료하려면 엔터, 수정하려면 내용 입력): ").strip()
        if feedback.lower() in ["stop", "cancel", "abort", "quit", "exit"]:
            return None
        
        if not feedback:
            logger.info("작업을 완료합니다.")
            return None
        
        feedback_analysis = self.agent.analyze_feedback(feedback, history_summary)
        if feedback_analysis.get("action") == "refine":
            return feedback_analysis.get("new_goal", current_goal)
        
        logger.info("피드백 분석 결과 작업을 종료합니다.")
        return None

    def _save_history(self):
        try:
            os.makedirs(self.log_dir, exist_ok=True)
            log_path = os.path.join(self.log_dir, "turns.jsonl")
            with open(log_path, "a", encoding="utf-8") as f:
                for entry in self.history:
                    f.write(json.dumps(entry, ensure_ascii=False) + "\n")
            logger.info(f"History appended to {log_path}")
        except Exception as e:
            logger.error(f"Failed to write history log: {e}")

    # ==================== Main Entry Point ====================
    def _run_langgraph_engine(self, initial_state: Dict[str, Any]):
        logger.info(f"[Orchestrator] Switching to LangGraph Engine (Goal: {initial_state['current_goal']})")
        
        from daacs.config import SUPPORTED_MODELS
        
        def get_cli_type(model_name: str) -> str:
            if not model_name:
                return "codex"
            model_config = SUPPORTED_MODELS.get(model_name, {})
            return model_config.get("provider", "codex")

        def _safe_bool_env(key: str, default: bool) -> bool:
            raw = os.getenv(key)
            if raw is None:
                return default
            return raw.strip().lower() in ("1", "true", "yes", "y", "on")
        
        orchestrator_cli = get_cli_type(self.analyst_model)
        backend_cli = get_cli_type(self.backend_model)
        frontend_cli = get_cli_type(self.frontend_model)
        
        parallel_execution = self.parallel_execution
        if parallel_execution is None:
            parallel_execution = _safe_bool_env("DAACS_PARALLEL_EXECUTION", True)

        lg_config = LangGraphConfig(
            cli_type=orchestrator_cli,
            role_cli_types={
                "orchestrator": orchestrator_cli,
                "backend": backend_cli,
                "frontend": frontend_cli
            },
            parallel_execution=parallel_execution,
            max_iterations=self.max_turns,
            max_failures=self.max_failures,
            max_no_progress=self.max_no_progress,
            code_review_min_score=self.code_review_min_score,
            allow_low_quality_delivery=self.allow_low_quality_delivery,
            plateau_max_retries=self.plateau_max_retries,
            verification_lane=self.verification_lane,
        )
        
        def safe_emit(event, data):
             self._emit_event(event, data)

        from daacs.graph.daacs_workflow import create_daacs_workflow
        workflow = create_daacs_workflow(lg_config, event_callback=safe_emit)
        app = workflow.compile()
        
        recursion_limit = max(50, int(initial_state.get("max_failures", 5)) * 10)
        result = app.invoke(initial_state, {"recursion_limit": recursion_limit})
        
        logger.info(f"[Orchestrator] LangGraph Execution Complete. Final Status: {result.get('final_status')}")
        return result

    def run(self, initial_goal: str, scenario_id: Optional[str] = None, scenario_type: str = "default"):
        self.reset_for_run()
        logger.info(f"🚀 DAACS Started. Goal: {initial_goal}")
        scenario_id = scenario_id or str(int(time.time()))
        
        # 1. RFI Phase
        if self.skip_rfi:
            logger.info("[Orchestrator] Skipping RFI phase (skip_rfi=True)")
            final_goal = initial_goal
        else:
            final_goal = self.planner_module.run_rfi_phase(initial_goal)
        # self.current_goal is not used widely except in old code, but good to set if needed
        # self.current_goal = final_goal 
        
        if self.stop_requested:
            self._emit_event("BUILD_COMPLETE", {"goal": final_goal, "status": "stopped"})
            return {"final_status": "stopped"}
        
        # 2. Tech Context Enrichment
        self.ctx_manager.enrich_context(final_goal)

        # 3. Execution Phase
        if self.mode == "langgraph":
            logger.info(">>> Entering Hybrid Mode: Delegating execution to LangGraph <<<")
            if self.stop_requested:
                self._emit_event("BUILD_COMPLETE", {"goal": final_goal, "status": "stopped"})
                return {"final_status": "stopped"}
            
            tc_dict = self.ctx_manager.get_context_dict()
            assumptions_dict = self.ctx_manager.get_assumptions_dict()
            
            initial_state = {
                "current_goal": final_goal,
                "project_dir": self.workdir,
                "project_id": scenario_id,
                "tech_context": tc_dict,
                "assumptions": assumptions_dict,
                "orchestrator_model": self.analyst_model,
                "backend_model": self.backend_model,
                "frontend_model": self.frontend_model,
                "code_review_model": self.analyst_model,  # Use selected model, no fallback needed here
                "delivery_model": self.analyst_model,  # Use selected model, no fallback needed here
                "verification_lane": self.verification_lane,
                "needs_backend": True,
                "needs_frontend": True,
                "force_backend": bool(self.force_backend),
                "max_iterations": self.max_turns,
                "max_failures": self.max_failures,
                "code_review_min_score": self.code_review_min_score,
                "allow_low_quality_delivery": self.allow_low_quality_delivery,
                "plateau_max_retries": self.plateau_max_retries,
                "consecutive_failures": 0,
                "prefer_patch": self.prefer_patch,
                "patch_targets": self.patch_targets,
                "is_recovery_mode": False
            }
            
            self._emit_event("BUILD_START", {"goal": final_goal})
            try:
                result = self._run_langgraph_engine(initial_state)
            except Exception as e:
                self._emit_event("ERROR", {"message": f"Graph Execution Failed: {e}"})
                raise e
            
            self._emit_event("BUILD_COMPLETE", {"goal": final_goal, "status": result.get("final_status", "Completed")})
            return result
            
        else:
            # Legacy Mode
            logger.info(">>> Entering Legacy Mode: Internal Build Loop <<<")
            
            current_goal_loop = final_goal
            last_build_result = {}
            
            while True:
                self.quality_inserted = False
                
                build_result = self._run_build_loop(current_goal_loop, scenario_id, scenario_type)
                current_goal_loop = build_result["goal"]
                last_build_result = build_result
                
                new_goal = self._run_feedback_loop(current_goal_loop, build_result)
                if new_goal is None:
                    break
                current_goal_loop = new_goal
            
            self._emit_event("BUILD_COMPLETE", {"goal": current_goal_loop, "status": last_build_result.get("stop_reason") or "Success"})
            logger.info("DAACS Overall Process Finished.")
            self._save_history()
            return {"final_status": last_build_result.get("stop_reason") or "completed", "goal": current_goal_loop}

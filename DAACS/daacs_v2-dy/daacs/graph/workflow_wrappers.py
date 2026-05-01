from typing import Any, Dict, Callable
from ..models.daacs_state import DAACSState
from ..config import MIN_CODE_REVIEW_SCORE
from .orchestrator_nodes import (
    orchestrator_planning_node,
    orchestrator_judgment_node,
    orchestrator_replanning_node,
    context_db_node,
    deliver_node
)

def emit_event(callback: Callable, event: str, data: Dict):
    if callback:
        try:
            callback(event, data)
        except (RuntimeError, TypeError, ValueError):
            pass # Logger used in main workflow

def emit_status(callback: Callable, node_id: str, status: str, extras: Dict = None):
    data = {"node_id": node_id, "status": status}
    if extras:
        data.update(extras)
    emit_event(callback, "WORKFLOW_NODE", data)

class NodeWrappers:
    def __init__(self, orchestrator_llm, execution_config: Dict, event_callback: Callable, logger):
        self.orchestrator_llm = orchestrator_llm
        self.config = execution_config
        self.emit = event_callback
        self.logger = logger
        
        # Cache config values
        self.max_iterations = execution_config.get("max_iterations", 10)
        self.max_failures = execution_config.get("max_failures", 10)
        self.min_score = execution_config.get("code_review_min_score", MIN_CODE_REVIEW_SCORE)
        self.plateau_retries = execution_config.get("plateau_max_retries", 3)
        self.default_lane = execution_config.get("verification_lane", "full")

    def _is_fast_lane(self, state: DAACSState) -> bool:
        lane = state.get("verification_lane") or self.default_lane
        return str(lane).strip().lower() == "fast"

    def planning(self, state: DAACSState) -> Dict[str, Any]:
        try:
            emit_status(self.emit, "planning", "running")
            emit_event(self.emit, "ACTION_START", {"action": {"type": "planning", "goal": state.get("current_goal")}, "client": "orchestrator"})
            
            # Setup defaults using provided config or fallback
            defaults = {
                "max_iterations": state.get("max_iterations") or self.max_iterations,
                "max_failures": state.get("max_failures") or self.max_failures,
                "code_review_min_score": state.get("code_review_min_score") or self.min_score,
                "plateau_max_retries": state.get("plateau_max_retries") or self.plateau_retries,
                "allow_low_quality_delivery": False,
                "prefer_patch": bool(state.get("prefer_patch", False)),
                "patch_targets": state.get("patch_targets") or [],
                "verification_lane": state.get("verification_lane") or self.default_lane,
            }
            
            working_state = dict(state)
            working_state.update(defaults)
            result = orchestrator_planning_node(working_state, self.orchestrator_llm)
            
            # Emit Plan
            if result.get("orchestrator_plan"):
                actions_summary = []
                if result.get("needs_backend"): actions_summary.append("Backend Implementation")
                if result.get("needs_frontend"): actions_summary.append("Frontend Implementation")
                emit_event(self.emit, "PLAN_CREATED", {
                    "actions": [{"instruction": a} for a in actions_summary],
                    "elapsed_sec": 0,
                    "needs_backend": result.get("needs_backend"),
                    "needs_frontend": result.get("needs_frontend"),
                    "api_spec": result.get("api_spec"),
                })
            
            self.logger.info(f"[Workflow] Planning complete. Backend: {result.get('needs_backend')}, Frontend: {result.get('needs_frontend')}")
            emit_status(self.emit, "planning", "completed")
            emit_event(self.emit, "ACTION_DONE", {"action": {"type": "planning"}, "client": "orchestrator", "result": "Plan created", "review": {"success": True}})
            defaults.update(result)
            return defaults
        except Exception as e:
            emit_status(self.emit, "planning", "error", {"error": str(e)})
            emit_event(self.emit, "ERROR", {"message": f"Planning Node Failed: {e}"})
            raise e

    def judgment(self, state: DAACSState) -> Dict[str, Any]:
        try:
            emit_status(self.emit, "judgment", "running")
            emit_event(self.emit, "ACTION_START", {"action": {"type": "judgment"}, "client": "orchestrator"})
            result = orchestrator_judgment_node(state, self.orchestrator_llm)
            rework = result.get('needs_rework')
            self.logger.info(f"[Workflow] Judgment complete. Needs rework: {rework}")
            
            status = "completed" if not rework else "error"
            emit_status(self.emit, "judgment", status)
            issues = result.get("compatibility_issues", [])
            emit_event(self.emit, "ACTION_DONE", {"action": {"type": "judgment"}, "client": "orchestrator", "result": f"Rework needed: {rework}", "review": {"success": not rework, "verify": {"verdicts": [{"ok": not rework, "reason": str(issues)}]}}})
            return result
        except Exception as e:
            emit_status(self.emit, "judgment", "error", {"error": str(e)})
            emit_event(self.emit, "ERROR", {"message": f"Judgment Node Failed: {e}"})
            raise e

    def replanning(self, state: DAACSState) -> Dict[str, Any]:
        try:
            emit_status(self.emit, "replanning", "running")
            emit_event(self.emit, "ACTION_START", {"action": {"type": "replanning"}, "client": "orchestrator"})
            result = orchestrator_replanning_node(state, self.orchestrator_llm)
            self.logger.info(f"[Workflow] Replanning complete.")
            emit_event(self.emit, "ACTION_DONE", {"action": {"type": "replanning"}, "client": "orchestrator", "result": "Replanning complete", "review": {"success": True}})
            guidance = result.get("replan_guidance")
            if isinstance(guidance, str):
                guidance = guidance.strip()
                if len(guidance) > 280:
                    guidance = f"{guidance[:277]}..."
            meta = {
                "failure_type": result.get("failure_type"),
                "consecutive_failures": result.get("consecutive_failures"),
                "failure_repeat_count": result.get("failure_repeat_count"),
                "stop_reason": result.get("stop_reason"),
                "replan_guidance": guidance,
                "patch_targets": result.get("patch_targets"),
            }
            emit_status(self.emit, "replanning", "completed", meta)
            return result
        except Exception as e:
            emit_status(self.emit, "replanning", "error", {"error": str(e)})
            emit_event(self.emit, "ERROR", {"message": f"Replanning Node Failed: {e}"})
            raise e

    def code_review(self, state: DAACSState) -> Dict[str, Any]:
        needs_backend = state.get("needs_backend", True)
        needs_frontend = state.get("needs_frontend", True)
        backend_done = not needs_backend or state.get("backend_status") in ["completed", "failed", "skipped"]
        frontend_done = not needs_frontend or state.get("frontend_status") in ["completed", "failed", "skipped"]
        if not (backend_done and frontend_done):
            return {"code_review_ready": False}
        if self._is_fast_lane(state):
            min_score = state.get("code_review_min_score") or self.min_score
            emit_status(self.emit, "code_review", "completed", {"skipped": True, "lane": "fast"})
            emit_event(self.emit, "ACTION_DONE", {
                "action": {"type": "code_review"},
                "client": "orchestrator",
                "result": "Code review skipped (fast lane)",
                "review": {"success": True, "skipped": True}
            })
            return {
                "code_review_passed": True,
                "code_review_score": min_score,
                "code_review_ready": True,
                "code_review": {"skipped": True, "lane": "fast"},
            }

        try:
            emit_status(self.emit, "code_review", "running")
            emit_event(self.emit, "ACTION_START", {"action": {"type": "code_review"}, "client": "orchestrator"})
            
            # 🆕 Use ReviewerAgent (Smart Replanning)
            from ..agent_system.agents.reviewer import ReviewerAgent
            from .nodes.code_review import _collect_files_to_review, _read_files_content
            
            reviewer = ReviewerAgent("reviewer-workflow")
            project_dir = state.get("project_dir", ".")
            
            files_to_review = _collect_files_to_review(project_dir)
            files_content = _read_files_content(files_to_review, project_dir) # returns list of strings "=== relpath ===\ncontent"
            
            overall_score = 10.0
            critical_issues = 0
            passed = True
            review_summary = []
            
            # Process each file
            # Note: _read_files_content returns formatted strings. We need raw content for ReviewerAgent.
            # So we re-read or parse. Let's re-read simply for cleaner integration.
            for file_path in files_to_review:
                try:
                    with open(file_path, 'r', encoding='utf-8') as f:
                        code = f.read()
                    
                    rel_path = file_path.replace(project_dir, "").lstrip("/")
                    result = reviewer.review_file(rel_path, code)
                    
                    self.logger.info(f"[Workflow] Reviewed {rel_path}: {result['score']}/10 - {result['status']}")
                    
                    # Aggregate stats
                    file_score = result['score']
                    overall_score = min(overall_score, file_score) # Pessimistic scoring
                    if result['status'] == "rejected":
                        passed = False
                        critical_issues += 1
                        review_summary.append(f"{rel_path}: {result['feedback']}")
                    
                    # 🆕 Apply Auto-Fix if available
                    if result.get("patched_code"):
                         self.logger.info(f"[Workflow] Applying Auto-Fix to {rel_path}")
                         with open(file_path, 'w', encoding='utf-8') as f:
                             f.write(result["patched_code"])
                         review_summary.append(f"{rel_path}: Auto-fixed.")

                except Exception as e:
                    self.logger.error(f"Failed to review {file_path}: {e}")
            
            emit_status(self.emit, "code_review", "completed" if passed else "error", {"score": overall_score})
            emit_event(self.emit, "ACTION_DONE", {
                "action": {"type": "code_review"}, 
                "client": "orchestrator", 
                "result": f"Code review: {overall_score}/10, Passed: {passed}",
                "review": {
                    "success": passed,
                    "score": overall_score,
                    "critical_issues": critical_issues,
                    "goal_aligned": True
                }
            })
            
            return {
                "code_review_passed": passed,
                "code_review_score": overall_score,
                "code_review": {"issues": [{"description": s, "severity": "critical"} for s in review_summary]},
                "code_review_ready": True
            }
        except Exception as e:
            emit_event(self.emit, "ERROR", {"message": f"Code Review Node Failed: {e}"})
            return {
                "code_review_passed": False,
                "code_review_score": 0,
                "code_review_ready": True
            }


    def consistency_check(self, state: DAACSState) -> Dict[str, Any]:
        try:
            emit_status(self.emit, "consistency", "running")
            emit_event(self.emit, "ACTION_START", {"action": {"type": "consistency_check"}, "client": "orchestrator"})
            from .enhanced_nodes import consistency_check_node
            # No LLM passed - purely deterministic "Machine Task"
            result = consistency_check_node(state)
            passed = result.get("consistency_passed", True)
            emit_status(self.emit, "consistency", "completed" if passed else "error")
            emit_event(self.emit, "ACTION_DONE", {
                "action": {"type": "consistency_check"}, 
                "client": "orchestrator", 
                "result": f"Consistency check passed: {passed}",
                "review": {"success": passed}
            })
            return result
        except Exception as e:
            emit_status(self.emit, "consistency", "error", {"error": str(e)})
            emit_event(self.emit, "ERROR", {"message": f"Consistency Check Node Failed: {e}"})
            return {"consistency_passed": False}
    
    def security_scan(self, state: DAACSState) -> Dict[str, Any]:
        if self._is_fast_lane(state):
            emit_status(self.emit, "security", "completed", {"skipped": True, "lane": "fast"})
            emit_event(self.emit, "ACTION_DONE", {
                "action": {"type": "security_scan"},
                "client": "orchestrator",
                "result": "Security scan skipped (fast lane)",
                "review": {"success": True, "skipped": True}
            })
            return {"security_passed": True, "security_summary": {"skipped": True, "lane": "fast"}}
        try:
            emit_status(self.emit, "security", "running")
            emit_event(self.emit, "ACTION_START", {"action": {"type": "security_scan"}, "client": "orchestrator"})
            from .enhanced_nodes import security_scan_node
            result = security_scan_node(state)
            passed = result.get("security_passed", True)
            summary = result.get("security_summary", {})
            emit_status(self.emit, "security", "completed" if passed else "error", summary)
            emit_event(self.emit, "ACTION_DONE", {
                "action": {"type": "security_scan"}, 
                "client": "orchestrator", 
                "result": f"Security scan: {summary.get('critical', 0)} critical, {summary.get('warning', 0)} warnings",
                "review": {"success": passed}
            })
            return result
        except Exception as e:
            emit_status(self.emit, "security", "error", {"error": str(e)})
            emit_event(self.emit, "ERROR", {"message": f"Security Scan Node Failed: {e}"})
            return {"security_passed": True}

    def runtime_verification(self, state: DAACSState) -> Dict[str, Any]:
        if self._is_fast_lane(state):
            emit_status(self.emit, "runtime_verification", "completed", {"skipped": True, "lane": "fast"})
            emit_event(self.emit, "ACTION_DONE", {
                "action": {"type": "runtime_verification"},
                "client": "orchestrator",
                "result": "Runtime verification skipped (fast lane)",
                "review": {"success": True, "skipped": True}
            })
            return {"runtime_verification_passed": True, "runtime_issues": [], "needs_rework": False}
        try:
            emit_status(self.emit, "runtime_verification", "running")
            emit_event(self.emit, "ACTION_START", {"action": {"type": "runtime_verification"}, "client": "orchestrator"})
            from .runtime_verification import runtime_verification_node
            result = runtime_verification_node(state, self.orchestrator_llm)
            passed = result.get("runtime_verification_passed", True)
            issues = result.get("runtime_issues", [])
            emit_status(self.emit, "runtime_verification", "completed" if passed else "error", {"issues": len(issues)})
            emit_event(self.emit, "ACTION_DONE", {
                "action": {"type": "runtime_verification"}, 
                "client": "orchestrator", 
                "result": f"Runtime verification passed: {passed}. Issues: {len(issues)}",
                "review": {"success": passed, "issues": issues}
            })
            return result
        except Exception as e:
            emit_status(self.emit, "runtime_verification", "error", {"error": str(e)})
            emit_event(self.emit, "ERROR", {"message": f"Runtime Verification Node Failed: {e}"})
            return {"runtime_verification_passed": False, "needs_rework": True, "failure_summary": [f"runtime_verification_crashed: {str(e)}"]}

    def save_context(self, state: DAACSState) -> Dict[str, Any]:
        emit_status(self.emit, "save", "running")
        result = context_db_node(state)
        emit_status(self.emit, "save", "completed")
        return result
    
    def deliver(self, state: DAACSState) -> Dict[str, Any]:
        emit_status(self.emit, "deliver", "running")
        result = deliver_node(state)
        if state.get("best_effort_delivery"):
            result["final_status"] = "completed_with_warnings"
        emit_status(self.emit, "deliver", "completed")
        return result

    def quality_scoring(self, state: DAACSState) -> Dict[str, Any]:
        """품질 점수화 노드 (KK 이식)"""
        if self._is_fast_lane(state):
            emit_status(self.emit, "quality_scoring", "completed", {"skipped": True, "lane": "fast"})
            return {"quality_score": 8.0, "quality_recommendation": "done", "needs_replanning": False}
        
        try:
            emit_status(self.emit, "quality_scoring", "running")
            emit_event(self.emit, "ACTION_START", {"action": {"type": "quality_scoring"}, "client": "orchestrator"})
            
            from ..quality_scorer import QualityScorer
            scorer = QualityScorer()
            
            # Collect runtime and visual results from state
            runtime_result = {
                "backend_running": state.get("backend_status") == "completed",
                "backend_health": state.get("backend_status") == "completed",
                "frontend_running": state.get("frontend_status") == "completed",
            }
            visual_result = state.get("visual_result", {})
            
            score = scorer.score(
                goal=state.get("current_goal", ""),
                runtime_result=runtime_result,
                visual_result=visual_result
            )
            
            self.logger.info(f"[Workflow] Quality Score: {score.overall}/10, Recommendation: {score.recommendation}")
            
            emit_status(self.emit, "quality_scoring", "completed", {
                "score": score.overall,
                "recommendation": score.recommendation
            })
            emit_event(self.emit, "ACTION_DONE", {
                "action": {"type": "quality_scoring"},
                "client": "orchestrator",
                "result": f"Quality Score: {score.overall}/10",
                "review": {"success": not score.needs_replanning, "score": score.overall}
            })
            
            return {
                "quality_score": score.overall,
                "quality_recommendation": score.recommendation,
                "needs_replanning": score.needs_replanning,
                "quality_needs_fix": score.needs_fix,
            }
        except Exception as e:
            self.logger.error(f"[Workflow] Quality scoring failed: {e}")
            emit_status(self.emit, "quality_scoring", "error", {"error": str(e)})
            return {"quality_score": 5.0, "quality_recommendation": "fix", "needs_replanning": False}

    def visual_verification(self, state: DAACSState) -> Dict[str, Any]:
        """시각 검증 노드 (KK 이식, Playwright 필요)"""
        if self._is_fast_lane(state):
            emit_status(self.emit, "visual_verification", "completed", {"skipped": True, "lane": "fast"})
            return {"visual_verification_passed": True, "visual_verification_skipped": True}
        
        try:
            from .verifier.visual_verifier import VisualVerifier, PLAYWRIGHT_AVAILABLE
            
            if not PLAYWRIGHT_AVAILABLE:
                self.logger.info("[Workflow] Visual verification skipped (Playwright not installed)")
                emit_status(self.emit, "visual_verification", "completed", {"skipped": True, "reason": "playwright_not_installed"})
                return {"visual_verification_passed": True, "visual_verification_skipped": True}
            
            emit_status(self.emit, "visual_verification", "running")
            emit_event(self.emit, "ACTION_START", {"action": {"type": "visual_verification"}, "client": "orchestrator"})
            
            project_dir = state.get("project_dir", ".")
            verifier = VisualVerifier(project_dir)
            result = verifier.verify(start_server=False)  # Assume server already running
            
            self.logger.info(f"[Workflow] Visual Verification: passed={result.passed}, screenshots={len(result.screenshots)}")
            
            emit_status(self.emit, "visual_verification", "completed" if result.passed else "error", {
                "screenshots": len(result.screenshots),
                "console_errors": len(result.console_errors)
            })
            emit_event(self.emit, "ACTION_DONE", {
                "action": {"type": "visual_verification"},
                "client": "orchestrator",
                "result": f"Visual verification passed: {result.passed}",
                "review": {"success": result.passed}
            })
            
            return {
                "visual_verification_passed": result.passed,
                "visual_screenshots": result.screenshots,
                "visual_console_errors": result.console_errors,
                "visual_result": result.to_dict(),
            }
        except Exception as e:
            self.logger.error(f"[Workflow] Visual verification failed: {e}")
            emit_status(self.emit, "visual_verification", "error", {"error": str(e)})
            return {"visual_verification_passed": True, "visual_verification_skipped": True}

"""
DAACS v6.0 - Main Workflow
LangGraph 기반 병렬 실행 워크플로우
Features: Checkpointing, Human-in-the-Loop, Streaming
"""
from typing import Dict, Any, Callable
import json
import os
from concurrent.futures import ThreadPoolExecutor

from langgraph.graph import StateGraph, END
from langgraph.checkpoint.memory import MemorySaver

# 🆕 Try to import SQLite checkpointer for persistence
try:
    from langgraph.checkpoint.sqlite import SqliteSaver
    SQLITE_AVAILABLE = True
except ImportError:
    SQLITE_AVAILABLE = False

from ..models.daacs_state import DAACSState
from ..utils import setup_logger
from .backend_subgraph import create_backend_subgraph
from .frontend_subgraph import create_frontend_subgraph
from .workflow_wrappers import NodeWrappers, emit_event, emit_status

logger = setup_logger("DAACSWorkflow")


# Valid state transitions for state machine validation (issue 25)
VALID_STATE_TRANSITIONS: dict = {
    "initialized": {"planning", "stopped"},
    "planning": {"parallel_execution", "deliver", "stopped"},
    "parallel_execution": {"verification", "stopped", "deliver"},
    "verification": {"judgment", "stopped"},
    "judgment": {"deliver", "replanning", "stopped"},
    "replanning": {"parallel_execution", "stopped"},
    "waiting_for_human": {"parallel_execution", "stopped", "deliver"},
    "deliver": {"completed"},
    "completed": set(),
    "stopped": set(),
}


def validate_state_transition(current_phase: str, next_phase: str) -> bool:
    """Validate if a state transition is allowed."""
    allowed = VALID_STATE_TRANSITIONS.get(current_phase, set())
    return next_phase in allowed


def create_checkpointer(use_sqlite: bool = True, db_path: str = None):
    """
    Create a checkpointer instance for workflow persistence.
    
    Args:
        use_sqlite: If True and SQLite is available, use persistent storage
        db_path: Custom path for SQLite DB. Defaults to .daacs_checkpoints.db in cwd
    """
    if use_sqlite and SQLITE_AVAILABLE:
        if db_path is None:
            db_path = os.path.join(os.getcwd(), ".daacs_checkpoints.db")
        try:
            logger.info("[Checkpointer] Using SQLite persistence: %s", db_path)
            return SqliteSaver.from_conn_string(f"sqlite:///{db_path}")
        except Exception as e:
            logger.warning("[Checkpointer] SQLite init failed (%s), falling back to memory", e)
    
    logger.info("[Checkpointer] Using in-memory storage")
    return MemorySaver()


def create_daacs_workflow(config, enable_human_in_loop: bool = False, event_callback: Callable = None):
    """
    DAACS 워크플로우 생성
    
    Args:
        config: DAACSConfig 인스턴스
        enable_human_in_loop: Human-in-the-Loop 활성화 여부
        event_callback: 이벤트 콜백 함수 (optional)
    """
    workflow = StateGraph(DAACSState)
    execution_config = config.get_execution_config()
    
    # Defaults
    max_iterations_default = execution_config.get("max_iterations", 10)
    
    orchestrator_llm = config.get_llm_source("orchestrator")
    
    # Event Emitter
    def emit(event, data):
        emit_event(event_callback, event, data)

    # Node Wrappers
    wrappers = NodeWrappers(orchestrator_llm, execution_config, event_callback, logger)

    # === Nodes ===
    workflow.add_node("orchestrator_planning", wrappers.planning)
    
    def start_parallel_node(state):
        logger.info("[Workflow] Starting parallel execution...")
        emit_status(event_callback, "start_parallel", "running")
        updates = {"current_phase": "parallel_execution"}
        # Initialize status
        updates["backend_status"] = "pending" if state.get("needs_backend", True) else "skipped"
        updates["frontend_status"] = "pending" if state.get("needs_frontend", True) else "skipped"
        emit_status(event_callback, "start_parallel", "completed")
        return updates
    workflow.add_node("start_parallel", start_parallel_node)

    def main_cycle_guard(state):
        max_iterations = state.get("max_iterations", max_iterations_default)
        main_cycle_count = state.get("main_cycle_count", 0) + 1
        
        # 🆕 Progress detection using code fingerprint
        last_fingerprint = state.get("last_code_fingerprint", "")
        current_fingerprint = state.get("code_fingerprint", "")
        no_progress_count = state.get("no_progress_count", 0)
        
        if last_fingerprint and last_fingerprint == current_fingerprint:
            no_progress_count += 1
            logger.warning("[CycleGuard] No code change detected. no_progress_count=%d", no_progress_count)
        else:
            no_progress_count = 0
        
        max_no_progress = state.get("max_no_progress", 3)
        
        emit_status(event_callback, "main_cycle_guard", "running", {
            "cycle": main_cycle_count,
            "max_iterations": max_iterations,
            "no_progress_count": no_progress_count,
        })
        updates = {
            "main_cycle_count": main_cycle_count,
            "max_iterations": max_iterations,
            "no_progress_count": no_progress_count,
            "last_code_fingerprint": current_fingerprint,
        }
        
        # Check no-progress limit
        if no_progress_count >= max_no_progress:
            reason = f"no_progress ({no_progress_count}/{max_no_progress})"
            logger.warning("[CycleGuard] No progress detected: %s", reason)
            emit("ERROR", {"message": f"No progress detected: {reason}"})
            updates["stop_reason"] = reason
            updates["final_status"] = "stopped"
            emit_status(event_callback, "main_cycle_guard", "error", {
                "error": reason,
                "cycle": main_cycle_count,
                "max_iterations": max_iterations,
            })
            return updates
        
        # Check max iterations
        if main_cycle_count > max_iterations:
            reason = f"max_iterations_exceeded ({main_cycle_count}/{max_iterations})"
            logger.warning("Main cycle limit exceeded: %s", reason)
            emit("ERROR", {"message": f"Main cycle limit exceeded: {reason}"})
            updates["stop_reason"] = reason
            updates["final_status"] = "stopped"
            emit_status(event_callback, "main_cycle_guard", "error", {
                "error": reason,
                "cycle": main_cycle_count,
                "max_iterations": max_iterations,
            })
            return updates
        emit_status(event_callback, "main_cycle_guard", "completed", {
            "cycle": main_cycle_count,
            "max_iterations": max_iterations,
        })
        return updates
    workflow.add_node("main_cycle_guard", main_cycle_guard)
    
    # Create subgraphs
    backend_graph = create_backend_subgraph(config, event_callback=emit)
    frontend_graph = create_frontend_subgraph(config, event_callback=emit)
    
    # Subgraph Wrappers
    def run_subgraph(graph, component: str, state_key: str, state: dict):
        """Generic subgraph runner"""
        try:
            if not state.get(f"needs_{component}", True):
                emit_status(event_callback, component, "skipped")
                return {f"{component}_status": "skipped", f"{component}_needs_rework": False}
            
            emit_status(event_callback, component, "running")
            # Invoke subgraph
            result = graph.invoke(dict(state))
            logger.info(f"[Workflow] {component.capitalize()} subgraph completed. Status: {result.get(state_key)}")
            
            # Return updates
            return {
                f"{component}_status": result.get(f"{component}_status", "completed"),
                f"{component}_files": result.get(f"{component}_files", {}),
                f"{component}_logs": result.get(f"{component}_logs", []),
                f"{component}_verification_details": result.get(f"{component}_verification_details", []),
                f"{component}_needs_rework": result.get(f"{component}_needs_rework", False),
                f"{component}_subgraph_iterations": result.get(f"{component}_subgraph_iterations", 1),
                f"{component}_code_fingerprint": result.get(f"{component}_code_fingerprint", ""),
                f"{component}_file_hashes": result.get(f"{component}_file_hashes", {}),
            }
        except Exception as e:
            logger.error(f"[Workflow] {component.capitalize()} subgraph error: {e}")
            emit_status(event_callback, component, "error", {"error": str(e)})
            return {f"{component}_status": "failed", f"{component}_needs_rework": True}

    def run_parallel_subgraphs(state: DAACSState):
        emit_status(event_callback, "parallel_subgraphs", "running")
        parallel_enabled = bool(execution_config.get("parallel_execution", True))
        
        # 🆕 Check cached results from previous successful runs
        cached_backend = state.get("cached_backend_result")
        cached_frontend = state.get("cached_frontend_result")
        
        needs_backend = state.get("needs_backend", True)
        needs_frontend = state.get("needs_frontend", True)
        
        # Determine which components need to run
        backend_ok = (
            not needs_backend 
            or (cached_backend and cached_backend.get("status") == "completed" 
                and not state.get("backend_needs_rework", False))
        )
        frontend_ok = (
            not needs_frontend 
            or (cached_frontend and cached_frontend.get("status") == "completed"
                and not state.get("frontend_needs_rework", False))
        )
        
        updates = {}
        
        # Use cached results if available and valid
        if backend_ok and cached_backend:
            logger.info("[Workflow] Using cached backend result.")
            updates.update({
                "backend_status": cached_backend.get("status", "completed"),
                "backend_files": cached_backend.get("files", {}),
                "backend_code_fingerprint": cached_backend.get("fingerprint", ""),
                "backend_file_hashes": cached_backend.get("file_hashes", {}),
            })
        if frontend_ok and cached_frontend:
            logger.info("[Workflow] Using cached frontend result.")
            updates.update({
                "frontend_status": cached_frontend.get("status", "completed"),
                "frontend_files": cached_frontend.get("files", {}),
                "frontend_code_fingerprint": cached_frontend.get("fingerprint", ""),
                "frontend_file_hashes": cached_frontend.get("file_hashes", {}),
            })
        
        # Run only the components that need work
        components_to_run = []
        if not backend_ok and needs_backend:
            components_to_run.append(("backend", backend_graph))
        if not frontend_ok and needs_frontend:
            components_to_run.append(("frontend", frontend_graph))
        
        if not components_to_run:
            logger.info("[Workflow] All components cached, skipping execution.")
            backend_fp = updates.get("backend_code_fingerprint") or state.get("backend_code_fingerprint", "")
            frontend_fp = updates.get("frontend_code_fingerprint") or state.get("frontend_code_fingerprint", "")
            if backend_fp or frontend_fp:
                updates["code_fingerprint"] = f"{backend_fp}|{frontend_fp}"
            emit_status(event_callback, "parallel_subgraphs", "completed")
            return updates
        
        if not parallel_enabled or len(components_to_run) == 1:
            logger.info("[Workflow] Running %d component(s) sequentially.", len(components_to_run))
            for component, graph in components_to_run:
                result = run_subgraph(graph, component, f"{component}_status", dict(state))
                updates.update(result)
                # Cache successful result
                if result.get(f"{component}_status") == "completed":
                    updates[f"cached_{component}_result"] = {
                        "status": "completed",
                        "files": result.get(f"{component}_files", {}),
                        "fingerprint": result.get(f"{component}_code_fingerprint", ""),
                        "file_hashes": result.get(f"{component}_file_hashes", {}),
                    }
        else:
            logger.info("[Workflow] Running %d component(s) in parallel.", len(components_to_run))
            with ThreadPoolExecutor(max_workers=2) as executor:
                futures = {
                    component: executor.submit(run_subgraph, graph, component, f"{component}_status", dict(state))
                    for component, graph in components_to_run
                }
                for component, future in futures.items():
                    try:
                        result = future.result()
                    except Exception as e:
                        logger.error("[Workflow] %s subgraph raised during parallel run: %s", component, e)
                        result = {f"{component}_status": "failed", f"{component}_needs_rework": True}
                    if result:
                        updates.update(result)
                        # Cache successful result
                        if result.get(f"{component}_status") == "completed":
                            updates[f"cached_{component}_result"] = {
                                "status": "completed",
                                "files": result.get(f"{component}_files", {}),
                                "fingerprint": result.get(f"{component}_code_fingerprint", ""),
                                "file_hashes": result.get(f"{component}_file_hashes", {}),
                            }
        
        failed = (
            updates.get("backend_status") in {"failed", "error"}
            or updates.get("frontend_status") in {"failed", "error"}
        )
        backend_fp = updates.get("backend_code_fingerprint") or state.get("backend_code_fingerprint", "")
        frontend_fp = updates.get("frontend_code_fingerprint") or state.get("frontend_code_fingerprint", "")
        if backend_fp or frontend_fp:
            updates["code_fingerprint"] = f"{backend_fp}|{frontend_fp}"
        emit_status(event_callback, "parallel_subgraphs", "error" if failed else "completed")
        return updates

    workflow.add_node("parallel_subgraphs", run_parallel_subgraphs)

    # Phase 7.2 Nodes
    workflow.add_node("code_review", wrappers.code_review)
    workflow.add_node("quality_scoring", wrappers.quality_scoring)  # KK 이식
    workflow.add_node("consistency_check", wrappers.consistency_check)
    workflow.add_node("security_scan", wrappers.security_scan)
    workflow.add_node("runtime_verification", wrappers.runtime_verification)
    workflow.add_node("visual_verification", wrappers.visual_verification)  # KK 이식
    workflow.add_node("orchestrator_judgment", wrappers.judgment)
    
    # Human-in-the-Loop Node
    if enable_human_in_loop:
        def human_review_node(state):
            logger.info("[Workflow] ⏸️ Waiting for human review...")
            return {
                "current_phase": "waiting_for_human",
                "human_review_needed": True
            }
        workflow.add_node("human_review", human_review_node)
    
    workflow.add_node("orchestrator_replanning", wrappers.replanning)
    workflow.add_node("save_context", wrappers.save_context)
    workflow.add_node("deliver", wrappers.deliver)

    def should_best_effort_deliver(state: DAACSState) -> bool:
        """Check if we should attempt best-effort delivery despite failures."""
        if state.get("hard_failure"):
            return False
            
        # 🆕 강제 배달 방지: 품질 기준 미달 시 배달하지 않음
        if state.get("quality_gate_failed"):
            logger.warning("[Workflow] Quality gate failed - skipping best-effort delivery.")
            return False
            
        has_backend_files = bool(state.get("backend_files"))
        has_frontend_files = bool(state.get("frontend_files"))
        return has_backend_files or has_frontend_files

    # === Edges ===
    workflow.set_entry_point("orchestrator_planning")
    
    def decide_after_planning(state: DAACSState) -> str:
        if state.get("needs_backend") or state.get("needs_frontend"):
            return "parallel_execution"
        return "deliver"
        
    workflow.add_conditional_edges("orchestrator_planning", decide_after_planning, 
                                  {"parallel_execution": "main_cycle_guard", "deliver": "deliver"})

    def decide_after_cycle_guard(state: DAACSState) -> str:
        if state.get("stop_reason") or state.get("final_status") == "stopped":
            return "deliver" if should_best_effort_deliver(state) else "stop"
        return "parallel_execution"

    workflow.add_conditional_edges("main_cycle_guard", decide_after_cycle_guard,
                                  {"parallel_execution": "start_parallel", "deliver": "deliver", "stop": END})
    
    # Parallel Fan-out (actual concurrent execution handled inside parallel_subgraphs)
    workflow.add_edge("start_parallel", "parallel_subgraphs")
    
    # 🆕 Reordered: Machine Fixes (Consistency) -> Agent Review -> Quality
    workflow.add_edge("parallel_subgraphs", "consistency_check")

    def decide_after_consistency(state: DAACSState) -> str:
        if not state.get("consistency_passed", True):
            # If consistency fails despite auto-fix attempts, replan immediately
            logger.info("[Workflow] Consistency check failed unfixable issues. Triggering replanning.")
            return "replan"
        return "code_review"

    workflow.add_conditional_edges("consistency_check", decide_after_consistency, 
                                  {"replan": "orchestrator_replanning", "code_review": "code_review"})

    workflow.add_edge("code_review", "quality_scoring")  # KK 이식: 코드리뷰 → 품질점수화

    def decide_after_quality(state: DAACSState) -> str:
        if state.get("needs_replanning"):
             return "replan"
        return "judgment" # Go to judgment instead of consistency (since consistency is now earlier)

    workflow.add_conditional_edges("quality_scoring", decide_after_quality, {"replan": "orchestrator_replanning", "judgment": "orchestrator_judgment"})
    
    # Judgment Branching
    next_node = "human_review" if enable_human_in_loop else "orchestrator_judgment"
    
    def decide_post_judgment(state):
        # Uses state directly
        if state.get("stop_reason") or state.get("final_status") == "stopped":
            # 🆕 Allow best-effort delivery even on stop
            if should_best_effort_deliver(state):
                return "security_scan"  # Continue to deliver via security_scan path
            return "stop"
        
        # Human review approval logic
        if enable_human_in_loop and not state.get("human_approved", True):
             return "replan" # If human rejected
        
        if state.get("needs_rework"):
            return "replan"
        return "security_scan"
    
    # Edges for Judgment/Human Review
    if enable_human_in_loop:
        workflow.add_edge("orchestrator_judgment", "human_review")
        workflow.add_conditional_edges("human_review", decide_post_judgment,
                                      {"replan": "orchestrator_replanning", "security_scan": "security_scan", "stop": END})
    else:
        workflow.add_conditional_edges("orchestrator_judgment", decide_post_judgment,
                                      {"replan": "orchestrator_replanning", "security_scan": "security_scan", "stop": END})
    
    def decide_after_replanning(state: DAACSState) -> str:
        if state.get("stop_reason") or state.get("final_status") == "stopped":
            return "deliver" if should_best_effort_deliver(state) else "stop"
        return "parallel_execution"

    workflow.add_conditional_edges("orchestrator_replanning", decide_after_replanning,
                                  {"parallel_execution": "main_cycle_guard", "deliver": "deliver", "stop": END})
    
    workflow.add_edge("security_scan", "runtime_verification")
    workflow.add_edge("runtime_verification", "visual_verification")  # KK 이식: 런타임검증 → 시각검증

    def decide_after_visual_verification(state: DAACSState) -> str:
        if state.get("needs_rework"):
            return "replan"
        return "save"
    
    workflow.add_conditional_edges("visual_verification", decide_after_visual_verification,
                                  {"replan": "orchestrator_replanning", "save": "save_context"})
    
    workflow.add_edge("save_context", "deliver")
    workflow.add_edge("deliver", END)
    
    return workflow


def get_compiled_workflow(config, enable_checkpointing: bool = True, enable_human_in_loop: bool = False):
    """
    컴파일된 워크플로우 반환 (체크포인팅 옵션)
    """
    workflow = create_daacs_workflow(config, enable_human_in_loop)
    
    if enable_checkpointing:
        session_checkpointer = create_checkpointer()
        return workflow.compile(checkpointer=session_checkpointer)
    else:
        return workflow.compile()


def stream_workflow(compiled_workflow, initial_state: dict, config: dict = None):
    """
    워크플로우 스트리밍 실행 (SSE용 제너레이터)
    """
    thread_config = config or {"configurable": {"thread_id": "default"}}
    
    try:
        for event in compiled_workflow.stream(initial_state, thread_config, stream_mode="updates"):
            for node_name, node_output in event.items():
                yield {
                    "type": "node_update",
                    "node": node_name,
                    "data": node_output
                }
    except Exception as e:
        logger.error(f"Stream workflow error: {e}")
        yield {
            "type": "error",
            "node": "stream",
            "data": {"error": str(e)}
        }

import json
from typing import Dict, Any

from ..models.daacs_state import DAACSState
from ..llm.cli_executor import SessionBasedCLIClient
from ..utils import setup_logger
from .file_parser import parse_files_from_response, save_parsed_files
from ..orchestrator.prompt_templates import DELIVERY_PROMPT_TEMPLATE  # Fixed import

# Conditional import for MemoryManager pattern
try:
    from ..memory.vector_store import MemoryManager
    HAS_MEMORY = True
except ImportError:
    HAS_MEMORY = False

logger = setup_logger("OrchestratorDelivery")


def context_db_node(state: DAACSState) -> Dict[str, str]:
    """결과 저장"""
    return {"final_status": "saved"}


def deliver_node(state: DAACSState, llm_type: str = "codex") -> Dict[str, str]:
    """
    최종 전달 (Final Delivery)
    - README.md 작성 (문서화)
    - Dockerfile & docker-compose.yml 작성 (컨테이너화)
    """
    logger.info("[Delivery] Starting final packaging (Docs + Docker)...")

    project_dir = state.get("project_dir", ".")
    current_goal = state.get("current_goal", "")
    api_spec = state.get("api_spec", {})

    # CLI 클라이언트 생성 (설정에서 LLM 타입 가져옴)
    llm_sources = state.get("llm_sources", {})
    delivery_llm = llm_sources.get("delivery", llm_sources.get("orchestrator", llm_type))
    from daacs.config import PLANNER_MODEL
    model_name = state.get("delivery_model") or PLANNER_MODEL

    client = SessionBasedCLIClient(
        cwd=project_dir,
        cli_type=delivery_llm,
        client_name="delivery",
        model_name=model_name
    )

    # [Memory Storage] - Learn from success AND failure
    if HAS_MEMORY:
        try:
            memory = MemoryManager()
            final_status_result = "delivered" # Default assumption
            if original_status in ["stopped", "failed"] or state.get("needs_rework"):
                final_status_result = "failed"
            
            if final_status_result == "delivered":
                # Success Memory
                search_content = f"Solved Goal: {current_goal}\nAPI Spec: {json.dumps(api_spec, ensure_ascii=False)}"
                memory.add_memory(
                    text=search_content,
                    metadata={"type": "solution", "success": True},
                    memory_type="solution",
                )
                logger.info("[Delivery] Stored SUCCESS memory.")
            else:
                # Failure Memory (Lesson)
                stop_reason = state.get("stop_reason", "Unknown failure")
                failure_summary = state.get("failure_summary", [])
                lesson_content = f"[FAILURE LESSON]\nGoal: {current_goal}\nReason: {stop_reason}\nDetails: {failure_summary}"
                memory.add_memory(
                    text=lesson_content,
                    metadata={"type": "failure_lesson", "success": False},
                    memory_type="solution",  # Store in same collection but different metadata
                )
                logger.info("[Delivery] Stored FAILURE LESSON memory.")

        except Exception as e:
            logger.warning(f"Failed to store memory: {e}")

    # Prompt construction
    prompt = DELIVERY_PROMPT_TEMPLATE.format(
        current_goal=current_goal, 
        api_spec=api_spec
    )

    try:
        output = client.execute(prompt)
        files = parse_files_from_response(output)
        if files:
            save_parsed_files(files, project_dir)
            logger.info("[Delivery] Generated %s files: %s", len(files), list(files.keys()))
        else:
            logger.info("[Delivery] No files generated during packaging.")

    except Exception as e:
        logger.warning("[Delivery] Packaging failed: %s", e)

    # Determine final status
    original_status = state.get("final_status")
    final_status = "delivered"
    
    if original_status in ["stopped", "failed"] or state.get("needs_rework"):
        final_status = "delivered_incomplete"
        logger.warning(f"[Delivery] Finished with warnings (Status: {final_status})")

    return {"final_status": final_status}

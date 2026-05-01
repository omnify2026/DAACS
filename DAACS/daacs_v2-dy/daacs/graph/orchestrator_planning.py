import json
from typing import Any, Dict, Optional, TypedDict

from ..models.daacs_state import DAACSState
from ..llm.cli_executor import SessionBasedCLIClient
from ..utils import setup_logger
from ..orchestrator.spec_builder import build_auto_spec
from .orchestrator_helpers import _extract_json_from_response
from ..orchestrator.prompt_templates import PLANNING_PROMPT_TEMPLATE  # Fixed import
from ..config import SUPPORTED_MODELS  # 🆕 Import for CLI type lookup
from ..orchestrator.scanner import scan_project  # 🆕 Import scanner

# Conditional import for MemoryManager pattern
try:
    from ..memory.vector_store import MemoryManager
    HAS_MEMORY = True
except ImportError:
    HAS_MEMORY = False

logger = setup_logger("OrchestratorPlanning")


def get_cli_type_for_model(model_key: Optional[str]) -> str:
    """
    Determine the CLI type (codex, gemini, claude) based on model selection.
    
    Args:
        model_key: The model key from config (e.g., 'gemini-3-flash', 'gpt-5.2-codex')
    
    Returns:
        CLI type string: 'codex', 'gemini', or 'claude'
    """
    if not model_key:
        return "codex"  # Default fallback
    
    model_config = SUPPORTED_MODELS.get(model_key)
    if not model_config:
        # Try to infer from model name
        if "gemini" in model_key.lower():
            return "gemini"
        elif "claude" in model_key.lower():
            return "claude"
        return "codex"
    
    provider = model_config.get("provider", "codex")
    
    # Map provider to CLI type
    if provider in ("gemini",):
        return "gemini"
    elif provider in ("claude",):
        return "claude"
    else:
        return "codex"  # codex, openai-compatible, etc.


class PlanningResult(TypedDict, total=False):
    orchestrator_plan: str
    needs_backend: bool
    needs_frontend: bool
    backend_instructions: str
    frontend_instructions: str
    api_spec: Dict[str, Any]
    success_criteria: list
    auto_spec: Dict[str, Any]
    architecture: str
    dependency_graph: str
    tech_context: str
    assumptions: str


def orchestrator_planning_node(state: DAACSState, llm_type: str = "gemini") -> PlanningResult:
    """전체 계획 수립 노드 - API Spec 생성 포함"""
    project_dir = state.get("project_dir", ".")
    current_goal = state.get("current_goal", "")
    model_name = state.get("orchestrator_model")
    
    # 🆕 Determine CLI type from model config, override the default llm_type
    cli_type = get_cli_type_for_model(model_name)
    actual_model = SUPPORTED_MODELS.get(model_name, {}).get("model_name", model_name)
    
    logger.info(f"[Planning] Using CLI type: {cli_type}, model: {actual_model} (selected: {model_name})")
    
    client = SessionBasedCLIClient(
        cwd=project_dir, 
        cli_type=cli_type,  # 🆕 Use determined CLI type
        client_name="orchestrator",
        model_name=actual_model  # 🆕 Use actual model name from config
    )

    tech_context = state.get("tech_context", {})
    assumptions = state.get("assumptions", {})

    # datetime 필드 제거 (if present)
    if isinstance(tech_context, dict) and "fetched_at" in tech_context:
        tech_context = {k: v for k, v in tech_context.items() if k != "fetched_at"}

    # 🆕 Scan Project Structure
    try:
        scan_result = scan_project(project_dir, max_files=50)
        project_files = scan_result.get("files", [])
        project_structure_str = "\n".join(f"- {f}" for f in project_files)
        if not project_structure_str:
            project_structure_str = "(No existing files found - New Project)"
    except Exception as e:
        logger.warning(f"[Planning] Failed to scan project: {e}")
        project_structure_str = "(Scan failed)"

    auto_spec = build_auto_spec(current_goal, assumptions, tech_context)

    # [Memory Retrieval]
    memory_context = ""
    # [Memory Retrieval]
    memory_context = ""
    if HAS_MEMORY:
        try:
            memory = MemoryManager()
            
            # 1. Search for successful codes (Reference)
            results = memory.search_memory(current_goal, n_results=2, filter_metadata={"success": True})
            if results:
                memory_context += "\n=== 📚 Relevant Successful Experience ===\n"
                for res in results:
                    memory_context += f"- {res['content']}\n"
                logger.info("[Planning] Retrieved %s success memories.", len(results))

            # 2. Search for failure lessons (Warnings)
            fail_results = memory.search_memory(current_goal, n_results=2, filter_metadata={"type": "failure_lesson"})
            if fail_results:
                memory_context += "\n=== ⚠️ WARNING: PAST FAILURE LESSONS ===\nWe failed similarly before. AVOID these mistakes:\n"
                for res in fail_results:
                    memory_context += f"- {res['content']}\n"
                logger.info("[Planning] Retrieved %s failure lessons.", len(fail_results))

        except Exception as e:
            logger.warning(f"Memory retrieval failed: {e}")

    # Prompt construction
    prompt = PLANNING_PROMPT_TEMPLATE.format(
        current_goal=current_goal, 
        tech_context=tech_context, 
        assumptions=assumptions, 
        project_structure=project_structure_str,  # 🆕 Injected project structure
        auto_spec=json.dumps(auto_spec, ensure_ascii=False),
        memory_context=memory_context
    )

    try:
        response = client.execute(prompt)
    except Exception as exc:
        logger.error("[Planning] LLM execution failed: %s", exc, exc_info=True)
        raise RuntimeError("Planning LLM execution failed") from exc

    data = _extract_json_from_response(response)
    if not data:
        logger.error("[Planning] LLM response missing/invalid JSON.")
        raise RuntimeError("Planning LLM response invalid")

    # Issue 14: Add API response validation
    data = _validate_planning_data(data)
    if state.get("force_backend"):
        if not data.get("needs_backend"):
            logger.info("[Planning] force_backend enabled; overriding needs_backend=true.")
        data["needs_backend"] = True
        if not data.get("backend_instructions"):
            data["backend_instructions"] = "Build backend based on goal."

    api_endpoints = data.get("api_spec", {}).get("endpoints", [])
    logger.info("[Planning] API Spec: %s endpoints", len(api_endpoints))

    return {
        "orchestrator_plan": data.get("plan", ""),
        "needs_backend": data.get("needs_backend", True),
        "needs_frontend": data.get("needs_frontend", True),
        "backend_instructions": data.get("backend_instructions", ""),
        "frontend_instructions": data.get("frontend_instructions", ""),
        "api_spec": data.get("api_spec", {"endpoints": []}),
        "success_criteria": data.get("success_criteria", []),
        "auto_spec": auto_spec,
        "architecture": data.get("architecture", ""),
        "dependency_graph": data.get("dependency_graph", ""),
        "tech_context": data.get("tech_context", ""),
        "assumptions": data.get("assumptions", ""),
    }


def _validate_planning_data(data: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """
    Validate planning data structure and provide safe defaults.
    Addresses Issue 14 (Missing API response validation).
    """
    if not data:
        logger.warning("[Planning] Failed to parse plan JSON, using defaults.")
        return {
            "plan": "Failed to parse plan, defaulting to full build.",
            "needs_backend": True,
            "needs_frontend": True,
            "backend_instructions": "Build backend based on goal.",
            "frontend_instructions": "Build frontend based on goal.",
            "api_spec": {"endpoints": []},
            "success_criteria": [],
        }
    
    # Ensure required keys exist with correct types
    defaults = {
        "plan": "",
        "needs_backend": True,
        "needs_frontend": True,
        "backend_instructions": "",
        "frontend_instructions": "",
        "api_spec": {"endpoints": []},
        "success_criteria": []
    }
    
    validated = data.copy()
    for key, default_val in defaults.items():
        if key not in validated:
            logger.warning(f"[Planning] Missing key '{key}' in response, using default.")
            validated[key] = default_val
        elif not isinstance(validated[key], type(default_val)) and default_val is not None:
            # Special case for empty list vs non-empty list type check
            if isinstance(default_val, list) and isinstance(validated[key], list):
                continue
            # Special case for dict
            if isinstance(default_val, dict) and isinstance(validated[key], dict):
                continue
                
            logger.warning(f"[Planning] Invalid type for '{key}', expected {type(default_val)}, got {type(validated[key])}")
            validated[key] = default_val
            
    return validated

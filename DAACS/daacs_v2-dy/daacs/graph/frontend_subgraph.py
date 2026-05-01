"""
DAACS v6.0 - Frontend Subgraph
Creates the frontend subgraph using common subgraph builder.
"""
import os
from typing import Any, Dict
from ..utils import setup_logger

logger = setup_logger("FrontendSubgraph")

from ..models.daacs_state import DAACSState
from .subgraph_builder import SubgraphRoleConfig, create_role_subgraph
from .templates.frontend_scaffold import (
    frontend_scaffold_page,
    FRONTEND_SCAFFOLD_LAYOUT,
    FRONTEND_SCAFFOLD_CSS,
    FRONTEND_SCAFFOLD_PACKAGE_JSON,
    FRONTEND_SCAFFOLD_NEXT_CONFIG,
    FRONTEND_SCAFFOLD_POSTCSS_CONFIG,
    FRONTEND_SCAFFOLD_TAILWIND_CONFIG,
    FRONTEND_SCAFFOLD_TSCONFIG,
    FRONTEND_SCAFFOLD_NEXT_ENV,
)
from .templates.subgraph_prompts import build_frontend_prompt


def _write_if_missing(path: str, content: str) -> None:
    """Write file if not exists, creating parent dirs."""
    if os.path.exists(path):
        logger.debug(f"[scaffold] Skipping (already exists): {path}")
        return
    
    # Create parent directory if needed
    parent_dir = os.path.dirname(path)
    if parent_dir:
        os.makedirs(parent_dir, exist_ok=True)
    
    try:
        with open(path, "w", encoding="utf-8") as f:
            f.write(content)
        logger.info(f"[scaffold] Created: {path}")
    except Exception as e:
        logger.error(f"[scaffold] Failed to create {path}: {e}")


def _ensure_frontend_scaffold(state: DAACSState, role_dir: str) -> None:
    """Ensure basic frontend scaffold files exist."""
    logger.info(f"[scaffold] Starting frontend scaffold for: {role_dir}")
    
    auto_spec = state.get("auto_spec", {}) or {}
    required_files = list(auto_spec.get("required_files") or [])
    defaults = ["app/page.tsx", "app/layout.tsx", "app/globals.css"]
    for idx, default in enumerate(defaults):
        if idx >= len(required_files):
            required_files.append(default)
    
    logger.info(f"[scaffold] Required files: {required_files}")
    
    page_path = os.path.join(role_dir, required_files[0])
    layout_path = os.path.join(role_dir, required_files[1])
    css_path = os.path.join(role_dir, required_files[2])
    
    _write_if_missing(page_path, frontend_scaffold_page(auto_spec))
    _write_if_missing(layout_path, FRONTEND_SCAFFOLD_LAYOUT)
    _write_if_missing(css_path, FRONTEND_SCAFFOLD_CSS)

    assumptions = auto_spec.get("assumptions", {}) or {}
    framework = (assumptions.get("frontend_framework") or "nextjs").lower()
    logger.info(f"[scaffold] Framework detected: {framework}")
    
    if framework in {"nextjs", "next", "next.js"}:
        _write_if_missing(os.path.join(role_dir, "package.json"), FRONTEND_SCAFFOLD_PACKAGE_JSON)
        _write_if_missing(os.path.join(role_dir, "next.config.js"), FRONTEND_SCAFFOLD_NEXT_CONFIG)
        _write_if_missing(os.path.join(role_dir, "postcss.config.js"), FRONTEND_SCAFFOLD_POSTCSS_CONFIG)
        _write_if_missing(os.path.join(role_dir, "tailwind.config.js"), FRONTEND_SCAFFOLD_TAILWIND_CONFIG)
        _write_if_missing(os.path.join(role_dir, "tsconfig.json"), FRONTEND_SCAFFOLD_TSCONFIG)
        _write_if_missing(os.path.join(role_dir, "next-env.d.ts"), FRONTEND_SCAFFOLD_NEXT_ENV)
    
    logger.info(f"[scaffold] Frontend scaffold completed for: {role_dir}")


def create_frontend_subgraph(config, event_callback: callable = None):
    """Create the frontend subgraph."""
    
    def _verification_kwargs_builder(state: DAACSState) -> Dict[str, Any]:
        """Build verification kwargs with escalation logic.
        
        1st pass (iteration=1): System Smoke Test only (fast)
        2nd+ pass (iteration>=2): Full Smoke Test (UI included)
        """
        iteration = state.get("frontend_subgraph_iterations", 0) or 0
        # Escalate to full UI smoke test after first attempt
        full_verification = iteration >= 2
        if full_verification:
            logger.info("[frontend] Escalating to full verification (iteration=%s)", iteration)
        return {"full_verification": full_verification}
    
    role_config = SubgraphRoleConfig(
        role="frontend",
        subdir_name="frontend",
        iteration_key="frontend_subgraph_iterations",
        status_key="frontend_status",
        logs_key="frontend_logs",
        files_key="frontend_files",
        verification_details_key="frontend_verification_details",
        needs_rework_key="frontend_needs_rework",
        verification_type="frontend",  # Will be escalated to frontend_full via kwargs
        prompt_builder=build_frontend_prompt,
        verification_kwargs_builder=_verification_kwargs_builder,
        postflight=_ensure_frontend_scaffold,
        generation_stages=["scaffold", "implement", "polish"],
        file_extensions=[".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".json", ".html", ".css", ".scss", ".sass"],
    )
    return create_role_subgraph(config, role_config, event_callback=event_callback)


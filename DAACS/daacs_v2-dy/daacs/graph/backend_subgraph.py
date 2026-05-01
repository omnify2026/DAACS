"""
DAACS v6.0 - Backend Subgraph
Creates the backend subgraph using common subgraph builder.
"""
from ..models.daacs_state import DAACSState
from .subgraph_builder import SubgraphRoleConfig, create_role_subgraph
from .templates.subgraph_prompts import build_backend_prompt


def create_backend_subgraph(config, event_callback: callable = None):
    """Create the backend subgraph."""
    role_config = SubgraphRoleConfig(
        role="backend",
        subdir_name="backend",
        iteration_key="backend_subgraph_iterations",
        status_key="backend_status",
        logs_key="backend_logs",
        files_key="backend_files",
        verification_details_key="backend_verification_details",
        needs_rework_key="backend_needs_rework",
        verification_type="backend",
        prompt_builder=build_backend_prompt,
        verification_kwargs_builder=lambda state: {
            "api_spec": state.get("api_spec", {}),
            "fullstack_required": bool(state.get("needs_backend", True) and state.get("needs_frontend", True)),
        },
        generation_stages=["scaffold", "implement", "polish"],
        file_extensions=[".py"],
    )
    return create_role_subgraph(config, role_config, event_callback=event_callback)

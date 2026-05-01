# DAACS Models (Placeholder)
from dataclasses import dataclass
from typing import Dict, Any, List, Optional


@dataclass
class DAACSState:
    """State for DAACS workflow (simplified for CLI)."""
    goal: str = ""
    project_dir: str = "output"
    api_spec: Dict = None
    task_plan: List[Dict] = None
    current_phase: str = "init"
    
    def __post_init__(self):
        if self.api_spec is None:
            self.api_spec = {}
        if self.task_plan is None:
            self.task_plan = []
    
    def get(self, key: str, default: Any = None) -> Any:
        return getattr(self, key, default)

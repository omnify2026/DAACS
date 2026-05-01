"""
DAACS Orchestrator Configuration
Central location for orchestrator-specific settings and constants.
Moved from daacs.orchestrator.config to avoid circular imports.
"""
from typing import Dict, List

# Verification templates for different action types (Issue 110)
DEFAULT_VERIFY_TEMPLATES: Dict[str, List[str]] = {
    "shell": [
        "files_exist:files.txt", 
        "files_not_empty:files.txt", 
        "files_no_hidden:files.txt", 
        "files_match_listing:files.txt"
    ],
    "edit": ["files_exist:files.txt"],
    "test": ["tests_pass", "tests_no_error"],
    "codegen": ["tests_pass", "tests_no_error"],
    "refactor": ["tests_pass", "tests_no_error"],
    "build": ["build_success"],
    "deploy": ["build_success"],
    "quality": ["quality_pass"]
}

# Retry limits (Issue 117)
MAX_FAILED_STREAK: int = 3

"""
DAACS - Orchestrator Type Definitions
TypedDict definitions for action dictionaries and other shared types.
"""
from typing import Dict, List, Any, Optional, Literal
from typing_extensions import TypedDict


class ActionDict(TypedDict, total=False):
    """Structure for development action dictionaries."""
    action: str  # e.g., "dev_instruction"
    type: Literal["shell", "codegen", "test"]
    instruction: str
    verify: List[str]
    comment: str
    targets: List[str]
    client: Literal["frontend", "backend"]


class VerifyResultDict(TypedDict, total=False):
    """Structure for verification result dictionaries."""
    ok: bool
    reason: str
    template: str
    details: str


class PlanDict(TypedDict, total=False):
    """Structure for plan dictionaries returned by orchestrator."""
    goal: str
    actions: List[ActionDict]
    thinking: str
    clarify_questions: List[str]
    total_actions: int
    current_action_index: int


class CodeReviewResultDict(TypedDict, total=False):
    """Structure for code review results."""
    score: float
    issues: List[str]
    suggestions: List[str]
    summary: str


class ProjectConfigDict(TypedDict, total=False):
    """Structure for project configuration."""
    llm_mode: str
    model: str
    max_iterations: int
    skip_verification: bool
    skip_rfi: bool
    test_mode: bool
    fullstack: bool
    quality_gate: bool
    force_backend: bool


# Action Types
ACTION_TYPES = Literal["shell", "codegen", "test", "build", "deploy"]

# Client Types
CLIENT_TYPES = Literal["frontend", "backend"]

# Default action template
DEFAULT_ACTION: ActionDict = {
    "action": "dev_instruction",
    "type": "shell",
    "instruction": "",
    "verify": [],
    "comment": "",
    "targets": [],
    "client": "frontend"
}

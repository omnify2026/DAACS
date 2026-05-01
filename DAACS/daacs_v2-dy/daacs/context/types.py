"""
Context types for Phase 1.5 Tech Context Enrichment.

This module defines the data structures used for:
- RFI (Requirements for Information) results
- Tech Context facts from external sources
- Assumptions for planning
"""

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import List, Optional, Dict, Literal


@dataclass
class RFIResult:
    """Result from the RFI (Requirements Clarification) phase."""
    language: Optional[str] = None
    platform: Optional[str] = None  # "web", "desktop", "mobile"
    ui_required: bool = False
    constraints: List[str] = field(default_factory=list)
    raw_responses: Dict[str, str] = field(default_factory=dict)


@dataclass
class TechContext:
    """
    External tech context facts for Planner reference.
    
    CRITICAL: This contains FACTS only, not recommendations.
    - "React + Vite is widely used" ✅
    - "React is the best choice" ❌
    """
    facts: List[str] = field(default_factory=list)
    constraints: List[str] = field(default_factory=list)
    sources: List[str] = field(default_factory=list)
    fetched_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))


# Type aliases for Assumptions
Environment = Literal["web", "desktop", "mobile"]
PrimaryFocus = Literal["mvp", "design", "stability"]


@dataclass
class Assumptions:
    """
    User design assumptions for planning.
    
    - environment: Mutually exclusive (pick one)
    - primary_focus: Single most important criterion
    - options: Optional toggles
    """
    environment: Environment = "web"
    primary_focus: PrimaryFocus = "mvp"
    options: Dict[str, bool] = field(default_factory=lambda: {
        "maintainability": False,
        "ci_cd": False,
        "scalability": False,
    })


@dataclass
class AssumptionDelta:
    """Changes to assumptions for re-planning."""
    removed: List[str] = field(default_factory=list)
    added: List[str] = field(default_factory=list)
    modified: List[tuple] = field(default_factory=list)  # (old, new)

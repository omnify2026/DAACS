"""
DAACS Context Module - Phase 1.5 Tech Context Enrichment

This module provides:
- TechContext: External facts for Planner reference
- Assumptions: User design preferences
- Providers: StaticTechContextProvider (MVP)
"""

from .types import (
    RFIResult,
    TechContext,
    Assumptions,
    AssumptionDelta,
    Environment,
    PrimaryFocus,
)
from .base import TechContextProvider
from .static_provider import StaticTechContextProvider
from .web_provider import WebTechContextProvider

__all__ = [
    # Types
    "RFIResult",
    "TechContext",
    "Assumptions",
    "AssumptionDelta",
    "Environment",
    "PrimaryFocus",
    # Interfaces
    "TechContextProvider",
    # Implementations
    "StaticTechContextProvider",
    "WebTechContextProvider",
]

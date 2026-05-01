"""
Base interfaces for Tech Context Providers.

Providers must:
- Return FACTS only (no recommendations)
- Be deterministic when possible
- Support fallback gracefully
"""

from typing import Protocol
from .types import RFIResult, TechContext


class TechContextProvider(Protocol):
    """
    Protocol for tech context providers.
    
    Implementations:
    - StaticTechContextProvider: Model-embedded knowledge
    - WebTechContextProvider: Web search (future)
    - CachedTechContextProvider: Cached snapshots (future)
    """
    
    def fetch(self, rfi: RFIResult) -> TechContext:
        """
        Fetch tech context based on RFI results.
        
        Args:
            rfi: The RFI result containing language, platform, etc.
            
        Returns:
            TechContext with facts (not recommendations)
        """
        ...

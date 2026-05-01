
import logging
from typing import Dict, Any, Optional, List
from dataclasses import asdict

from daacs.context import RFIResult, TechContext, Assumptions
from daacs.context.web_provider import WebTechContextProvider
from daacs.context.search_client import DuckDuckGoSearchClient, MockSearchClient
from daacs.config import DAACS_CONTEXT_PROVIDER

logger = logging.getLogger(__name__)

class ContextManager:
    """
    Manages Technical Context, Assumptions, and RFI Extraction.
    Corresponds to Phase 1.5 logic in Orchestrator.
    """
    def __init__(self, event_callback):
        self._emit_event = event_callback
        
        # Initialize Provider
        if DAACS_CONTEXT_PROVIDER == "web":
            try:
                client = DuckDuckGoSearchClient()
                logger.info("Using DuckDuckGo for context enrichment")
            except ImportError:
                # Fallback purely for safety if missing
                try: 
                    client = MockSearchClient() 
                except Exception as e:
                     # Very generic fallback if MockSearchClient is also not importable
                     logger.debug(f"MockSearchClient also failed: {e}")
                     class SimpleMock:
                         def search(self, q): return []
                     client = SimpleMock()

                logger.warning("duckduckgo-search not found or failed, falling back to Mock")
                
            self.provider = WebTechContextProvider(search_client=client)
        else:
            from daacs.context import StaticTechContextProvider
            self.provider = StaticTechContextProvider()
            
        self.assumptions = Assumptions()
        self.tech_context: Optional[TechContext] = None
        self.last_rfi_result: Optional[RFIResult] = None

    def extract_rfi_result(self, goal: str) -> RFIResult:
        """Parse the refined goal into RFIResult for TechContext provider."""
        goal_lower = goal.lower()
        
        # Detect language
        language = None
        if "python" in goal_lower:
            language = "python"
        elif "typescript" in goal_lower or "ts" in goal_lower:
            language = "typescript"
        elif "javascript" in goal_lower or "js" in goal_lower:
            language = "javascript"
        elif "go" in goal_lower or "golang" in goal_lower:
            language = "go"
        
        # Detect platform
        platform = "web"  # Default
        if "desktop" in goal_lower or "데스크톱" in goal_lower:
            platform = "desktop"
        elif "mobile" in goal_lower or "모바일" in goal_lower:
            platform = "mobile"
        
        # Detect UI requirement
        ui_required = any(kw in goal_lower for kw in [
            "ui", "화면", "frontend", "프론트", "웹앱", "앱", "react", "vue"
        ])
        
        # Extract constraints
        constraints = []
        if "빠르게" in goal_lower or "simple" in goal_lower or "mvp" in goal_lower:
            constraints.append("빠른 MVP")
        if "안정" in goal_lower or "stability" in goal_lower:
            constraints.append("안정성 우선")
        
        return RFIResult(
            language=language,
            platform=platform,
            ui_required=ui_required,
            constraints=constraints,
        )

    def apply_assumption_delta(self, delta: Any) -> Dict[str, Any]:
        """
        Phase 1.5: Apply AssumptionDelta and recalculate TechContext.
        """
        logger.info(f"Applying assumption delta: {delta}")
        
        # 1. Update internal assumptions
        # Handle 'modified' (list of [old, new])
        for old, new in delta.modified:
            if old.startswith("environment:"):
                self.assumptions.environment = new.split(":")[1]
            elif old.startswith("primary_focus:"):
                self.assumptions.primary_focus = new.split(":")[1]
        
        # Handle 'added/removed' options
        for item in delta.added:
            if item.startswith("option:"):
                key = item.split(":")[1]
                self.assumptions.options[key] = True
        
        for item in delta.removed:
            if item.startswith("option:"):
                key = item.split(":")[1]
                self.assumptions.options[key] = False
                
        # 2. Recalculate TechContext
        if self.last_rfi_result:
            logger.info("Recalculating TechContext with new assumptions...")
            self.tech_context = self.provider.fetch(self.last_rfi_result, self.assumptions)
            
            self._emit_event("TECH_CONTEXT", {
                "facts": self.tech_context.facts,
                "sources": self.tech_context.sources,
                "constraints": self.tech_context.constraints,
            })
            
            self._emit_event("ASSUMPTION_APPLIED", {
                "assumptions": self.get_assumptions_dict(),
                "message": "Assumptions updated. Tech Context refreshed."
            })
        
        return {"status": "updated", "assumptions": self.get_assumptions_dict()}

    def enrich_context(self, goal: str):
        try:
             self.last_rfi_result = self.extract_rfi_result(goal)
             self.tech_context = self.provider.fetch(self.last_rfi_result, self.assumptions)
             
             self._emit_event("TECH_CONTEXT", {
                "facts": self.tech_context.facts,
                "sources": self.tech_context.sources,
                "constraints": self.tech_context.constraints,
             })
        except Exception as e:
             logger.warning(f"Failed to enrich tech context: {e}")

    def get_context_dict(self) -> Dict[str, Any]:
        """Return tech_context as dict for LangGraph/safe serialization"""
        if not self.tech_context:
            return {}
        try:
            d = asdict(self.tech_context)
            d.pop("fetched_at", None)
            return d
        except (TypeError, AttributeError):
            return {}

    def get_assumptions_dict(self) -> Dict[str, Any]:
        try:
            return asdict(self.assumptions)
        except (TypeError, AttributeError):
            return self.assumptions.__dict__

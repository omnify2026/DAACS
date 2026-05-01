"""
Static Tech Context Provider.

Uses curated JSON files from tech_context/ directory.
Falls back to embedded knowledge if files not found.

CRITICAL: TechContext is a FUNCTION of (RFI + Assumptions).
When Assumptions change, TechContext MUST be recalculated.

This is the MVP implementation for Phase 1.5.
"""

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional
from .types import RFIResult, TechContext, Assumptions
from .constraints import generate_constraints
from daacs.utils import setup_logger
from daacs.config import STATIC_CONTEXT_DIR_NAME

logger = setup_logger("StaticTechContextProvider")


# Path to tech context JSON files
# Path to tech context JSON files
TECH_CONTEXT_DIR = Path(__file__).parent / STATIC_CONTEXT_DIR_NAME


class StaticTechContextProvider:
    """
    Static provider using curated knowledge from JSON files.
    
    CRITICAL RULES:
    - Returns FACTS only ("X is widely used")
    - Never returns RECOMMENDATIONS ("X is the best")
    - Deterministic output for same input
    - Uses versioned JSON packs for reproducibility
    - TechContext = f(RFI, Assumptions) - ALWAYS recalculate on assumption change
    """
    
    def __init__(self, context_dir: Optional[Path] = None):
        self.context_dir = context_dir or TECH_CONTEXT_DIR
        if not self.context_dir.exists():
            logger.warning(f"Tech context directory not found: {self.context_dir}")
    
    def _load_pack(self, scope: str) -> Optional[dict]:
        """Load a tech context pack from JSON file."""
        pack_file = self.context_dir / f"{scope}.json"
        if pack_file.exists():
            try:
                with open(pack_file, "r", encoding="utf-8") as f:
                    return json.load(f)
            except (json.JSONDecodeError, OSError, ValueError) as e:
                logger.warning(f"Failed to load pack {scope}: {e}")
                return None
        return None
    
    def fetch(self, rfi: RFIResult, assumptions: Optional[Assumptions] = None) -> TechContext:
        """
        Fetch tech context based on RFI results AND Assumptions.
        
        CRITICAL: This must be called EVERY time assumptions change.
        TechContext is NOT a cache - it's a function of (RFI, Assumptions).
        """
        if assumptions is None:
            assumptions = Assumptions()
        
        facts: List[str] = []
        sources: List[str] = []
        constraints: List[str] = []
        
        # === STEP 1: Load base packs based on RFI ===
        packs_to_load = self._determine_packs(rfi, assumptions)
        if not packs_to_load:
            packs_to_load.append("general")
        packs_to_load = list(dict.fromkeys(packs_to_load))
        
        for scope in packs_to_load:
            pack = self._load_pack(scope)
            if pack:
                facts.extend(pack.get("facts", []))
                sources.extend(pack.get("sources", []))
        
        # === STEP 2: Add NON-NEGOTIABLE constraints based on Assumptions ===
        constraints.extend(generate_constraints(assumptions))
        
        # === STEP 3: Filter/prioritize facts based on primary_focus ===
        facts = self._prioritize_facts(facts, assumptions.primary_focus)
        
        # Fallback if no packs loaded
        if not facts:
            facts, sources = self._fallback_facts(rfi, assumptions)
            logger.info("Using fallback facts as no packs were loaded.")
        
        # Deduplicate
        sources = list(dict.fromkeys(sources))
        
        return TechContext(
            facts=facts,
            constraints=constraints + (rfi.constraints.copy() if rfi.constraints else []),
            sources=sources,
            fetched_at=datetime.now(timezone.utc),
        )
    
    def _determine_packs(self, rfi: RFIResult, assumptions: Assumptions) -> List[str]:
        """Determine which packs to load based on RFI + Assumptions."""
        packs = []
        
        # Power of Assumptions: Environment overrides RFI platform
        # If assumptions.environment is set (it always is), it dictates the pack.
        
        if assumptions.environment == "web":
            if rfi.ui_required:
                packs.append("frontend_web_small")
            # Even if it's web, we check RFI language for backend hint
            if rfi.language and rfi.language.lower() == "python":
                packs.append("backend_api_small")
                
        elif assumptions.environment == "desktop":
            packs.append("desktop_app")
            
        elif assumptions.environment == "mobile":
            packs.append("mobile_app")
        
        return packs
    
    
    def _prioritize_facts(self, facts: List[str], primary_focus: str) -> List[str]:
        """Reorder/filter facts based on primary_focus."""
        # For now, return all facts - future: filter by relevance
        return facts
    
    def _fallback_facts(self, rfi: RFIResult, assumptions: Assumptions) -> tuple[List[str], List[str]]:
        """Fallback embedded facts when JSON files not available."""
        facts = []
        sources = ["curated-knowledge-2025-Q1-embedded"]
        
        if rfi.ui_required:
            if assumptions.primary_focus == "design":
                facts.append("디자인 중심 프로젝트는 컴포넌트 구조 설계를 먼저 확립한다")
                facts.append("Tailwind + shadcn/ui 조합이 디자인 품질과 속도를 모두 확보한다")
            else:
                facts.append("빠른 MVP/소형 웹앱 기본 스택으로 React + Vite를 우선 고려한다")
                facts.append("UI는 Tailwind 기반으로 초기 속도를 확보한다")
        
        if rfi.platform == "desktop":
            facts.append("경량 데스크톱 앱에서는 Electron보다 Tauri 사용 비중이 증가하는 추세")
        elif rfi.platform == "mobile":
            facts.append("크로스 플랫폼 모바일 앱에서 React Native와 Flutter가 주로 사용됨")
        
        if rfi.language and rfi.language.lower() == "python":
            facts.append("Python 생태계에서 FastAPI는 간단한 API 서버에 널리 사용됨")
        
        return facts, sources

"""
DAACS Graph - Tech Context Node
기술 스택 추천 및 TechContext 생성

Thinking 모드: RFI 결과 기반 동적 TechContext 생성
Quick 모드: 기본 TechContext 반환
"""

from typing import Dict, Any, Optional, List
import logging

logger = logging.getLogger(__name__)


def tech_context_enrichment_node(state: Dict[str, Any], llm=None) -> Dict[str, Any]:
    """
    Tech Context Enrichment 노드
    
    Thinking 모드에서 RFI 결과를 바탕으로 TechContext를 생성합니다.
    Quick 모드에서는 기본 TechContext를 반환합니다.
    
    Args:
        state: 현재 상태 (DAACSState)
        llm: LLM 인스턴스 (선택적)
        
    Returns:
        {
            "tech_context": {...},
            "current_phase": "tech_context_complete"
        }
    """
    logger.info("[TechContext] Enriching tech context...")
    
    mode = state.get("mode", "quick")
    rfi_result = state.get("rfi_result", {})
    current_goal = state.get("current_goal", "") or state.get("goal", "")
    
    if mode == "quick":
        logger.info("[TechContext] Quick mode - using default tech context")
        tech_context = get_default_tech_context()
    else:
        logger.info("[TechContext] Thinking mode - generating enriched context")
        tech_context = generate_tech_context(current_goal, rfi_result, llm)
    
    logger.info(f"[TechContext] Generated context with {len(tech_context.get('facts', []))} facts")
    
    return {
        "tech_context": tech_context,
        "current_phase": "tech_context_complete"
    }


def get_default_tech_context() -> Dict[str, Any]:
    """
    기본 TechContext 반환 (Quick 모드용)
    """
    return {
        "facts": [
            "React + Vite는 2024년 기준 프론트엔드 표준 스택",
            "FastAPI는 Python 웹 프레임워크 중 가장 빠른 성능",
            "TypeScript 사용률 지속 증가 중"
        ],
        "constraints": [
            "Python 3.12+ 호환 필수",
            "CORS 설정 필수 (localhost:5173 허용)",
            "포트 8080 사용"
        ],
        "recommended_stack": {
            "frontend": "React + Vite",
            "backend": "FastAPI + Python 3.12",
            "database": "In-memory"
        }
    }


def generate_tech_context(
    goal: str,
    rfi_result: Dict[str, Any],
    llm=None
) -> Dict[str, Any]:
    """
    RFI 결과 기반 TechContext 생성 (Thinking 모드용)
    
    Args:
        goal: 사용자 목표
        rfi_result: RFI 결과 (platform, language, constraints 등)
        llm: LLM 인스턴스 (선택적)
        
    Returns:
        TechContext 딕셔너리
    """
    platform = rfi_result.get("platform", "web")
    language = rfi_result.get("language", "korean")
    constraints = rfi_result.get("constraints", [])
    
    # 플랫폼별 facts
    platform_facts = {
        "web": [
            "React + Vite는 2024년 기준 프론트엔드 표준 스택",
            "FastAPI는 Python 웹 프레임워크 중 가장 빠른 성능",
            "SPA (Single Page Application) 권장"
        ],
        "mobile": [
            "React Native 또는 Flutter 권장",
            "PWA (Progressive Web App) 대안 가능",
            "반응형 디자인 필수"
        ],
        "desktop": [
            "Electron 또는 Tauri 권장",
            "크로스 플랫폼 지원 고려",
            "로컬 데이터 저장 필요"
        ],
        "cli": [
            "Python argparse 또는 Click 권장",
            "Rich 라이브러리로 출력 포맷팅",
            "진행 상황 표시 권장"
        ]
    }
    
    # 언어별 constraints
    language_constraints = {
        "korean": ["한국어 UI 필수", "한글 폰트 지원"],
        "english": ["English UI", "i18n 지원 권장"]
    }
    
    # 플랫폼별 권장 스택
    platform_stacks = {
        "web": {
            "frontend": "React + Vite",
            "backend": "FastAPI + Python 3.12",
            "database": "In-memory"
        },
        "mobile": {
            "frontend": "React Native",
            "backend": "FastAPI + Python 3.12",
            "database": "SQLite"
        },
        "desktop": {
            "frontend": "Electron + React",
            "backend": "Python (embedded)",
            "database": "SQLite"
        },
        "cli": {
            "frontend": "N/A",
            "backend": "Python + Click",
            "database": "In-memory or file-based"
        }
    }
    
    # TechContext 조합
    tech_context = {
        "facts": platform_facts.get(platform, platform_facts["web"]),
        "constraints": [
            "Python 3.12+ 호환 필수",
            "CORS 설정 필수",
            *language_constraints.get(language, []),
            *constraints
        ],
        "recommended_stack": platform_stacks.get(platform, platform_stacks["web"]),
        "platform": platform,
        "language": language,
        "goal_summary": goal[:200] if goal else ""
    }
    
    return tech_context


def load_tech_context_from_file(filepath: str) -> Dict[str, Any]:
    """
    JSON 파일에서 TechContext 로드
    
    Args:
        filepath: JSON 파일 경로
        
    Returns:
        TechContext 딕셔너리
    """
    import json
    import os
    
    if not os.path.exists(filepath):
        logger.warning(f"[TechContext] File not found: {filepath}")
        return get_default_tech_context()
    
    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            data = json.load(f)
            logger.info(f"[TechContext] Loaded from file: {filepath}")
            return data
    except Exception as e:
        logger.warning(f"[TechContext] Failed to load: {e}")
        return get_default_tech_context()

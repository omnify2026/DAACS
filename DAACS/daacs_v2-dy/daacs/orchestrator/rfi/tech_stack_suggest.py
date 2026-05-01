"""
DAACS RFI - Tech Stack Suggestion
목표 분석 후 적합한 기술 스택 추천
"""

import json
import logging
import re
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)


def suggest_tech_stack(goal: str, llm: Optional[Any] = None) -> Dict[str, Any]:
    """
    RFI 대화 중 기술 스택 추천 (Thinking 모드 전용)
    
    LLM이 목표를 분석하고 적합한 기술 스택을 추천합니다.
    사용자는 추천을 수락하거나 다른 옵션을 선택할 수 있습니다.
    
    Args:
        goal: 사용자 목표
        llm: LLM 인스턴스 (없으면 기본값 반환)
        
    Returns:
        {
            "recommended": "React + Vite",
            "options": ["Vue + Vite", "Angular", "Svelte"],
            "backend_recommended": "FastAPI",
            "backend_options": ["Flask", "Django"],
            "reasoning": "추천 이유"
        }
    """
    logger.info("[TechStack] Analyzing goal for tech stack recommendation...")
    
    if not llm:
        return _get_default_stack()
    
    prompt = f"""목표를 분석하고 적합한 기술 스택을 추천하세요.

=== 사용자 목표 ===
{goal}

=== 출력 형식 (JSON) ===
{{
    "recommended": "가장 추천하는 프론트엔드 스택 (예: React + Vite)",
    "options": ["대안 1", "대안 2", "대안 3"],
    "backend_recommended": "FastAPI",
    "backend_options": ["Flask", "Django", "Node.js"],
    "reasoning": "추천 이유 한 줄"
}}

규칙:
- Frontend와 Backend 각각 추천
- 목표가 간단하면 React + FastAPI 기본 추천
- 목표가 복잡하면 상황에 맞게 추천
- JSON만 출력
"""
    
    try:
        response = _invoke_llm(llm, prompt)
        
        if isinstance(response, dict):
            logger.info(f"[TechStack] Recommended: {response.get('recommended', 'N/A')}")
            return response
        
        # 문자열 응답 파싱
        parsed = _parse_json_response(response)
        if parsed:
            logger.info(f"[TechStack] Recommended: {parsed.get('recommended', 'N/A')}")
            return parsed
            
    except Exception as e:
        logger.error(f"[TechStack] Error: {e}")
    
    return _get_default_stack()


def _invoke_llm(llm: Any, prompt: str) -> Any:
    """LLM 호출 래퍼 (다양한 인터페이스 지원)"""
    if hasattr(llm, 'invoke_structured'):
        return llm.invoke_structured(prompt)
    elif hasattr(llm, 'invoke'):
        return llm.invoke(prompt)
    elif callable(llm):
        return llm(prompt)
    raise ValueError("Unknown LLM interface")


def _parse_json_response(response: str) -> Optional[Dict[str, Any]]:
    """LLM 응답에서 JSON 추출"""
    if not response:
        return None
    
    # ```json ... ``` 블록 추출
    json_match = re.search(r'```json\s*([\s\S]*?)\s*```', response)
    if json_match:
        try:
            return json.loads(json_match.group(1))
        except json.JSONDecodeError as e:
            logger.debug(f"[TechStack] JSON block parse failed: {e}")
    
    # {...} 블록 추출
    brace_match = re.search(r'\{[\s\S]*\}', response)
    if brace_match:
        try:
            return json.loads(brace_match.group(0))
        except json.JSONDecodeError as e:
            logger.debug(f"[TechStack] Brace block parse failed: {e}")
    
    return None


def _get_default_stack() -> Dict[str, Any]:
    """기본 기술 스택 반환"""
    return {
        "recommended": "React + Vite",
        "options": ["Vue + Vite", "Angular", "Svelte"],
        "backend_recommended": "FastAPI",
        "backend_options": ["Flask", "Django"],
        "reasoning": "기본 추천 (분석 실패 또는 LLM 없음)"
    }

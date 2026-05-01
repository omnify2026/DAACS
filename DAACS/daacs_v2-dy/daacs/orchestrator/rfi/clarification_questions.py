"""
DAACS RFI - Clarification Questions Generator
목표 분석 후 Clarification 질문 자동 생성
"""

import json
import logging
import re
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)


def generate_clarification_questions(
    goal: str,
    llm: Optional[Any] = None
) -> Dict[str, Any]:
    """
    Clarification 질문 생성
    
    사용자 목표를 분석하고 애매한 부분에 대해 질문 생성
    LLM 판단에 의존하여 하드코딩 없이 동적 질문 생성
    
    Args:
        goal: 사용자 목표
        llm: Clarification LLM
        
    Returns:
        {
            "needs_clarification": bool,
            "questions": [...],
            "reasoning": str
        }
    """
    logger.info("[Clarification] Analyzing goal for ambiguities...")
    
    if not llm:
        return _default_response()
    
    prompt = f"""당신은 시니어 프로젝트 분석가입니다.
사용자의 프로젝트 목표를 분석하고, 구현/검증 가능한 RFP 수준으로 만들기 위해 필요한 정보를 질문하세요.

=== 사용자 목표 ===
{goal}

=== 질문 카테고리 (필요한 것만 선택) ===

1. 대상 사용자/시장: 누구를 위한 도구인가?
2. 플랫폼: 웹앱/데스크톱/모바일/CLI 중 무엇인가?
3. 기술 스택 선호: 프레임워크, 저장소 선호가 있나?
4. 핵심 기능: 어떤 주요 기능이 필요한가?
5. 데이터: 어떤 데이터를 다루는가?
6. 인증/권한: 로그인 필요 여부?
7. 성능 요구: 동시 접속, 응답 시간?
8. 디자인 선호: 모던, 미니멀, 다크모드 등?

=== 출력 형식 (JSON) ===
{{
    "needs_clarification": true,
    "questions": [
        {{
            "id": "q1",
            "category": "target_users",
            "question": "이 앱의 주요 대상 사용자는 누구인가요?",
            "options": ["개인 사용자", "팀", "기업"],
            "default": "개인 사용자"
        }},
        {{
            "id": "q2",
            "category": "platform",
            "question": "어떤 플랫폼에서 사용할 예정인가요?",
            "options": ["웹앱", "데스크톱", "모바일"],
            "default": "웹앱"
        }}
    ],
    "reasoning": "왜 이 질문들이 필요한지 간략 설명"
}}

규칙:
- 목표가 이미 명확하면 needs_clarification: false, questions: []
- 그렇지 않으면 3-5개 질문 생성
- 각 질문에 선택지(options)와 기본값(default) 제공
- 목표에 이미 명시된 내용은 질문하지 말 것
- JSON만 출력
"""

    try:
        response = _invoke_llm(llm, prompt)
        parsed = _parse_clarification_response(response)
        
        if parsed:
            needs_clarification = parsed.get("needs_clarification", False)
            questions = parsed.get("questions", [])
            reasoning = parsed.get("reasoning", "")
            
            logger.info(f"[Clarification] Needs clarification: {needs_clarification}")
            logger.info(f"[Clarification] Questions count: {len(questions)}")
            
            return {
                "needs_clarification": needs_clarification,
                "questions": questions,
                "reasoning": reasoning
            }
            
    except Exception as e:
        logger.error(f"[Clarification] Error: {e}")
    
    return _default_response()


def _invoke_llm(llm: Any, prompt: str) -> Any:
    """LLM 호출 래퍼"""
    if hasattr(llm, 'invoke_structured'):
        return llm.invoke_structured(prompt)
    elif hasattr(llm, 'invoke'):
        return llm.invoke(prompt)
    elif callable(llm):
        return llm(prompt)
    raise ValueError("Unknown LLM interface")


def _parse_clarification_response(response: Any) -> Optional[Dict[str, Any]]:
    """Clarification 응답 파싱"""
    if isinstance(response, dict):
        return response
    
    if isinstance(response, str):
        logger.debug(f"[Clarification] Raw response (first 300 chars): {response[:300]}")
        
        # 방법 1: ```json ... ``` 블록 추출
        json_match = re.search(r'```json\s*([\s\S]*?)\s*```', response)
        if json_match:
            try:
                return json.loads(json_match.group(1))
            except json.JSONDecodeError as e:
                logger.debug(f"[Clarification] Failed to parse json block: {e}")
        
        # 방법 2: {...} 블록 추출
        brace_match = re.search(r'\{[\s\S]*\}', response)
        if brace_match:
            try:
                return json.loads(brace_match.group(0))
            except json.JSONDecodeError as e:
                logger.debug(f"[Clarification] Failed to parse brace block: {e}")
        
        # 방법 3: 전체 문자열 파싱
        try:
            return json.loads(response)
        except json.JSONDecodeError:
            pass
    
    return None


def _default_response() -> Dict[str, Any]:
    """기본 응답 (질문 없음)"""
    return {
        "needs_clarification": False,
        "questions": [],
        "reasoning": "LLM 없음 또는 파싱 실패"
    }

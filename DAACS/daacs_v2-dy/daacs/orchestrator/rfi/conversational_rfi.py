"""
DAACS RFI - Conversational RFI Loop
대화형 RFI 루프 및 사용자 답변 처리
"""

import json
import logging
import re
import time
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

# 최대 RFI 반복 횟수 (무한 루프 방지)
MAX_RFI_ITERATIONS = 5
DEFAULT_RFI_HINT = "필요하면 'go' 또는 'build'를 입력해 바로 진행할 수 있고, 엔터만 누르면 분석가가 기본 스펙을 자동완성합니다."
GO_KEYWORDS = ("go", "build", "run", "start", "시작", "진행")


def is_go_command(text: str) -> bool:
    """입력 문자열이 즉시 진행(go) 의도인지 판단."""
    normalized = text.strip().lower()
    if not normalized:
        return False
    if normalized in GO_KEYWORDS:
        return True
    return len(normalized) <= 12 and any(keyword in normalized for keyword in GO_KEYWORDS)


def _collect_context_text(goal: str, conversation_history: List[Dict[str, Any]]) -> str:
    """목표 + 사용자 답변만 결합해 간단한 컨텍스트 텍스트 생성."""
    parts = [goal]
    for qa in conversation_history:
        answer = qa.get("answer", "")
        if answer:
            parts.append(answer)
    return " ".join(parts)


def _infer_known_info(context_text: str) -> Dict[str, Optional[str]]:
    """간단한 키워드 기반으로 이미 주어진 정보 추정."""
    lowered = re.sub(r"\s+", " ", context_text).lower()
    info: Dict[str, Optional[str]] = {
        "platform": None,
        "frontend": None,
        "backend": None,
        "database": None,
        "auth": None,
        "ui_style": None,
        "target_users": None,
    }

    if any(token in lowered for token in ("ios", "android", "모바일", "react native", "flutter")):
        info["platform"] = "mobile"
    elif any(token in lowered for token in ("데스크톱", "desktop", "윈도우", "macos")):
        info["platform"] = "desktop"
    elif any(token in lowered for token in ("cli", "터미널", "커맨드라인", "command line")):
        info["platform"] = "cli"
    elif any(token in lowered for token in ("웹앱", "웹 앱", "web", "브라우저", "browser")):
        info["platform"] = "web"

    if "react native" in lowered:
        info["frontend"] = "React Native"
    elif "next.js" in lowered or "nextjs" in lowered:
        info["frontend"] = "Next.js"
    elif "react" in lowered:
        info["frontend"] = "React"
    elif "vue" in lowered:
        info["frontend"] = "Vue"
    elif "svelte" in lowered:
        info["frontend"] = "Svelte"
    elif "angular" in lowered:
        info["frontend"] = "Angular"
    elif "flutter" in lowered:
        info["frontend"] = "Flutter"

    if "fastapi" in lowered:
        info["backend"] = "FastAPI"
    elif "django" in lowered:
        info["backend"] = "Django"
    elif "flask" in lowered:
        info["backend"] = "Flask"
    elif "express" in lowered:
        info["backend"] = "Express"
    elif "node" in lowered:
        info["backend"] = "Node.js"
    elif "spring" in lowered:
        info["backend"] = "Spring"
    elif "laravel" in lowered:
        info["backend"] = "Laravel"

    if "postgres" in lowered:
        info["database"] = "PostgreSQL"
    elif "mysql" in lowered:
        info["database"] = "MySQL"
    elif "sqlite" in lowered:
        info["database"] = "SQLite"
    elif "mongo" in lowered:
        info["database"] = "MongoDB"
    elif "firebase" in lowered:
        info["database"] = "Firebase"
    elif "supabase" in lowered:
        info["database"] = "Supabase"

    if any(token in lowered for token in ("로그인", "회원가입", "auth", "oauth", "sso", "jwt")):
        if any(token in lowered for token in ("로그인 없이", "no login", "비회원", "guest")):
            info["auth"] = "not_required"
        else:
            info["auth"] = "required"

    if "다크" in lowered or "dark" in lowered:
        info["ui_style"] = "dark"
    elif "미니멀" in lowered or "minimal" in lowered:
        info["ui_style"] = "minimal"
    elif "모던" in lowered or "modern" in lowered:
        info["ui_style"] = "modern"
    elif any(token in lowered for token in ("심플", "simple", "깔끔")):
        info["ui_style"] = "simple"

    if "기업" in lowered or "b2b" in lowered:
        info["target_users"] = "enterprise"
    elif "팀" in lowered:
        info["target_users"] = "team"
    elif "개인" in lowered or "personal" in lowered or "b2c" in lowered:
        info["target_users"] = "individual"
    elif "학생" in lowered:
        info["target_users"] = "students"

    return info


def _format_conversation_summary(conversation_history: List[Dict[str, Any]]) -> str:
    if not conversation_history:
        return "None"
    lines = []
    for qa in conversation_history:
        question = qa.get("question", "").strip()
        answer = qa.get("answer", "").strip()
        if question or answer:
            lines.append(f"- Q: {question} / A: {answer}")
    return "\n".join(lines) if lines else "None"


def run_conversational_rfi(
    goal: str,
    llm: Any,
    state: Dict[str, Any],
    mode: str = "thinking"
) -> Dict[str, Any]:
    """
    대화형 RFI 루프 (Thinking 모드)
    
    Args:
        goal: 사용자 목표
        llm: LLM 인스턴스
        state: 현재 상태
        mode: "thinking" 또는 "quick"
        
    Returns:
        {
            "rfi_phase": "asking" | "complete",
            "questions": [...],
            "refined_goal": str,
            ...
        }
    """
    logger.info(f"[RFI] Starting conversational RFI (mode={mode})...")
    rfi_start_time = time.time()
    
    # Quick 모드: RFI 스킵
    if mode == "quick":
        logger.info("[RFI] Quick mode - skipping conversational RFI")
        return {
            "rfi_phase": "complete",
            "refined_goal": goal,
            "conversation_history": [],
            "rfi_result": {}
        }
    
    # 기존 대화 히스토리 가져오기
    conversation_history = state.get("conversation_history", [])
    current_goal = state.get("refined_goal", goal)
    rfi_iteration = state.get("rfi_iteration", 0)
    
    # 최대 반복 횟수 체크
    if rfi_iteration >= MAX_RFI_ITERATIONS:
        logger.info("[RFI] Max iterations reached, finalizing...")
        return {
            "rfi_phase": "complete",
            "refined_goal": current_goal,
            "conversation_history": conversation_history,
            "rfi_result": extract_rfi_from_conversation(conversation_history)
        }
    
    # 🆕 첫 번째 반복이 아니면 (사용자가 이미 응답함) → LLM 호출 없이 바로 완료
    # 이렇게 하면 "go" 입력 후 불필요한 LLM 호출을 건너뜀
    if rfi_iteration > 0:
        logger.info(f"[RFI] User already responded, skipping LLM check (iteration={rfi_iteration})")
        return {
            "rfi_phase": "complete",
            "refined_goal": current_goal,
            "conversation_history": conversation_history,
            "rfi_result": extract_rfi_from_conversation(conversation_history)
        }
    
    # LLM에게 추가 질문 필요 여부 확인 - Professional RFI/RFP Analyst 스타일
    conversation_summary = _format_conversation_summary(conversation_history)
    context_text = _collect_context_text(current_goal, conversation_history)
    known_info = _infer_known_info(context_text)
    known_info_json = json.dumps(known_info, ensure_ascii=False)
    missing_topics = [key for key, value in known_info.items() if not value]

    prompt = f"""You are a Professional RFI/RFP Analyst. Evaluate this software project goal and gather missing specifications before the Orchestrator starts.

=== User Goal ===
{current_goal}

=== Previous Conversation (Q/A) - CRITICAL: DO NOT ASK ALREADY ANSWERED QUESTIONS ===
{conversation_summary}

=== Known Info (auto-detected, may be incomplete) ===
{known_info_json}

=== Missing Topics (guess) ===
{", ".join(missing_topics) if missing_topics else "none"}

Your task:
1. FIRST, review the Previous Conversation carefully. The user has ALREADY answered those questions.
2. If enough information has been gathered (platform, main features, tech preferences clarified), return needs_more_info: false.
3. If still unclear, ask ONE NEW question about something NOT YET DISCUSSED.

Guidance:
- **NEVER repeat a question that was already answered in Previous Conversation**
- If user provided detailed answers (like the multi-point responses), consider that sufficient and return needs_more_info: false
- Prefer domain-specific clarifications (data sources, workflows, compliance, user roles) over generic platform/stack questions
- Keep the question to 1 sentence.

=== Output JSON ===
{{
    "needs_more_info": true/false,
    "question": "질문 또는 확인 메시지 (1문장)",
    "options": ["옵션1", "옵션2"],
    "hint": "go/enter 안내 문구"
}}

Rules:
- If Previous Conversation has detailed answers, set needs_more_info: false
- If you cannot provide options, return an empty list
- Respond in KOREAN
- Output JSON ONLY
"""

    
    # 🆕 Retry logic (matching OrchestratorAgent.clarify_goal)
    MAX_RETRIES = 2
    last_error = None
    
    for attempt in range(MAX_RETRIES + 1):
        try:
            llm_start = time.time()
            response = _invoke_llm(llm, prompt)
            llm_elapsed = time.time() - llm_start
            logger.info(f"[RFI] LLM call completed in {llm_elapsed:.2f}s")
            
            if not response:
                logger.warning(f"[RFI] LLM returned empty response (attempt {attempt + 1}/{MAX_RETRIES + 1})")
                last_error = "empty_response"
                continue
            
            parsed = _parse_response(response)
            
            if not parsed:
                logger.warning(f"[RFI] Failed to parse response (attempt {attempt + 1}/{MAX_RETRIES + 1})")
                last_error = "parse_failed"
                continue

            if "needs_more_info" not in parsed and "clear" in parsed:
                parsed["needs_more_info"] = not bool(parsed.get("clear"))

            options = parsed.get("options", [])
            if not isinstance(options, list):
                options = []
            hint = parsed.get("hint") or DEFAULT_RFI_HINT
            question = (parsed.get("question") or "").strip()
            
            # Success - return result
            if parsed.get("needs_more_info", False):
                logger.info(f"[RFI] Question: {question or 'N/A'}")
                return {
                    "rfi_phase": "asking",
                    "rfi_question": question,
                    "rfi_options": options,
                    "rfi_hint": hint,
                    "conversation_history": conversation_history,
                    "current_goal": current_goal,
                    "rfi_iteration": rfi_iteration
                }
            else:
                rfi_elapsed = time.time() - rfi_start_time
                logger.info(f"[RFI] Sufficient information, completing RFI (total: {rfi_elapsed:.2f}s)")
                return {
                    "rfi_phase": "complete",
                    "refined_goal": current_goal,
                    "conversation_history": conversation_history,
                    "rfi_result": extract_rfi_from_conversation(conversation_history)
                }
                
        except Exception as e:
            logger.warning(f"[RFI] Error (attempt {attempt + 1}/{MAX_RETRIES + 1}): {e}")
            last_error = str(e)
            continue
    
    # All retries failed - return error with helpful message
    logger.error(f"[RFI] All {MAX_RETRIES + 1} attempts failed. Last error: {last_error}")
    return {
        "rfi_phase": "asking",
        "rfi_question": f"⚠️ 분석 중 오류가 발생했습니다. 다시 시도하거나 'go'를 입력하여 기본 설정으로 진행하세요. (오류: {last_error})",
        "rfi_options": ["go", "build"],
        "rfi_hint": DEFAULT_RFI_HINT,
        "conversation_history": conversation_history,
        "current_goal": current_goal,
        "rfi_iteration": rfi_iteration
    }


def process_user_rfi_answer(state: Dict[str, Any], user_answer: str) -> Dict[str, Any]:
    """
    사용자 RFI 답변 처리
    
    Args:
        state: 현재 상태
        user_answer: 사용자 답변
        
    Returns:
        {
            "action": "finalize" | "auto_complete" | "continue",
            "updated_goal": str,
            ...
        }
    """
    current_goal = state.get("current_goal") or state.get("refined_goal", "")
    conversation_history = state.get("conversation_history", [])
    rfi_question = state.get("rfi_question", "")
    rfi_iteration = state.get("rfi_iteration", 0)
    
    # 'go', 'build' 등 → RFI 종료
    normalized = user_answer.lower().strip()
    if is_go_command(normalized) or normalized in ["확인", "ok"]:
        logger.info("[RFI] User confirmed, finalizing RFI")
        return {
            "action": "finalize",
            "rfi_phase": "complete",
            "refined_goal": current_goal,
            "conversation_history": conversation_history,
            "rfi_result": extract_rfi_from_conversation(conversation_history)
        }
    
    # 빈 입력 → 자동 스펙 완성
    if not user_answer.strip():
        logger.info("[RFI] Empty answer, auto-completing specs")
        return {
            "action": "auto_complete",
            "rfi_phase": "complete",
            "refined_goal": current_goal,
            "conversation_history": conversation_history,
            "rfi_result": extract_rfi_from_conversation(conversation_history)
        }
    
    # 🆕 상세 답변 감지 (여러 줄, 200자 이상, 또는 번호 목록 포함)
    # 이 경우 사용자가 충분한 정보를 제공한 것으로 간주하고 RFI 완료
    line_count = len(user_answer.strip().split('\n'))
    has_numbered_list = any(line.strip().startswith(f"{i})") or line.strip().startswith(f"{i}.") 
                            for line in user_answer.split('\n') for i in range(1, 10))
    is_detailed_answer = len(user_answer) >= 200 or line_count >= 5 or has_numbered_list
    
    if is_detailed_answer:
        logger.info("[RFI] Detected detailed/comprehensive answer, completing RFI")
        # 상세 답변을 목표에 통합
        updated_goal = f"{current_goal}\n\n=== 사용자 상세 스펙 ===\n{user_answer}"
        conversation_history.append({
            "question": rfi_question or "상세 스펙 요청",
            "answer": user_answer
        })
        return {
            "action": "finalize",
            "rfi_phase": "complete",
            "refined_goal": updated_goal,
            "conversation_history": conversation_history,
            "rfi_result": extract_rfi_from_conversation(conversation_history)
        }
    
    # 일반 답변 → 대화 히스토리에 추가하고 계속
    conversation_history.append({
        "question": rfi_question,
        "answer": user_answer
    })
    
    # 목표에 답변 반영
    updated_goal = f"{current_goal}\n(추가 정보: {rfi_question} → {user_answer})"
    
    logger.info("[RFI] Answer recorded, continuing RFI")
    return {
        "action": "continue",
        "rfi_phase": "asking",
        "refined_goal": updated_goal,
        "conversation_history": conversation_history,
        "rfi_iteration": rfi_iteration + 1
    }


def extract_rfi_from_conversation(conversation_history: List[Dict]) -> Dict[str, Any]:
    """
    대화 히스토리에서 RFI 결과 추출
    
    Args:
        conversation_history: 질문-답변 리스트
        
    Returns:
        {
            "platform": "web" | "mobile" | "desktop",
            "language": "korean" | "english",
            "constraints": [...],
            "preferences": {}
        }
    """
    rfi_result = {
        "platform": "web",
        "language": "korean",
        "constraints": [],
        "preferences": {}
    }
    
    for qa in conversation_history:
        answer = qa.get("answer", "")
        answer_lower = answer.lower()
        question = qa.get("question", "").lower()
        
        # 플랫폼 관련
        if any(token in answer_lower for token in ["모바일", "ios", "android", "안드로이드", "아이폰"]):
            rfi_result["platform"] = "mobile"
        elif any(token in answer_lower for token in ["react native", "flutter"]):
            rfi_result["platform"] = "mobile"
        elif any(token in answer_lower for token in ["웹앱", "웹 앱", "웹", "브라우저", "web", "browser"]):
            rfi_result["platform"] = "web"
        elif any(token in answer_lower for token in ["데스크톱", "윈도우", "macos", "mac", "pc", "desktop"]):
            rfi_result["platform"] = "desktop"
        elif any(token in answer_lower for token in ["cli", "command line", "터미널", "커맨드라인"]):
            rfi_result["platform"] = "cli"
        
        # 언어 관련
        if "영어" in answer or "english" in answer_lower:
            rfi_result["language"] = "english"
        
        # 제약사항 수집
        if "제약" in question or "constraint" in question:
            rfi_result["constraints"].append(qa.get("answer", ""))
    
    return rfi_result


def _invoke_llm(llm: Any, prompt: str) -> Any:
    """LLM 호출 래퍼"""
    if hasattr(llm, 'invoke_structured'):
        return llm.invoke_structured(prompt)
    elif hasattr(llm, 'invoke'):
        return llm.invoke(prompt)
    elif callable(llm):
        return llm(prompt)
    raise ValueError("Unknown LLM interface")


def _parse_response(response: Any) -> Optional[Dict[str, Any]]:
    """LLM 응답 파싱"""
    if isinstance(response, dict):
        return response
    
    if isinstance(response, str):
        # ```json ... ``` 블록 추출
        json_match = re.search(r'```json\s*([\s\S]*?)\s*```', response)
        if json_match:
            try:
                return json.loads(json_match.group(1))
            except json.JSONDecodeError as e:
                logger.debug(f"[RFI] JSON block parse failed: {e}")
        
        # {...} 블록 추출
        brace_match = re.search(r'\{[\s\S]*\}', response)
        if brace_match:
            try:
                return json.loads(brace_match.group(0))
            except json.JSONDecodeError as e:
                logger.debug(f"[RFI] Brace block parse failed: {e}")
    
    return None

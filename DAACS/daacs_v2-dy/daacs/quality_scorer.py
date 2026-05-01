"""
Quality Scorer - LLM 기반 품질 점수화

프로젝트의 종합 품질을 10점 만점으로 평가합니다.

v7.2.0: KK에서 이식
"""

import json
import re
from dataclasses import dataclass, field
from typing import Dict, List, Any, Optional

import logging

logger = logging.getLogger("QualityScorer")


@dataclass
class QualityScore:
    """품질 점수 결과"""
    overall: float = 0.0  # 총점 (0-10)
    breakdown: Dict[str, float] = field(default_factory=dict)  # 항목별 점수
    issues: List[str] = field(default_factory=list)  # 발견된 문제
    strengths: List[str] = field(default_factory=list)  # 장점
    recommendation: str = "done"  # "done" | "backend_fix" | "frontend_fix" | "both_fix" | "replanning"
    summary: str = ""  # 평가 요약
    
    def to_dict(self) -> dict:
        return {
            "overall": self.overall,
            "breakdown": self.breakdown,
            "issues": self.issues,
            "strengths": self.strengths,
            "recommendation": self.recommendation,
            "summary": self.summary
        }
    
    @property
    def needs_replanning(self) -> bool:
        """리플래닝 필요 여부"""
        return self.overall < 5.0 or self.recommendation == "replanning"
    
    @property
    def needs_fix(self) -> bool:
        """수정 필요 여부"""
        return self.overall < 8.0 and self.recommendation in ["backend_fix", "frontend_fix", "both_fix"]


class QualityScorer:
    """
    LLM 기반 품질 평가
    
    평가 기준 (10점 만점):
    - 기능 완성도 (3점): 요구사항 충족, 핵심 기능 동작
    - UI/UX 품질 (3점): 디자인 일관성, 사용성, 반응형
    - 코드 품질 (2점): 모듈화, 가독성, 에러 핸들링
    - API 호환성 (2점): 프론트-백 통신, 에러 처리
    
    점수 기반 분기:
    - 8-10점: 완료 (done)
    - 6-7점: 부분 수정 (backend_fix / frontend_fix)
    - 5점 이하: 리플래닝 (replanning)
    """
    
    SCORING_CRITERIA = {
        "functionality": {
            "weight": 3,
            "description": "기능 완성도 - 요구사항 충족, 핵심 기능 동작"
        },
        "ui_ux": {
            "weight": 3,
            "description": "UI/UX 품질 - 디자인 일관성, 사용성, 반응형"
        },
        "code_quality": {
            "weight": 2,
            "description": "코드 품질 - 모듈화, 가독성, 에러 핸들링"
        },
        "api_compatibility": {
            "weight": 2,
            "description": "API 호환성 - 프론트-백 통신, 에러 처리"
        }
    }
    
    # Default fallback if no config provided
    DEFAULT_ALLOWED_EXTENSIONS = {
        # Python
        ".py", ".pyi",
        # Web
        ".js", ".jsx", ".ts", ".tsx", ".html", ".css", ".scss", 
        # Data & Config
        ".json", ".yaml", ".yml", ".toml", ".ini", ".env.example", ".xml", ".csv",
        # Database
        ".sql", 
        # Docs
        ".md", ".rst", ".txt",
        # Ops (User requested flexibility)
        ".sh", ".dockerignore", ".gitignore", ".conf"
    }
    
    THRESHOLD_DONE = 8.0
    THRESHOLD_FIX = 5.0
    
    def __init__(self, llm_client: Any = None):
        self.llm_client = llm_client
    
    def score(
        self,
        goal: str,
        visual_result: Optional[Dict] = None,
        runtime_result: Optional[Dict] = None,
        code_review: Optional[Dict] = None,
        api_contract: Optional[Dict] = None
    ) -> QualityScore:
        """
        종합 품질 점수 산출
        
        Args:
            goal: 프로젝트 목표
            visual_result: 시각적 검증 결과
            runtime_result: 런타임 검증 결과
            code_review: 코드 리뷰 결과
            api_contract: API 계약서
            
        Returns:
            QualityScore
        """
        # LLM이 있으면 LLM 기반 평가
        if self.llm_client:
            return self._score_with_llm(goal, visual_result, runtime_result, code_review, api_contract)
        
        # LLM이 없으면 규칙 기반 평가
        return self._score_rule_based(visual_result, runtime_result, code_review)
    
    def _score_rule_based(
        self,
        visual_result: Optional[Dict],
        runtime_result: Optional[Dict],
        code_review: Optional[Dict]
    ) -> QualityScore:
        """규칙 기반 점수 산출 (LLM 없이)"""
        result = QualityScore()
        breakdown = {}
        issues = []
        strengths = []
        
        # 1. 기능 완성도 (3점)
        func_score = 3.0
        if runtime_result:
            if not runtime_result.get("backend_running"):
                func_score -= 1.5
                issues.append("백엔드 서버 실행 실패")
            if not runtime_result.get("backend_health"):
                func_score -= 0.5
                issues.append("백엔드 헬스체크 실패")
            if not runtime_result.get("frontend_running"):
                func_score -= 1.0
                issues.append("프론트엔드 서버 실행 실패")
            if runtime_result.get("backend_running") and runtime_result.get("backend_health"):
                strengths.append("백엔드 서버 정상 동작")
            if runtime_result.get("frontend_running"):
                strengths.append("프론트엔드 서버 정상 동작")
        breakdown["functionality"] = max(0, func_score)
        
        # 2. UI/UX 품질 (3점)
        ui_score = 3.0
        if visual_result:
            if not visual_result.get("page_loaded"):
                ui_score -= 2.0
                issues.append("프론트엔드 페이지 로드 실패")
            console_errors = visual_result.get("console_errors", [])
            if console_errors:
                ui_score -= min(len(console_errors) * 0.3, 1.0)
                issues.append(f"콘솔 에러 {len(console_errors)}개 발견")
            if visual_result.get("screenshots"):
                strengths.append("스크린샷 캡처 성공")
            if visual_result.get("page_loaded") and not console_errors:
                strengths.append("프론트엔드 정상 렌더링")
        else:
            ui_score = 1.5  # 검증 못함 = 절반
            issues.append("시각적 검증 수행되지 않음")
        breakdown["ui_ux"] = max(0, ui_score)
        
        # 3. 코드 품질 (2점)
        code_score = 2.0
        if code_review:
            if not code_review.get("goal_achieved"):
                code_score -= 1.0
                issues.append("목표 달성 미흡")
            if code_review.get("issues"):
                code_score -= min(len(code_review["issues"]) * 0.2, 0.6)
        breakdown["code_quality"] = max(0, code_score)
        
        # 4. API 호환성 (2점)
        api_score = 2.0
        if code_review:
            if not code_review.get("api_compatible"):
                api_score -= 1.5
                issues.append("API 호환성 문제")
            else:
                strengths.append("API 호환성 확인됨")
        if runtime_result:
            api_endpoints = runtime_result.get("api_endpoints", [])
            failed_endpoints = [ep for ep in api_endpoints if not ep.get("passed")]
            if failed_endpoints:
                api_score -= min(len(failed_endpoints) * 0.2, 0.5)
                issues.append(f"API 엔드포인트 {len(failed_endpoints)}개 실패")
        breakdown["api_compatibility"] = max(0, api_score)
        
        # 총점 계산
        result.overall = round(sum(breakdown.values()), 2)
        result.breakdown = breakdown
        result.issues = issues
        result.strengths = strengths
        
        # 권장 액션 결정
        result.recommendation = self._determine_recommendation(
            result.overall, breakdown, runtime_result, visual_result
        )
        
        # 요약 생성
        result.summary = self._generate_summary(result)
        
        return result
    
    def _score_with_llm(
        self,
        goal: str,
        visual_result: Optional[Dict],
        runtime_result: Optional[Dict],
        code_review: Optional[Dict],
        api_contract: Optional[Dict]
    ) -> QualityScore:
        """LLM 기반 점수 산출"""
        prompt = self._build_scoring_prompt(goal, visual_result, runtime_result, code_review, api_contract)
        
        try:
            # LLM 호출
            response = self.llm_client.invoke(prompt)
            
            # 응답 파싱
            return self._parse_llm_response(response)
            
        except Exception as e:
            logger.error(f"LLM scoring failed: {e}, falling back to rule-based")
            return self._score_rule_based(visual_result, runtime_result, code_review)
    
    def _build_scoring_prompt(
        self,
        goal: str,
        visual_result: Optional[Dict],
        runtime_result: Optional[Dict],
        code_review: Optional[Dict],
        api_contract: Optional[Dict]
    ) -> str:
        """LLM 프롬프트 생성"""
        
        # 스크린샷 경로 추출
        screenshot_section = ""
        if visual_result and visual_result.get("screenshots"):
            screenshots = visual_result.get("screenshots", [])
            if screenshots:
                screenshot_section = f"""
## 🖼️ UI 스크린샷 (직접 확인하세요)
다음 스크린샷을 보고 UI/UX 품질을 평가해주세요:
{screenshots[0]}

평가 항목:
1. 디자인이 전문적이고 깔끔한가?
2. 레이아웃이 직관적인가?
3. 색상 조합이 적절한가?
4. 명백한 UI 버그가 있는가?
"""
        
        return f"""
프로젝트 품질을 10점 만점으로 평가해주세요.

## 프로젝트 목표
{goal}
{screenshot_section}
## 검증 결과

### 런타임 검증
{json.dumps(runtime_result or {}, ensure_ascii=False, indent=2)}

### 시각적 검증
{json.dumps(visual_result or {}, ensure_ascii=False, indent=2)}

### 코드 리뷰
{json.dumps(code_review or {}, ensure_ascii=False, indent=2)}

## 평가 기준
- functionality (3점): 기능 완성도
- ui_ux (3점): UI/UX 품질
- code_quality (2점): 코드 품질
- api_compatibility (2점): API 호환성

## 응답 형식 (JSON)
{{
    "overall": <총점 0-10>,
    "breakdown": {{
        "functionality": <0-3>,
        "ui_ux": <0-3>,
        "code_quality": <0-2>,
        "api_compatibility": <0-2>
    }},
    "issues": ["문제1", "문제2"],
    "strengths": ["장점1", "장점2"],
    "recommendation": "done" | "backend_fix" | "frontend_fix" | "both_fix" | "replanning",
    "summary": "한 줄 요약"
}}
"""
    
    def _parse_llm_response(self, response: str) -> QualityScore:
        """LLM 응답 파싱"""
        try:
            # JSON 추출
            json_match = re.search(r'\{[\s\S]*\}', response)
            if json_match:
                data = json.loads(json_match.group())
                return QualityScore(
                    overall=data.get("overall", 5.0),
                    breakdown=data.get("breakdown", {}),
                    issues=data.get("issues", []),
                    strengths=data.get("strengths", []),
                    recommendation=data.get("recommendation", "done"),
                    summary=data.get("summary", "")
                )
        except Exception as e:
            logger.error(f"Failed to parse LLM response: {e}")
        
        return QualityScore(overall=5.0, recommendation="replanning")
    
    def _determine_recommendation(
        self,
        overall: float,
        breakdown: Dict[str, float],
        runtime_result: Optional[Dict],
        visual_result: Optional[Dict]
    ) -> str:
        """권장 액션 결정"""
        if overall >= self.THRESHOLD_DONE:
            return "done"
        
        if overall < self.THRESHOLD_FIX:
            return "replanning"
        
        # 6-7점대: 어디를 수정할지 결정
        backend_issues = False
        frontend_issues = False
        
        if runtime_result:
            if not runtime_result.get("backend_running") or not runtime_result.get("backend_health"):
                backend_issues = True
        
        if visual_result:
            if not visual_result.get("page_loaded") or visual_result.get("console_errors"):
                frontend_issues = True
        
        if breakdown.get("functionality", 0) < 2.0:
            backend_issues = True
        
        if breakdown.get("ui_ux", 0) < 2.0:
            frontend_issues = True
        
        if backend_issues and frontend_issues:
            return "both_fix"
        elif backend_issues:
            return "backend_fix"
        elif frontend_issues:
            return "frontend_fix"
        else:
            return "done"  # 명확한 문제 없으면 완료
    
    def _generate_summary(self, result: QualityScore) -> str:
        """평가 요약 생성"""
        score = result.overall
        if score >= 8.0:
            return f"프로젝트 완성도 우수 ({score}/10). 배포 준비 완료."
        elif score >= 6.0:
            return f"부분 수정 필요 ({score}/10). {result.recommendation} 권장."
        else:
            return f"품질 미달 ({score}/10). 재설계 필요."

    def score_code_content(self, code: str) -> Dict[str, Any]:
        """Score a single code file content (Simple Heuristic for Agent Review)"""
        score = 5.0
        feedback = []
        
        if not code:
            return {"score": 0, "feedback": "Empty code"}
            
        # Heuristics
        if len(code) > 50: score += 1.0 # Content length
        if "def " in code or "class " in code: score += 1.0 # Structure
        if "try:" in code and "except" in code: score += 1.0 # Error handling
        if '"""' in code or "'''" in code: score += 1.0 # Docstrings
        if "import " in code: score += 0.5 # Imports
        if "logger" in code or "print" in code: score += 0.5 # Logging
        
        # Cap at 10
        score = min(10.0, score)
        
        if score < 6.0: feedback.append("Basic implementation, lacks robustness")
        else: feedback.append("Good code structure and practices")
        
        return {"score": score, "feedback": ", ".join(feedback)}

    def check_constraints(self, code: str, constraints: Dict[str, Any]) -> List[str]:
        """Check if code meets specific constraints (Port, API Prefix, etc.)"""
        violations = []
        
        # 1. Port Check
        expected_port = str(constraints.get("port", "8000"))
        if "run" in code or "listen" in code or "port" in code:
            if expected_port not in code:
                # Simple check: is the port number present?
                violations.append(f"Port {expected_port} not found in code (Critical)")
        
        # 2. API Prefix Check
        expected_prefix = constraints.get("api_prefix", "/api")
        if "FastAPI" in code or "route" in code:
            if expected_prefix not in code:
                violations.append(f"API Prefix '{expected_prefix}' not found in routes")
                
        return violations

    def check_file_extension(self, filename: str, allowed_extensions: set = None) -> bool:
        """Check if file extension is allowed. Uses provided set or default."""
        if not filename or "." not in filename:
            # Files without extension (e.g. Dockerfile, Makefile) are tricky. 
            # For now allow specific known ones or block. 
            # Let's allow Dockerfile/Makefile explicitly if needed, otherwise assume safe to avoid over-blocking.
            # User wants flexibility.
            return True 
            
        ext = "." + filename.split(".")[-1].lower()
        allowed = allowed_extensions if allowed_extensions else self.DEFAULT_ALLOWED_EXTENSIONS
        return ext in allowed


def score_project(
    goal: str,
    visual_result: Dict = None,
    runtime_result: Dict = None,
    code_review: Dict = None,
    llm_client: Any = None
) -> QualityScore:
    """간단한 함수형 인터페이스"""
    scorer = QualityScorer(llm_client)
    return scorer.score(goal, visual_result, runtime_result, code_review)

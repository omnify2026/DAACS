"""
DAACS v6.0 - Replanning Strategies
v5.0 재계획 전략을 v6.0 LangGraph로 마이그레이션
"""

from typing import Dict, List, Optional, Any
from .replanning_config import REPLANNING_STRATEGIES, DEFAULT_STRATEGY

class ReplanningStrategies:
    """
    v5.0 재계획 전략을 v6.0 LangGraph로 마이그레이션

    실패 유형에 따라 적절한 next_actions를 제안
    """

    @staticmethod
    def get_strategy(failure_type: Optional[str]) -> Dict[str, Any]:
        """
        실패 유형에 맞는 전략 반환
        """
        if not failure_type:
            return DEFAULT_STRATEGY

        return REPLANNING_STRATEGIES.get(failure_type, {
            **DEFAULT_STRATEGY,
            "reason": f"Unknown failure type: {failure_type}"
        })

    @staticmethod
    def should_stop(
        failure_type: Optional[str],
        consecutive_failures: int,
        max_failures: int
    ) -> bool:
        """
        재계획을 중단해야 하는지 판단
        """
        # 1. 권한 오류 → 즉시 중단
        strategy = ReplanningStrategies.get_strategy(failure_type)
        if strategy["stop"]:
            return True

        # 2. 연속 실패 상한 도달
        if consecutive_failures >= max_failures:
            return True

        # 3. 치명적 오류 (severity=critical)
        if strategy.get("severity") == "critical":
            return True

        return False

    @staticmethod
    def create_replan_response(
        failure_type: Optional[str],
        current_goal: str,
        consecutive_failures: int,
        max_failures: int,
        context: Optional[Dict] = None
    ) -> Dict[str, Any]:
        """
        재계획 응답 생성
        """
        strategy = ReplanningStrategies.get_strategy(failure_type)

        # 중단 여부 판단
        should_stop = ReplanningStrategies.should_stop(
            failure_type,
            consecutive_failures,
            max_failures
        )

        if should_stop:
            return {
                "stop": True,
                "reason": strategy["reason"],
                "next_goal": None,
                "next_actions": [],
                "needs_rework": False
            }

        # 재계획 계속
        return {
            "stop": False,
            "reason": strategy["reason"],
            "next_goal": current_goal,  # 목표는 유지
            "next_actions": strategy["next_actions"],
            "needs_rework": True,
            "severity": strategy.get("severity", "medium")
        }


def detect_failure_type(
    failure_summary: List[str],
    result: str
) -> Optional[str]:
    """
    실패 요약과 결과에서 실패 유형 감지
    Enhanced with more specific detection patterns
    """
    summary_text = " ".join(failure_summary).lower()
    
    # 순서 중요 (특정 실패가 더 우선순위 높음)
    
    # Combine summary and logs for better detection
    combined_text = (summary_text + " " + result.lower())
    
    # 1. 권한 오류 → 즉시 중단
    if "permission" in combined_text or "operation not permitted" in combined_text:
        return "permission_denied"

    # 2. 런타임/스모크/엔트리포인트 (서비스 실행 관련)
    if "runtime_error" in summary_text or "runtime verification" in summary_text:
        return "runtime_error"
    if "frontend_smoke_failed" in summary_text or "smoke test" in summary_text:
        return "frontend_smoke_failed"
    if "entrypoint" in summary_text or "frontend_entrypoint" in summary_text:
        return "frontend_entry_missing"
        
    # 3. Code Review 실패 (품질 미달)
    if "code_review_failed" in summary_text or "code_review_critical" in summary_text:
        return "quality_issue"
    if "code_review_goal_misalignment" in summary_text:
        return "goal_miss"
        
    # 4. 파일 생성/파싱 실패
    if "no files collected" in summary_text or "file parsing failed" in summary_text:
        return "codegen_fail"
    if "missing files" in summary_text or "empty files" in summary_text:
        return "codegen_fail"
    if "no_progress" in summary_text:
        return "no_progress"
    
    # 5. 일관성/호환성/네트워크 실패 (Phase 4 Trigger)
    if "consistency" in summary_text or "compatibility" in summary_text:
        return "endpoint_mismatch"
    
    # 🆕 Check logs for Network Errors (Phase 4 Trigger)
    network_keywords = ["404 not found", "connection refused", "network error", "fetch failed", "econnnrefused"]
    if any(k in combined_text for k in network_keywords):
        return "endpoint_mismatch"
        
    # 6. 빌드/배포/테스트/린트 (품질 관련)
    if "deploy" in summary_text: return "deploy_fail"
    if "build" in summary_text: return "build_fail"
    if "refactor" in summary_text: return "refactor_fail"
    if "tests" in summary_text or "test failed" in summary_text:
        if "build failed" not in summary_text and "deploy failed" not in summary_text:
            return "tests_fail"
    if "lint" in summary_text: return "lint_fail"

    # 7. 기타
    if "quality" in summary_text or "score" in summary_text: return "quality_issue"
    if "goal" in summary_text or "missing_feature" in summary_text: return "goal_miss"
    if "endpoint" in summary_text or "api" in summary_text: return "endpoint_mismatch"

    # 기본값
    return "verify_fail"


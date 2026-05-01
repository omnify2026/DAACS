from typing import Any, Dict

ENHANCED_FAILURE_STRATEGIES = {
    "semantic_mismatch": {
        "stop": False,
        "max_retries": 2,
        "action": "Review the goal and regenerate code to match requirements",
        "suggestions": [
            "Re-read the goal carefully",
            "Remove default template code",
            "Implement actual feature logic",
        ],
    },
    "integration_failure": {
        "stop": False,
        "max_retries": 2,
        "action": "Fix API integration between frontend and backend",
        "suggestions": [
            "Verify endpoint paths match",
            "Check request/response formats",
            "Add error handling",
        ],
    },
    "performance_degradation": {
        "stop": False,
        "max_retries": 1,
        "action": "Optimize code for better performance",
        "suggestions": [
            "Reduce bundle size",
            "Remove unused dependencies",
            "Optimize database queries",
        ],
    },
    "runtime_error": {
        "stop": False,
        "max_retries": 2,
        "action": "Fix runtime errors",
        "suggestions": [
            "Check for missing imports",
            "Verify environment setup",
            "Fix syntax errors",
        ],
    },
    "e2e_test_failure": {
        "stop": False,
        "max_retries": 1,
        "action": "Fix end-to-end test failures",
        "suggestions": [
            "Verify UI elements exist",
            "Check async operations",
            "Update test selectors",
        ],
    },
}


def detect_enhanced_failure_type(
    verification_results: Dict[str, Any],
    goal: str,
) -> str:
    """고급 실패 유형 감지"""

    # semantic_consistency 실패
    if "semantic_consistency" in str(verification_results):
        issues = verification_results.get("issues", [])
        if any(i.get("category") == "goal_mismatch" for i in issues):
            return "semantic_mismatch"

    # runtime 테스트 실패
    if "runtime_test" in str(verification_results):
        if not verification_results.get("ok", True):
            return "runtime_error"

    # 성능 기준 초과
    if "performance_baseline" in str(verification_results):
        metrics = verification_results.get("metrics", [])
        if any(not m.get("passed", True) for m in metrics):
            return "performance_degradation"

    # 일관성 실패
    if "consistency" in str(verification_results):
        if not verification_results.get("ok", True):
            return "integration_failure"

    return "unknown"


def get_enhanced_replan_strategy(failure_type: str) -> Dict[str, Any]:
    """실패 유형에 맞는 재계획 전략 반환"""
    return ENHANCED_FAILURE_STRATEGIES.get(
        failure_type,
        {
            "stop": False,
            "max_retries": 2,
            "action": "Review and fix the issue",
            "suggestions": ["Check error messages", "Review code logic"],
        },
    )

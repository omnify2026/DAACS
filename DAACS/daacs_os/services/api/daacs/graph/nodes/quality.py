"""
DAACS OS — Quality Scoring Node
코드 리뷰 점수 + 목표 정렬 확인 → 종합 품질 평가.

Source: DAACS_v2-dy/daacs/graph/workflow_wrappers.py (quality_scoring)
"""
import logging
from typing import Any, Dict

logger = logging.getLogger("daacs.graph.nodes.quality")


async def quality_scoring_node(
    state: Dict[str, Any],
    executor=None,
    manager=None,
) -> Dict[str, Any]:
    """
    Quality Scoring Node — 종합 품질 점수 산정.

    입력:
    - code_review_score (review 노드에서 생성)
    - verification_passed (verification 노드에서 생성)
    - backend/frontend 상태

    출력:
    - quality_score (0-100)
    - quality_gate_failed (bool)
    """
    review_score = state.get("code_review_score", 0)  # 0-10
    verification_passed = state.get("verification_passed", False)
    backend_status = state.get("backend_status", "pending")
    frontend_status = state.get("frontend_status", "pending")
    needs_backend = state.get("needs_backend", True)
    needs_frontend = state.get("needs_frontend", True)

    # 가중 점수 계산
    # Code review: 50%
    review_component = review_score * 5  # 0-50

    # Verification: 30%
    verification_component = 30 if verification_passed else 0

    # Completion: 20%
    completion = 0
    if needs_backend and backend_status == "completed":
        completion += 10
    if needs_frontend and frontend_status == "completed":
        completion += 10
    if not needs_backend:
        completion += 10
    if not needs_frontend:
        completion += 10

    quality_score = review_component + verification_component + completion
    quality_gate_failed = quality_score < 60  # 60점 미만 = 실패

    logger.info(
        f"[Quality] Score={quality_score}/100 "
        f"(review={review_component} + verification={verification_component} + completion={completion}), "
        f"gate_failed={quality_gate_failed}"
    )

    return {
        "quality_score": quality_score,
        "quality_gate_failed": quality_gate_failed,
    }

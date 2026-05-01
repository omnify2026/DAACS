import os
import re
from dataclasses import asdict
from typing import Any, Dict, List, Optional

from ..utils import setup_logger
from .enhanced_verification_types import SemanticIssue

logger = setup_logger("EnhancedVerification")


def semantic_consistency(
    goal: str,
    files: List[str],
    llm_client: Optional[Any] = None,
) -> Dict[str, Any]:
    """
    코드가 목표와 의미적으로 일치하는지 검증

    Args:
        goal: 사용자 목표
        files: 검증할 파일 목록
        llm_client: LLM 클라이언트 (없으면 휴리스틱 사용)

    Returns:
        검증 결과
    """
    issues: List[SemanticIssue] = []

    # 파일 내용 수집
    file_contents: Dict[str, str] = {}
    for f in files[:10]:  # 최대 10개 파일
        if os.path.exists(f):
            try:
                with open(f, "r", encoding="utf-8", errors="ignore") as file:
                    file_contents[f] = file.read()[:2000]  # 각 파일 2000자까지
            except OSError:
                logger.debug("Failed to read file for semantic consistency: %s", f, exc_info=True)

    if not file_contents:
        return {
            "ok": False,
            "reason": "No files to verify",
            "template": "semantic_consistency",
            "issues": [],
        }

    # 목표 키워드 추출
    goal_lower = goal.lower()

    # 휴리스틱 기반 검증 (LLM 없이)
    all_content = "\n".join(file_contents.values()).lower()

    # 1. 기능 키워드 검증
    feature_keywords = _extract_feature_keywords(goal_lower)
    missing_features = []
    for keyword in feature_keywords:
        if keyword.lower() not in all_content:
            missing_features.append(keyword)

    if missing_features:
        issues.append(
            SemanticIssue(
                severity="warning",
                category="missing_feature",
                description=f"Expected features not found: {missing_features}",
                suggestion=f"Implement: {', '.join(missing_features)}",
            )
        )

    # 2. 기본 템플릿/스캐폴드 감지
    scaffold_indicators = [
        "edit src/app.jsx and save to test hmr",
        "click on the vite and react logos",
        "learn react",
        "count is {count}",
        "hello world",
        "welcome to react",
        "hello, world",
    ]

    for indicator in scaffold_indicators:
        if indicator in all_content:
            issues.append(
                SemanticIssue(
                    severity="critical",
                    category="goal_mismatch",
                    description=f"Default template detected: '{indicator[:30]}...'",
                    suggestion="Replace default template with actual implementation",
                )
            )
            break

    # 3. 빈 함수/클래스 감지
    empty_patterns = [
        r"def \w+\([^)]*\):\s*pass\s*$",
        r"def \w+\([^)]*\):\s*\.\.\.\s*$",
        r"function \w+\([^)]*\)\s*\{\s*\}",
    ]

    for pattern in empty_patterns:
        for filename, content in file_contents.items():
            if re.search(pattern, content):
                issues.append(
                    SemanticIssue(
                        severity="warning",
                        category="logic_error",
                        description="Empty function/method detected",
                        file=os.path.basename(filename),
                        suggestion="Implement function logic",
                    )
                )
                break

    # 4. TODO/FIXME 감지
    todo_count = all_content.count("todo") + all_content.count("fixme")
    if todo_count > 3:
        issues.append(
            SemanticIssue(
                severity="info",
                category="incomplete",
                description=f"{todo_count} TODO/FIXME comments found",
                suggestion="Complete pending implementations",
            )
        )

    # 결과 생성
    critical_issues = [i for i in issues if i.severity == "critical"]
    passed = len(critical_issues) == 0

    # Safely convert issues to dict
    def safe_asdict(item):
        try:
            return asdict(item) if hasattr(item, "__dataclass_fields__") else item
        except (TypeError, AttributeError):
            return {"error": "Failed to serialize issue"}

    return {
        "ok": passed,
        "reason": f"{len(issues)} issues found, {len(critical_issues)} critical" if issues else "Semantic check passed",
        "template": "semantic_consistency",
        "issues": [safe_asdict(i) for i in issues],
        "feature_coverage": len(feature_keywords) - len(missing_features),
        "total_features": len(feature_keywords),
    }


def _extract_feature_keywords(goal: str) -> List[str]:
    """목표에서 기능 키워드 추출"""
    keywords = []

    # 일반적인 기능 키워드 매핑
    feature_map = {
        "계산": ["calculate", "result", "add", "subtract", "multiply", "divide", "+", "-"],
        "calculator": ["calculate", "result", "add", "subtract", "multiply", "divide"],
        "todo": ["task", "add", "delete", "complete", "list", "checkbox"],
        "할 일": ["task", "add", "delete", "complete", "list"],
        "로그인": ["login", "password", "email", "signin", "auth"],
        "login": ["password", "email", "signin", "auth", "session"],
        "검색": ["search", "query", "filter", "results"],
        "search": ["query", "filter", "results", "input"],
        "게시판": ["post", "list", "create", "delete", "edit", "comment"],
        "board": ["post", "list", "create", "delete", "edit"],
        "채팅": ["chat", "message", "send", "receive", "room"],
        "chat": ["message", "send", "receive", "room", "user"],
        "대시보드": ["chart", "graph", "data", "table", "stats"],
        "dashboard": ["chart", "graph", "data", "table", "statistics"],
        "api": ["endpoint", "route", "get", "post", "response"],
        "crud": ["create", "read", "update", "delete", "list"],
    }

    for trigger, features in feature_map.items():
        if trigger in goal:
            keywords.extend(features)

    # 기본 UI 요소 (항상 체크)
    if any(k in goal for k in ["웹", "web", "앱", "app", "ui", "페이지", "page"]):
        keywords.extend(["button", "form", "input"])

    return list(set(keywords))

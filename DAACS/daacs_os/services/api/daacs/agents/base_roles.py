"""
DAACS OS — Agent Role Definitions
9종 에이전트 역할, GUI Prototype store.ts AGENT_META와 1:1 매핑
"""
from enum import Enum
from typing import Any, Dict


class AgentRole(str, Enum):
    CEO = "ceo"
    PM = "pm"
    DEVELOPER = "developer"
    REVIEWER = "reviewer"
    VERIFIER = "verifier"
    DEVOPS = "devops"
    MARKETER = "marketer"
    DESIGNER = "designer"
    CFO = "cfo"


class AgentStatus(str, Enum):
    """GUI AgentSprite.tsx 상태와 1:1 매핑"""
    IDLE = "idle"
    WALKING = "walking"
    WORKING = "working"
    MEETING = "meeting"
    ERROR = "error"
    CELEBRATING = "celebrating"


# GUI store.ts AGENT_META 1:1 매핑
AGENT_META: Dict[AgentRole, Dict[str, Any]] = {
    AgentRole.CEO: {
        "display_name": "대표님",
        "title": "CEO",
        "color": "#8B5CF6",
        "icon": "Crown",
        "default_messages": ["전략 검토 중...", "보고서 확인 중...", "비전 구상 중..."],
    },
    AgentRole.PM: {
        "display_name": "기획자",
        "title": "PM",
        "color": "#6366F1",
        "icon": "ClipboardList",
        "default_messages": ["일정 조율 중...", "스프린트 계획 중...", "요구사항 분석 중..."],
    },
    AgentRole.DEVELOPER: {
        "display_name": "개발자",
        "title": "Developer",
        "color": "#3B82F6",
        "icon": "Code",
        "default_messages": ["코딩 중...", "디버깅 중...", "리팩토링 중..."],
    },
    AgentRole.REVIEWER: {
        "display_name": "리뷰어",
        "title": "Reviewer",
        "color": "#EF4444",
        "icon": "Search",
        "default_messages": ["코드 리뷰 중...", "버그 찾는 중...", "품질 검사 중..."],
    },
    AgentRole.VERIFIER: {
        "display_name": "검증관",
        "title": "Verifier",
        "color": "#14B8A6",
        "icon": "ShieldCheck",
        "default_messages": ["테스트 실행 중...", "빌드 검증 중...", "증거 수집 중..."],
    },
    AgentRole.DEVOPS: {
        "display_name": "운영자",
        "title": "DevOps",
        "color": "#10B981",
        "icon": "Terminal",
        "default_messages": ["배포 중...", "서버 모니터링 중...", "파이프라인 구성 중..."],
    },
    AgentRole.MARKETER: {
        "display_name": "마케터",
        "title": "Marketer",
        "color": "#EC4899",
        "icon": "Megaphone",
        "default_messages": ["SEO 분석 중...", "콘텐츠 작성 중...", "시장 조사 중..."],
    },
    AgentRole.DESIGNER: {
        "display_name": "디자이너",
        "title": "Designer",
        "color": "#F97316",
        "icon": "Palette",
        "default_messages": ["디자인 중...", "UI 검토 중...", "에셋 제작 중..."],
    },
    AgentRole.CFO: {
        "display_name": "재무관",
        "title": "CFO",
        "color": "#EAB308",
        "icon": "Calculator",
        "default_messages": ["수익 분석 중...", "예산 편성 중...", "비용 최적화 중..."],
    },
}

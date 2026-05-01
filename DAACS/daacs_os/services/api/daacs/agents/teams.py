"""
DAACS OS — Agent Teams
에이전트를 업무 팀 단위로 묶어 병렬 실행하기 위한 정의.
"""
from enum import Enum
from typing import Any, Dict, List

from .base_roles import AgentRole


class AgentTeam(str, Enum):
    DEVELOPMENT_TEAM = "development_team"
    REVIEW_TEAM = "review_team"
    MARKETING_TEAM = "marketing_team"
    OPERATIONS_TEAM = "operations_team"
    EXECUTIVE_TEAM = "executive_team"


TEAM_ROLES: Dict[AgentTeam, List[AgentRole]] = {
    AgentTeam.DEVELOPMENT_TEAM: [
        AgentRole.DEVELOPER,
    ],
    AgentTeam.REVIEW_TEAM: [
        AgentRole.REVIEWER,
        AgentRole.VERIFIER,
    ],
    AgentTeam.MARKETING_TEAM: [
        AgentRole.MARKETER,
        AgentRole.DESIGNER,
        AgentRole.CFO,
        AgentRole.CEO,
    ],
    AgentTeam.OPERATIONS_TEAM: [
        AgentRole.DEVOPS,
    ],
    AgentTeam.EXECUTIVE_TEAM: [
        AgentRole.CEO,
        AgentRole.PM,
        AgentRole.CFO,
    ],
}

TEAM_META: Dict[AgentTeam, Dict[str, Any]] = {
    AgentTeam.DEVELOPMENT_TEAM: {
        "display_name": "개발팀",
        "description": "핵심 구현을 담당하는 개발 팀",
    },
    AgentTeam.REVIEW_TEAM: {
        "display_name": "리뷰팀",
        "description": "리뷰어/검증관 중심의 품질 검증 팀",
    },
    AgentTeam.MARKETING_TEAM: {
        "display_name": "마케팅팀",
        "description": "마케팅/디자인/비용 검토를 묶은 캠페인 팀",
    },
    AgentTeam.OPERATIONS_TEAM: {
        "display_name": "운영팀",
        "description": "배포와 운영 안정화를 담당하는 팀",
    },
    AgentTeam.EXECUTIVE_TEAM: {
        "display_name": "경영팀",
        "description": "CEO/PM/CFO 의사결정 팀",
    },
}


def get_team_roles(team: AgentTeam) -> List[AgentRole]:
    return TEAM_ROLES.get(team, [])


def list_teams() -> List[Dict[str, Any]]:
    result: List[Dict[str, Any]] = []
    for team, roles in TEAM_ROLES.items():
        meta = TEAM_META.get(team, {})
        result.append(
            {
                "team": team.value,
                "display_name": meta.get("display_name", team.value),
                "description": meta.get("description", ""),
                "roles": [role.value for role in roles],
            }
        )
    return result

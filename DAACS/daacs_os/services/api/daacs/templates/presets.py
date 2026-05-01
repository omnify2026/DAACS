"""
DAACS OS — Project Presets (5종)
새 프로젝트 시작 시 원클릭 세팅.

각 프리셋은 다음을 정의:
  - 활성화할 에이전트 (9명 중 선택)
  - 초기 워크플로우
  - 초기 태스크
  - 에이전트별 우선순위 (tier override)
  - 예산 설정 (일일 상한)
"""
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


@dataclass
class PresetTask:
    """프리셋 초기 태스크"""
    title: str
    assignee: str  # AgentRole value
    depends_on: List[str] = field(default_factory=list)
    priority: str = "medium"  # low | medium | high | critical


@dataclass
class PresetWorkflow:
    """프리셋 초기 워크플로우"""
    name: str
    auto_start: bool = False


@dataclass
class ProjectPreset:
    """프로젝트 프리셋 정의"""
    id: str
    name: str
    description: str
    icon: str
    active_agents: List[str]  # AgentRole values
    workflows: List[PresetWorkflow] = field(default_factory=list)
    initial_tasks: List[PresetTask] = field(default_factory=list)
    daily_budget_usd: float = 1.00
    tier_overrides: Dict[str, str] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "icon": self.icon,
            "active_agents": self.active_agents,
            "workflows": [{"name": w.name, "auto_start": w.auto_start} for w in self.workflows],
            "initial_tasks": [
                {"title": t.title, "assignee": t.assignee, "depends_on": t.depends_on, "priority": t.priority}
                for t in self.initial_tasks
            ],
            "daily_budget_usd": self.daily_budget_usd,
            "tier_overrides": self.tier_overrides,
        }


# ─── 5종 프리셋 정의 ───

PRESETS: Dict[str, ProjectPreset] = {

    # 1. SaaS 스타트업 — 풀 팀
    "saas_startup": ProjectPreset(
        id="saas_startup",
        name="SaaS 스타트업",
        description="MVP부터 출시까지. 9명 전원 투입, 기능 개발 워크플로우 자동 시작.",
        icon="Rocket",
        active_agents=["ceo", "pm", "developer", "reviewer", "verifier", "devops", "marketer", "designer", "cfo"],
        workflows=[
            PresetWorkflow(name="feature_development", auto_start=True),
        ],
        initial_tasks=[
            PresetTask(title="PRD 작성", assignee="pm", priority="high"),
            PresetTask(title="와이어프레임 디자인", assignee="designer", depends_on=["PRD 작성"]),
            PresetTask(title="백엔드 API 개발", assignee="developer", depends_on=["PRD 작성"], priority="high"),
            PresetTask(title="프론트엔드 개발", assignee="developer", depends_on=["와이어프레임 디자인"]),
            PresetTask(title="코드 리뷰", assignee="reviewer", depends_on=["백엔드 API 개발", "프론트엔드 개발"]),
            PresetTask(title="테스트 및 검증", assignee="verifier", depends_on=["코드 리뷰", "CI/CD 파이프라인 세팅"]),
            PresetTask(title="CI/CD 파이프라인 세팅", assignee="devops"),
            PresetTask(title="랜딩 페이지 카피", assignee="marketer"),
            PresetTask(title="비용 계획 수립", assignee="cfo"),
        ],
        daily_budget_usd=2.00,
    ),

    # 2. 쇼핑몰 — 커머스 특화
    "ecommerce": ProjectPreset(
        id="ecommerce",
        name="쇼핑몰",
        description="상품 페이지, 결제, 마케팅 집중. 디자이너 + 마케터 강화.",
        icon="ShoppingCart",
        active_agents=["pm", "developer", "reviewer", "verifier", "devops", "marketer", "designer", "cfo"],
        workflows=[
            PresetWorkflow(name="feature_development", auto_start=True),
            PresetWorkflow(name="marketing_campaign"),
        ],
        initial_tasks=[
            PresetTask(title="상품 DB 스키마 설계", assignee="developer", priority="high"),
            PresetTask(title="상품 상세 페이지 디자인", assignee="designer", priority="high"),
            PresetTask(title="결제 모듈 통합", assignee="developer", depends_on=["상품 DB 스키마 설계"]),
            PresetTask(title="결제/주문 플로우 검증", assignee="verifier", depends_on=["결제 모듈 통합"]),
            PresetTask(title="SEO 최적화 전략", assignee="marketer"),
            PresetTask(title="PG사 비용 분석", assignee="cfo"),
        ],
        daily_budget_usd=1.50,
        tier_overrides={"designer": "high", "marketer": "standard"},
    ),

    # 3. 콘텐츠 크리에이터 — 마케팅/디자인 중심
    "content_creator": ProjectPreset(
        id="content_creator",
        name="콘텐츠 크리에이터",
        description="블로그, 뉴스레터, SNS 운영. 마케터 + 디자이너 주축, 개발 최소화.",
        icon="PenTool",
        active_agents=["ceo", "marketer", "designer", "cfo"],
        workflows=[
            PresetWorkflow(name="marketing_campaign", auto_start=True),
        ],
        initial_tasks=[
            PresetTask(title="콘텐츠 캘린더 수립", assignee="marketer", priority="high"),
            PresetTask(title="브랜드 가이드라인 제작", assignee="designer", priority="high"),
            PresetTask(title="SEO 키워드 리서치", assignee="marketer"),
            PresetTask(title="광고 예산 배분", assignee="cfo"),
        ],
        daily_budget_usd=0.50,
        tier_overrides={"marketer": "high"},
    ),

    # 4. 오픈소스 프로젝트 — 개발 + 리뷰 집중
    "open_source": ProjectPreset(
        id="open_source",
        name="오픈소스 프로젝트",
        description="코드 품질 최우선. 개발자 + 리뷰어 + 검증관 + DevOps 집중, 마케팅 없음.",
        icon="GitBranch",
        active_agents=["pm", "developer", "reviewer", "verifier", "devops"],
        workflows=[
            PresetWorkflow(name="bug_fix"),
            PresetWorkflow(name="feature_development"),
        ],
        initial_tasks=[
            PresetTask(title="README 작성", assignee="developer"),
            PresetTask(title="CI 파이프라인 세팅", assignee="devops", priority="high"),
            PresetTask(title="이슈 트리아지 프로세스", assignee="pm"),
            PresetTask(title="기여 가이드 작성", assignee="reviewer"),
            PresetTask(title="회귀 검증", assignee="verifier", depends_on=["CI 파이프라인 세팅"]),
        ],
        daily_budget_usd=1.00,
        tier_overrides={"reviewer": "high", "verifier": "high", "developer": "high"},
    ),

    # 5. 컨설팅 리포트 — CEO + CFO + PM 집중
    "consulting": ProjectPreset(
        id="consulting",
        name="컨설팅 리포트",
        description="시장 분석, 재무 모델링, 전략 보고서. 분석 에이전트 위주.",
        icon="BarChart",
        active_agents=["ceo", "pm", "cfo", "marketer"],
        initial_tasks=[
            PresetTask(title="시장 분석 보고서", assignee="ceo", priority="high"),
            PresetTask(title="경쟁사 벤치마킹", assignee="marketer"),
            PresetTask(title="재무 모델링", assignee="cfo", priority="high"),
            PresetTask(title="프로젝트 일정 수립", assignee="pm"),
        ],
        daily_budget_usd=0.80,
        tier_overrides={"ceo": "max", "cfo": "high"},
    ),
}


# ─── API Helpers ───

def get_preset(preset_id: str) -> Optional[ProjectPreset]:
    return PRESETS.get(preset_id)


def list_presets() -> List[Dict[str, Any]]:
    return [p.to_dict() for p in PRESETS.values()]

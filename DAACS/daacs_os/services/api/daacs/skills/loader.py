"""
DAACS OS — Skill Loader
에이전트 스킬 번들 로드 + SKILL.md 파싱 → 시스템 프롬프트 생성
"""
import logging
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

import yaml

logger = logging.getLogger("daacs.skills.loader")

_LEGACY_BUNDLE_CONFIG = Path(__file__).parent / "agent_bundles.yaml"


def resolve_bundle_config_path() -> Path:
    env_p = (os.getenv("DAACS_AGENT_BUNDLES_PATH") or "").strip()
    if env_p:
        p = Path(env_p)
        if p.is_file():
            return p
    here = Path(__file__).resolve()
    try:
        daacs_os = here.parents[4]
    except IndexError:
        daacs_os = None
    if daacs_os is not None:
        desktop_yaml = daacs_os / "apps" / "desktop" / "Resources" / "skills" / "agent_bundles.yaml"
        if desktop_yaml.is_file():
            return desktop_yaml
    if _LEGACY_BUNDLE_CONFIG.is_file():
        return _LEGACY_BUNDLE_CONFIG
    return _LEGACY_BUNDLE_CONFIG


@dataclass
class SkillContent:
    """파싱된 스킬 하나"""
    name: str
    description: str
    body: str  # SKILL.md 본문 (frontmatter 제외)
    metadata: Dict[str, Any] = field(default_factory=dict)


@dataclass
class SkillBundle:
    """에이전트 하나의 스킬 번들"""
    role: str
    description: str
    core_skills: List[SkillContent] = field(default_factory=list)
    support_skills: List[SkillContent] = field(default_factory=list)
    shared_skills: List[SkillContent] = field(default_factory=list)

    @property
    def all_skills(self) -> List[SkillContent]:
        return self.core_skills + self.support_skills + self.shared_skills

    def to_system_prompt(self, include_support: bool = True) -> str:
        """에이전트 LLM 호출 시 주입할 시스템 프롬프트 블록 생성"""
        parts = []
        parts.append(f"## Agent Skills ({self.role})")
        parts.append(f"{self.description}\n")

        # Core skills는 항상 포함
        if self.core_skills:
            parts.append("### Core Skills")
            for skill in self.core_skills:
                parts.append(f"#### {skill.name}")
                if skill.description:
                    parts.append(f"*{skill.description}*\n")
                parts.append(skill.body)
                parts.append("")

        # Support skills는 선택적
        if include_support and self.support_skills:
            parts.append("### Support Skills")
            for skill in self.support_skills:
                parts.append(f"#### {skill.name}")
                if skill.description:
                    parts.append(f"*{skill.description}*\n")
                parts.append(skill.body)
                parts.append("")

        # Shared skills
        if self.shared_skills:
            parts.append("### Shared Skills")
            for skill in self.shared_skills:
                parts.append(f"#### {skill.name}")
                parts.append(skill.body)
                parts.append("")

        return "\n".join(parts)

    def get_skill_names(self) -> List[str]:
        return [s.name for s in self.all_skills]


class SkillLoader:
    """
    스킬 번들 설정 로드 + SKILL.md 파일 파싱

    사용법:
        loader = SkillLoader(skills_root="/path/to/.daacs/skills")
        bundle = loader.load_bundle("developer")
        prompt = bundle.to_system_prompt()
    """

    def __init__(self, skills_root: Optional[str] = None):
        self._config = self._load_config()
        self._skills_root = Path(
            skills_root
            or os.getenv("DAACS_SKILLS_PATH", "")
            or self._resolve_default_skills_path()
        )
        self._cache: Dict[str, SkillContent] = {}

    def _resolve_default_skills_path(self) -> str:
        """기본 스킬 경로 탐색"""
        candidates = [
            Path(__file__).resolve().parents[5] / ".daacs" / "skills",  # 프로젝트 루트
            Path.home() / ".daacs" / "skills",
            Path(os.getenv("DAACS_HOME", "")) / ".daacs" / "skills",
        ]
        for p in candidates:
            if p.exists():
                return str(p)
        return str(candidates[0])

    def _load_config(self) -> Dict[str, Any]:
        path = resolve_bundle_config_path()
        if not path.exists():
            logger.warning("Bundle config not found: %s", path)
            return {}
        with open(path, "r", encoding="utf-8") as f:
            return yaml.safe_load(f) or {}

    def _parse_skill_md(self, skill_name: str) -> Optional[SkillContent]:
        """SKILL.md 파일 파싱 (frontmatter + body)"""
        if skill_name in self._cache:
            return self._cache[skill_name]

        skill_path = self._skills_root / skill_name / "SKILL.md"
        if not skill_path.exists():
            policy = self._config.get("policy", {})
            if policy.get("fallback_on_missing", True):
                logger.debug(f"Skill not found (skipped): {skill_name}")
                return None
            logger.warning(f"Skill not found: {skill_path}")
            return None

        try:
            text = skill_path.read_text(encoding="utf-8")
        except Exception as e:
            logger.error(f"Failed to read {skill_path}: {e}")
            return None

        # Frontmatter 파싱 (--- ... --- 블록)
        description = ""
        metadata: Dict[str, Any] = {}
        body = text

        if text.startswith("---"):
            parts = text.split("---", 2)
            if len(parts) >= 3:
                try:
                    fm = yaml.safe_load(parts[1]) or {}
                    description = fm.get("description", "")
                    metadata = fm
                    body = parts[2].strip()
                except yaml.YAMLError:
                    body = text

        skill = SkillContent(
            name=skill_name,
            description=description,
            body=body,
            metadata=metadata,
        )
        self._cache[skill_name] = skill
        return skill

    def _load_skill_list(self, names: List[str]) -> List[SkillContent]:
        """스킬 이름 리스트 → SkillContent 리스트"""
        results = []
        for name in names:
            skill = self._parse_skill_md(name)
            if skill:
                results.append(skill)
        return results

    def load_bundle(self, role: str) -> SkillBundle:
        """에이전트 역할에 맞는 스킬 번들 로드"""
        bundles_cfg = self._config.get("bundles", {})
        agent_cfg = bundles_cfg.get(role, {})

        if not agent_cfg:
            logger.warning(f"No bundle config for role: {role}")
            return SkillBundle(role=role, description="")

        policy = self._config.get("policy", {})
        max_skills = policy.get("max_skills_per_agent", 12)
        load_strategy = policy.get("load_strategy", "core_first")

        core_names = agent_cfg.get("core_skills", [])
        support_names = agent_cfg.get("support_skills", [])
        shared_cfg = self._config.get("shared", {})
        shared_names = shared_cfg.get("skills", [])

        # 로드 전략 적용
        core_skills = self._load_skill_list(core_names)

        if load_strategy == "core_first":
            remaining = max_skills - len(core_skills)
            support_skills = self._load_skill_list(support_names[:max(0, remaining)])
        elif load_strategy == "all":
            support_skills = self._load_skill_list(support_names)
        else:  # on_demand
            support_skills = []

        shared_skills = self._load_skill_list(shared_names)

        return SkillBundle(
            role=role,
            description=agent_cfg.get("description", ""),
            core_skills=core_skills,
            support_skills=support_skills,
            shared_skills=shared_skills,
        )

    def load_all_bundles(self) -> Dict[str, SkillBundle]:
        """전체 에이전트 번들 로드"""
        bundles_cfg = self._config.get("bundles", {})
        return {role: self.load_bundle(role) for role in bundles_cfg}

    def get_bundle_summary(self) -> Dict[str, Dict[str, Any]]:
        """번들 요약 (GUI 표시용)"""
        bundles_cfg = self._config.get("bundles", {})
        summary = {}
        for role, cfg in bundles_cfg.items():
            core = cfg.get("core_skills", [])
            support = cfg.get("support_skills", [])
            summary[role] = {
                "description": cfg.get("description", ""),
                "core_count": len(core),
                "support_count": len(support),
                "core_skills": core,
                "support_skills": support,
            }
        return summary

    @property
    def skills_root(self) -> Path:
        return self._skills_root

    @property
    def available_roles(self) -> List[str]:
        return list(self._config.get("bundles", {}).keys())

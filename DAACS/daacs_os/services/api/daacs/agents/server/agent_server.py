"""
DAACS OS ??AgentServer
8媛???븷??AgentSession ?앹꽦/愿由?+ ?묒뾽 ?쇱슦??

clock-in ??start(), clock-out ??stop() ?몄텧.
"""
import logging
import os
from pathlib import Path
from typing import Any, Dict, Optional

import yaml

from ...agents.base_roles import AgentRole
from ...skills.loader import SkillLoader
from .adapters import create_adapter
from .agent_session import AgentSession

logger = logging.getLogger("daacs.server.agent_server")

def _default_config_candidates() -> list[Path]:
    """Build config candidates without assuming fixed path depth."""
    here = Path(__file__).resolve()
    candidates: list[Path] = [Path.cwd() / "daacs_config.yaml"]
    for parent in here.parents:
        candidates.append(parent / "daacs_config.yaml")
    # De-duplicate while preserving order.
    unique: list[Path] = []
    seen = set()
    for item in candidates:
        key = str(item)
        if key in seen:
            continue
        seen.add(key)
        unique.append(item)
    return unique


# daacs_config.yaml 기본 경로 후보
_CONFIG_CANDIDATES = _default_config_candidates()


def _load_daacs_config() -> Dict[str, Any]:
    """daacs_config.yaml 濡쒕뱶"""
    config_path = os.getenv("DAACS_CONFIG_PATH", "")
    if config_path and Path(config_path).exists():
        candidates = [Path(config_path)]
    else:
        candidates = _CONFIG_CANDIDATES

    for path in candidates:
        if path.exists():
            with open(path, "r", encoding="utf-8") as f:
                cfg = yaml.safe_load(f) or {}
                logger.info(f"Config loaded from {path}")
                return cfg

    logger.warning("daacs_config.yaml not found, using defaults")
    return {}


class AgentServer:
    """
    8媛?AgentSession??愿由ы븯???쒕쾭.

    - daacs_config.yaml?먯꽌 ??븷蹂?LLM provider ?쎄린
    - SkillLoader濡???븷蹂??ㅽ궗 踰덈뱾 二쇱엯
    - submit_task()濡???븷蹂??ㅽ듃由щ컢 ?ㅽ뻾
    """

    def __init__(
        self,
        project_id: str,
        project_cwd: Optional[str] = None,
        llm_overrides: Optional[Dict[str, Any]] = None,
    ):
        self.project_id = project_id
        self.project_cwd = project_cwd or str(Path.cwd())
        self.llm_overrides = llm_overrides or {}
        self._sessions: Dict[AgentRole, AgentSession] = {}
        self._started = False
        self._ws_manager = None

    @property
    def is_started(self) -> bool:
        return self._started

    async def start(self, ws_manager) -> None:
        """
        AgentServer ?쒖옉: ?ㅼ젙 ?쎌뼱??8媛??몄뀡 珥덇린??

        Args:
            ws_manager: ConnectionManager ?깃???(agents_ws.ws_manager)
        """
        if self._started:
            logger.warning(f"[AgentServer] Already started for project {self.project_id}")
            return

        self._ws_manager = ws_manager
        config = _load_daacs_config()
        roles_cfg = config.get("roles", {})

        # SkillLoader 怨듭쑀 (罹먯떆 ?⑥쑉)
        skill_loader = SkillLoader()

        for role in AgentRole:
            role_cfg = roles_cfg.get(role.value, {})
            override = self.llm_overrides.get("role_overrides", {}).get(role.value, {})
            if isinstance(override, dict):
                role_cfg = {**role_cfg, **override}

            provider = role_cfg.get("cli", "claude")  # fallback: claude
            model = role_cfg.get("model")

            forced_provider = (self.llm_overrides.get("cli_only_provider") or os.getenv("DAACS_CLI_ONLY_PROVIDER", "")).strip().lower()
            if forced_provider:
                provider = forced_provider

            codex_only = self.llm_overrides.get("codex_only")
            if codex_only is None:
                codex_only = os.getenv("DAACS_CODEX_ONLY", "false").lower() in {"1", "true", "yes", "on"}
            if codex_only:
                provider = "codex"
                model = self.llm_overrides.get("codex_model") or os.getenv("DAACS_CODEX_MODEL", "") or model
            if isinstance(model, str):
                model = model.strip() or None

            try:
                adapter = create_adapter(provider, model=model, agent_role=role.value)

                # CLI ?ㅼ튂 ?щ? ?뺤씤
                if not adapter.is_available():
                    logger.warning(
                        f"[{role.value}] {provider} CLI not available ??"
                        f"session created but streaming will return error"
                    )

                # ?ㅽ궗 踰덈뱾 濡쒕뱶
                skill_bundle = skill_loader.load_bundle(role.value)

                session = AgentSession(
                    role=role,
                    project_id=self.project_id,
                    adapter=adapter,
                    ws_manager=ws_manager,
                    cwd=self.project_cwd,
                    skill_bundle=skill_bundle,
                )

                self._sessions[role] = session
                logger.info(
                    f"[AgentServer] Session ready: {role.value} ??{provider} "
                    f"(skills: {len(skill_bundle.all_skills)})"
                )

            except Exception as e:
                logger.error(f"[AgentServer] Failed to create session for {role.value}: {e}")

        self._started = True
        logger.info(
            f"[AgentServer] Started for project {self.project_id} "
            f"({len(self._sessions)}/8 sessions)"
        )

    async def stop(self) -> None:
        """AgentServer 醫낅즺: 紐⑤뱺 ?몄뀡 ?뺣━"""
        if not self._started:
            return

        # ?꾩옱 ?몄뀡? stateless subprocess?대?濡?硫붾え由щ쭔 ?뺣━
        active = [r.value for r, s in self._sessions.items() if s.is_active]
        if active:
            logger.warning(f"[AgentServer] Stopping while active: {active}")

        self._sessions.clear()
        self._started = False
        logger.info(f"[AgentServer] Stopped for project {self.project_id}")

    async def submit_task(
        self,
        role: AgentRole,
        instruction: str,
        context: Optional[Dict[str, Any]] = None,
        timeout: int = 300,
    ) -> str:
        """
        ??븷蹂??몄뀡???묒뾽 ?쒖텧 + ?ㅽ듃由щ컢 ?ㅽ뻾.

        Args:
            role: ?ㅽ뻾???먯씠?꾪듃 ??븷
            instruction: 吏?쒕Ц
            context: ?뚰겕?뚮줈??而⑦뀓?ㅽ듃 ??
            timeout: 理쒕? ?ㅽ뻾 ?쒓컙(珥?

        Returns:
            ?꾩껜 ?묐떟 ?띿뒪??
        """
        if not self._started:
            raise RuntimeError("AgentServer not started. Call start() first.")

        session = self._sessions.get(role)
        if session is None:
            raise ValueError(f"No session for role: {role.value}")

        logger.info(f"[AgentServer] submit_task ??{role.value}: {instruction[:80]}...")
        return await session.execute(instruction, context=context, timeout=timeout)

    async def notify_message_sent(
        self,
        from_role: AgentRole,
        to_role: AgentRole,
        summary: str,
    ) -> None:
        """
        ?먯씠?꾪듃 媛?硫붿떆吏 ?꾨떖 ?대깽??諛쒗뻾 (?ㅽ뵾?????좊땲硫붿씠???몃━嫄?.
        """
        session = self._sessions.get(from_role)
        if session:
            await session.send_to_agent(to_role.value, summary)

    def get_session(self, role: AgentRole) -> Optional[AgentSession]:
        return self._sessions.get(role)

    def get_status(self) -> Dict[str, Any]:
        """?붾쾭洹?紐⑤땲?곕쭅???곹깭 ?붿빟"""
        return {
            "project_id": self.project_id,
            "started": self._started,
            "sessions": {
                role.value: {
                    "active": session.is_active,
                    "history_len": len(session.history),
                    "provider": session.adapter.provider,
                }
                for role, session in self._sessions.items()
            },
        }

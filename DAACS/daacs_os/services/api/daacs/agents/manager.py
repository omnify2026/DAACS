"""DAACS OS agent manager: lifecycle, messaging, and parallel task dispatch."""
import asyncio
import logging
from typing import Any, Callable, Dict, List, Optional

from .base import BaseAgent
from .base_roles import AgentRole, AgentStatus
from .teams import AgentTeam, get_team_roles
from .protocol import AgentEvent, AgentMessage, MessageType
from .ceo import CEOAgent
from .pm import PMAgent
from .developer import DeveloperAgent
from .reviewer import ReviewerAgent
from .verifier import VerifierAgent
from .devops import DevOpsAgent
from .marketer import MarketerAgent
from .designer import DesignerAgent
from .cfo import CFOAgent
from .server import AgentServer


AGENT_CLASSES = {
    AgentRole.CEO: CEOAgent,
    AgentRole.PM: PMAgent,
    AgentRole.DEVELOPER: DeveloperAgent,
    AgentRole.REVIEWER: ReviewerAgent,
    AgentRole.VERIFIER: VerifierAgent,
    AgentRole.DEVOPS: DevOpsAgent,
    AgentRole.MARKETER: MarketerAgent,
    AgentRole.DESIGNER: DesignerAgent,
    AgentRole.CFO: CFOAgent,
}


class AgentManager:
    def __init__(
        self,
        project_id: str,
        event_broadcaster: Optional[Callable] = None,
        skills_root: Optional[str] = None,
    ):
        self.project_id = project_id
        self.agents: Dict[AgentRole, BaseAgent] = {}
        self.event_broadcaster = event_broadcaster
        self.skills_root = skills_root
        self._llm_executor = None
        self._llm_overrides: Dict[str, Any] = {}
        self._agent_server: Optional[AgentServer] = None
        self._project_cwd: Optional[str] = None
        self.logger = logging.getLogger(f"daacs.manager.{project_id[:8]}")

    def clock_in(self, load_skills: bool = True):
        """8紐??먯씠?꾪듃 ?꾩썝 ?앹꽦 (GUI clockIn 留ㅽ븨)"""
        for role, agent_cls in AGENT_CLASSES.items():
            agent = agent_cls(project_id=self.project_id)
            if self.event_broadcaster:
                agent.set_event_broadcaster(self.event_broadcaster)
            # Manager 李몄“ 二쇱엯 (?먯씠?꾪듃 媛?硫붿떆吏 ?꾩넚??
            agent.set_manager(self)
            if load_skills:
                try:
                    agent.load_skills(skills_root=self.skills_root)
                except Exception as e:
                    self.logger.warning(f"Skills load failed for {role.value}: {e}")
            self.agents[role] = agent
            self.logger.info(f"Agent {role.value} clocked in")

    def set_llm_executor(self, executor):
        """紐⑤뱺 ?먯씠?꾪듃??LLMExecutor 二쇱엯"""
        self._llm_executor = executor
        for agent in self.agents.values():
            agent.set_llm_executor(executor)
        self.logger.info(f"LLMExecutor set for all {len(self.agents)} agents")

    def set_llm_overrides(self, overrides: Optional[Dict[str, Any]]) -> None:
        self._llm_overrides = dict(overrides or {})
        if self._llm_executor is not None and hasattr(self._llm_executor, "update_overrides"):
            self._llm_executor.update_overrides(self._llm_overrides)
        if self._agent_server is not None:
            self._agent_server.llm_overrides = dict(self._llm_overrides)

    @property
    def llm_overrides(self) -> Dict[str, Any]:
        return dict(self._llm_overrides)

    def set_project_cwd(self, project_cwd: Optional[str]) -> None:
        normalized = str(project_cwd or "").strip() or None
        if normalized is None:
            return
        self._project_cwd = normalized
        if self._agent_server is not None:
            self._agent_server.project_cwd = normalized

    @property
    def project_cwd(self) -> Optional[str]:
        if self._project_cwd:
            return self._project_cwd
        if self._agent_server is not None:
            normalized = str(getattr(self._agent_server, "project_cwd", "") or "").strip()
            if normalized:
                return normalized
        return None

    # ??? 蹂묐젹 ?ㅽ뻾 愿由????

    async def start_all(self):
        """紐⑤뱺 ?먯씠?꾪듃??諛깃렇?쇱슫??猷⑦봽 ?쒖옉 (蹂묐젹 ?ㅽ뻾 ?쒖꽦??"""
        for role, agent in self.agents.items():
            await agent.start()
        self.logger.info(f"All {len(self.agents)} agent loops started")

    async def stop_all(self):
        """紐⑤뱺 ?먯씠?꾪듃??諛깃렇?쇱슫??猷⑦봽 醫낅즺"""
        for role, agent in self.agents.items():
            await agent.stop()
        self.logger.info(f"All agent loops stopped")

    def submit_task(
        self,
        role: AgentRole,
        instruction: str,
        context: Optional[Dict[str, Any]] = None,
    ) -> Optional[str]:
        """?뱀젙 ?먯씠?꾪듃??鍮꾨룞湲??쒖뒪???쒖텧. task_id 諛섑솚."""
        agent = self.agents.get(role)
        if agent is None:
            self.logger.error(f"Agent {role.value} not found")
            return None
        if not agent.is_running:
            self.logger.warning(f"Agent {role.value} loop not running, starting it")
            asyncio.ensure_future(agent.start())
        return agent.submit_task(instruction, context)

    def broadcast_task(
        self,
        instruction: str,
        roles: Optional[List[AgentRole]] = None,
        context: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, str]:
        """
        ?щ윭 ?먯씠?꾪듃???숈떆 ?쒖뒪???쒖텧.

        Args:
            instruction: 紐⑤뱺 ????먯씠?꾪듃???꾨떖??吏??
            roles: ?????븷 紐⑸줉 (None?대㈃ ?꾩껜)

        Returns:
            {role_value: task_id} 留ㅽ븨
        """
        targets = roles or list(self.agents.keys())
        task_ids: Dict[str, str] = {}

        for role in targets:
            agent = self.agents.get(role)
            if agent:
                if not agent.is_running:
                    asyncio.ensure_future(agent.start())
                tid = agent.submit_task(instruction, context=context)
                task_ids[role.value] = tid

        self.logger.info(f"Broadcast task to {len(task_ids)} agents: {list(task_ids.keys())}")
        return task_ids

    def submit_team_task(
        self,
        team: AgentTeam,
        instruction: str,
        context: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, str]:
        """
        ? ?⑥쐞 ?쒖뒪???쒖텧.

        ????랁븳 ?먯씠?꾪듃?ㅼ씠 媛곸옄 ?먯떊???ㅽ궗 踰덈뱾???ъ슜??蹂묐젹 泥섎━?쒕떎.
        """
        roles = get_team_roles(team)
        task_ids = self.broadcast_task(
            instruction=instruction,
            roles=roles,
            context=context,
        )
        self.logger.info(
            f"Team task submitted: team={team.value}, "
            f"agents={list(task_ids.keys())}, instruction={instruction[:80]}"
        )
        return task_ids

    def get_task_result(self, role: AgentRole, task_id: str) -> Optional[Dict[str, Any]]:
        """?먯씠?꾪듃蹂??쒖뒪??寃곌낵 議고쉶."""
        agent = self.agents.get(role)
        if agent is None:
            return None
        return agent.get_task_result(task_id)

    # ??? 湲곗〈 硫붿떆吏/紐낅졊 ???

    def get_agent(self, role: AgentRole) -> Optional[BaseAgent]:
        return self.agents.get(role)

    async def route_message(self, message: AgentMessage) -> bool:
        """?먯씠?꾪듃 媛?硫붿떆吏 ?쇱슦??+ UI ?꾩넚/?섏떊 ?대깽??諛쒗뻾."""
        try:
            receiver_role = AgentRole(message.receiver)
        except ValueError:
            self.logger.error(f"Unknown receiver role: {message.receiver}")
            return False

        agent = self.agents.get(receiver_role)
        if agent is None:
            self.logger.error(f"Agent {message.receiver} not found")
            return False

        try:
            sender_role = AgentRole(message.sender)
        except ValueError:
            sender_role = None

        await agent.receive_message(message)

        if sender_role is not None:
            summary = self._summarize_message_content(message.type, message.content)
            try:
                await self.notify_agent_message(sender_role, receiver_role, summary)
            except Exception as e:
                self.logger.warning(
                    f"notify_agent_message failed ({sender_role.value}->{receiver_role.value}): {e}"
                )

        return True

    @staticmethod
    def _summarize_message_content(msg_type: MessageType, content: Any) -> str:
        """UI 濡쒓렇???쒖떆??吏㏃? 硫붿떆吏 ?붿빟."""
        if isinstance(content, str):
            text = content.strip()
        else:
            text = str(content).strip()

        if not text:
            text = msg_type.value

        return text[:180]

    async def send_command(self, role: AgentRole, command: str) -> Dict[str, Any]:
        """GUI?먯꽌 ?뱀젙 ?먯씠?꾪듃??紐낅졊 ?꾩넚"""
        agent = self.agents.get(role)
        if agent is None:
            return {"error": f"Agent {role.value} not found"}

        message = AgentMessage(
            sender="user",
            receiver=role.value,
            type=MessageType.COMMAND,
            content=command,
        )
        await agent.receive_message(message)
        return {"status": "sent", "agent": role.value, "command": command}

    # ??? AgentServer (?ㅽ듃由щ컢 ?ㅽ뻾) ???

    async def start_server(
        self,
        ws_manager,
        project_cwd: Optional[str] = None,
    ) -> None:
        """
        AgentServer ?쒖옉 (clock-in ???몄텧).
        媛???븷蹂??ㅽ듃由щ컢 ?몄뀡???앹꽦?섍퀬 SkillBundle??二쇱엯?쒕떎.
        """
        if self._agent_server and self._agent_server.is_started:
            self.logger.info("[Manager] AgentServer already running")
            return
        self.set_project_cwd(project_cwd)
        self._agent_server = AgentServer(
            project_id=self.project_id,
            project_cwd=self.project_cwd,
            llm_overrides=self._llm_overrides,
        )
        await self._agent_server.start(ws_manager)
        self.logger.info("[Manager] AgentServer started")

    async def stop_server(self) -> None:
        """AgentServer 醫낅즺 (clock-out ???몄텧)"""
        if self._agent_server:
            await self._agent_server.stop()
            self._agent_server = None
            self.logger.info("[Manager] AgentServer stopped")

    async def execute_with_stream(
        self,
        role: AgentRole,
        instruction: str,
        context: Optional[Dict[str, Any]] = None,
        timeout: int = 300,
    ) -> str:
        """
        ?ㅽ듃由щ컢 寃쎈줈 ?곗꽑 ?ㅽ뻾.
        AgentServer媛 ?녾굅???ㅽ뙣?섎㈃ 湲곗〈 submit_task fallback.

        Returns:
            ?묐떟 ?띿뒪??(?ㅽ듃由щ컢? WS濡?蹂꾨룄 ?꾨떖??
        """
        if self._agent_server and self._agent_server.is_started:
            try:
                return await self._agent_server.submit_task(
                    role, instruction, context=context, timeout=timeout
                )
            except Exception as e:
                self.logger.warning(
                    f"[Manager] Streaming failed for {role.value}, fallback: {e}"
                )

        # Fallback: 湲곗〈 ??湲곕컲 ?ㅽ뻾
        task_id = self.submit_task(role, instruction, context)
        self.logger.info(f"[Manager] Fallback submit_task: {role.value} task_id={task_id}")
        return task_id or ""

    async def notify_agent_message(
        self,
        from_role: AgentRole,
        to_role: AgentRole,
        summary: str,
    ) -> None:
        """?먯씠?꾪듃 媛?硫붿떆吏 ?꾨떖 ?대깽??(?ㅽ뵾?????좊땲硫붿씠???몃━嫄?"""
        if self._agent_server and self._agent_server.is_started:
            await self._agent_server.notify_message_sent(from_role, to_role, summary)

    @property
    def agent_server(self) -> Optional[AgentServer]:
        return self._agent_server

    # ??? ?곹깭 議고쉶 ???

    def get_all_states(self) -> List[Dict[str, Any]]:
        """?꾩껜 ?먯씠?꾪듃 ?곹깭 (GUI GET /api/agents ?묐떟)"""
        return [agent.to_dict() for agent in self.agents.values()]

    def get_agent_state(self, role: AgentRole) -> Optional[Dict[str, Any]]:
        """媛쒕퀎 ?먯씠?꾪듃 ?곹깭"""
        agent = self.agents.get(role)
        return agent.to_dict() if agent else None

    def get_parallel_status(self) -> Dict[str, Any]:
        """蹂묐젹 ?ㅽ뻾 ?곹깭 ?붿빟"""
        return {
            "project_id": self.project_id,
            "total_agents": len(self.agents),
            "running_agents": sum(1 for a in self.agents.values() if a.is_running),
            "total_queued": sum(a.queue_size for a in self.agents.values()),
            "agents": {
                role.value: {
                    "running": agent.is_running,
                    "queue_size": agent.queue_size,
                    "status": agent.status.value,
                }
                for role, agent in self.agents.items()
            },
        }

def get_multi_agent_results(manager: AgentManager, task_ids: Dict[str, str]) -> Dict[str, Dict[str, Any]]:
    """Fetch multi-agent task results by role->task_id mapping."""
    results: Dict[str, Dict[str, Any]] = {}
    for role_name, task_id in task_ids.items():
        try:
            role = AgentRole(role_name)
        except ValueError:
            continue
        result = manager.get_task_result(role, task_id)
        if result is None:
            results[role_name] = {"status": "pending", "task_id": task_id}
        else:
            results[role_name] = {"task_id": task_id, **result}
    return results

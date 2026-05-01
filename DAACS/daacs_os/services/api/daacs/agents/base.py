"""
DAACS OS ??Base Agent Class
紐⑤뱺 ?먯씠?꾪듃??異붿긽 湲곕컲 ?대옒??

媛??먯씠?꾪듃???낅┰?곸씤 asyncio ?쒖뒪???먮? 媛吏硫?
?뚰겕?뚮줈?곗? 蹂꾧컻濡?蹂묐젹 ?묒뾽???섑뻾?????덈떎.
"""
import asyncio
import logging
import uuid as _uuid
from abc import ABC, abstractmethod
from typing import Any, Dict, List, Optional

from ..application.persistence_service import (
    persist_agent_event,
    persist_task_completed,
    persist_task_failed,
    persist_task_started,
    persist_task_submitted,
)
from .base_roles import AgentRole, AgentStatus, AGENT_META
from .protocol import AgentEvent, AgentMessage, MessageType


class BaseAgent(ABC):
    """
    8醫??먯씠?꾪듃??怨듯넻 湲곕컲 ?대옒??

    - GUI??AgentSprite? 1:1 留ㅽ븨?섎뒗 ?곹깭 愿由?
    - ?먯씠?꾪듃 媛?硫붿떆吏 援먰솚
    - WebSocket ?대깽??諛쒗뻾 (GUI ?ㅼ떆媛?諛섏쁺)
    - ??븷蹂??ㅽ궗 踰덈뱾 濡쒕뱶 (LLM ?쒖뒪???꾨＼?꾪듃 二쇱엯)
    - 鍮꾨룞湲??쒖뒪????(?낅┰ 蹂묐젹 ?ㅽ뻾)
    """

    def __init__(self, role: AgentRole, project_id: Optional[str] = None):
        self.role = role
        self.project_id = project_id
        self.status = AgentStatus.IDLE
        self.current_task: Optional[str] = None
        self.message: Optional[str] = None
        self.inbox: List[AgentMessage] = []
        self.metadata: Dict[str, Any] = {}

        # ??븷 硫뷀??곗씠??(GUI 留ㅽ븨)
        meta = AGENT_META.get(role, {})
        self.display_name = meta.get("display_name", role.value)
        self.color = meta.get("color", "#888888")
        self.icon = meta.get("icon", "User")
        self.default_messages = meta.get("default_messages", [])

        self.logger = logging.getLogger(f"daacs.agent.{role.value}")

        # ?대깽??釉뚮줈?쒖틦?ㅽ꽣 ??server?먯꽌 二쇱엯
        self._event_broadcaster = None

        # ?ㅽ궗 踰덈뱾 ??SkillLoader濡?lazy 濡쒕뱶
        self._skill_bundle = None

        # ??? 蹂묐젹 ?ㅽ뻾 ?명봽?????
        self._task_queue: asyncio.Queue = asyncio.Queue()
        self._loop_task: Optional[asyncio.Task] = None
        self._running = False
        self._task_results: Dict[str, Dict[str, Any]] = {}  # task_id ??result

        # AgentManager 李몄“ ???먯씠?꾪듃 媛?硫붿떆吏 ?꾩넚??
        self._manager = None

    def set_event_broadcaster(self, broadcaster):
        """WebSocket ?대깽??釉뚮줈?쒖틦?ㅽ꽣 二쇱엯"""
        self._event_broadcaster = broadcaster

    def set_manager(self, manager):
        """AgentManager 李몄“ 二쇱엯 (?먯씠?꾪듃 媛?硫붿떆吏 ?꾩넚??"""
        self._manager = manager

    def _schedule_persistence(self, coroutine: Any, label: str) -> None:
        try:
            loop = asyncio.get_running_loop()
            loop.create_task(coroutine)
        except RuntimeError:
            close_fn = getattr(coroutine, "close", None)
            if callable(close_fn):
                close_fn()
            self.logger.debug(f"[{self.role.value}] Persistence skipped ({label}): no active loop")
        except Exception as exc:
            close_fn = getattr(coroutine, "close", None)
            if callable(close_fn):
                close_fn()
            self.logger.warning(f"[{self.role.value}] Persistence scheduling failed ({label}): {exc}")

    @staticmethod
    def _normalize_result_payload(result: Any) -> Dict[str, Any]:
        if isinstance(result, dict):
            return result
        return {"output": str(result)[:4000]}

    # ??? ?ㅽ궗 愿由????

    def load_skills(self, skills_root: Optional[str] = None):
        """??븷蹂??ㅽ궗 踰덈뱾 濡쒕뱶"""
        from ..skills.loader import SkillLoader
        loader = SkillLoader(skills_root=skills_root)
        self._skill_bundle = loader.load_bundle(self.role.value)
        skill_names = self._skill_bundle.get_skill_names()
        self.logger.info(f"[{self.role.value}] Loaded {len(skill_names)} skills: {skill_names}")

    def get_skill_prompt(self, include_support: bool = True) -> str:
        """LLM ?몄텧 ??二쇱엯???ㅽ궗 ?쒖뒪???꾨＼?꾪듃 諛섑솚"""
        if self._skill_bundle is None:
            return ""
        return self._skill_bundle.to_system_prompt(include_support=include_support)

    @property
    def skill_bundle(self):
        return self._skill_bundle

    # ??? ?곹깭 愿由????

    def update_status(self, status: AgentStatus, message: Optional[str] = None):
        """?곹깭 蹂寃?+ GUI???ㅼ떆媛??대깽??諛쒗뻾"""
        old_status = self.status
        self.status = status
        if message:
            self.message = message
        self.logger.info(f"[{self.role.value}] {old_status} ??{status}")
        self._emit_event("AGENT_STATUS_UPDATED", {
            "status": status.value,
            "previous_status": old_status.value,
            "message": self.message,
            "current_task": self.current_task,
        })

    def set_task(self, task: str):
        """?꾩옱 ?묒뾽 ?ㅼ젙 + working ?곹깭 ?꾪솚"""
        self.current_task = task
        self.update_status(AgentStatus.WORKING, task)

    def complete_task(self):
        """?묒뾽 ?꾨즺 + idle ?곹깭 ?꾪솚"""
        self.current_task = None
        self.update_status(AgentStatus.IDLE)

    def set_error(self, error_message: str):
        """Error 상태 전환 및 이벤트 저장."""
        self.update_status(AgentStatus.ERROR, error_message)
        self._emit_event("AGENT_ERROR", {"error": error_message})
        if self.project_id:
            self._schedule_persistence(
                persist_agent_event(
                    project_id=self.project_id,
                    agent_role=self.role.value,
                    event_type="error",
                    data={"error": error_message[:500]},
                ),
                "persist_agent_error",
            )

    # ??? LLM ?ㅽ뻾 ???

    _llm_executor = None  # LLMExecutor ???뚰겕?뚮줈???ㅽ뻾 ??二쇱엯

    def set_llm_executor(self, executor):
        """LLMExecutor 二쇱엯"""
        self._llm_executor = executor

    async def execute_task(
        self,
        prompt: str,
        system_prompt: str = "",
        role_override: Optional[str] = None,
        include_skill_prompt: bool = True,
    ) -> str:
        """
        LLMExecutor를 통한 LLM 호출을 수행한다.
        """
        if self._llm_executor is None:
            self.logger.warning(f"[{self.role.value}] No LLM executor set, returning empty")
            return ""

        skill_prompt = self.get_skill_prompt() if include_skill_prompt else ""
        combined_system = f"{skill_prompt}\n\n{system_prompt}" if skill_prompt else system_prompt

        self.set_task("LLM 처리 중...")
        try:
            result = await self._llm_executor.execute(
                role=role_override or self.role.value,
                prompt=prompt,
                system_prompt=combined_system,
            )
            return result
        except Exception as e:
            self.set_error(str(e))
            raise

    # ??? ?낅┰ 蹂묐젹 ?ㅽ뻾 (?쒖뒪???? ???

    async def start(self):
        """?먯씠?꾪듃 諛깃렇?쇱슫??猷⑦봽 ?쒖옉. ?먯뿉???쒖뒪?щ? ?뚮퉬?섎ŉ ?낅┰ ?ㅽ뻾."""
        if self._running:
            return
        self._running = True
        self._loop_task = asyncio.create_task(self._run_loop())
        self.logger.info(f"[{self.role.value}] Background loop started")

    async def stop(self):
        """?먯씠?꾪듃 諛깃렇?쇱슫??猷⑦봽 醫낅즺."""
        self._running = False
        if self._loop_task and not self._loop_task.done():
            self._loop_task.cancel()
            try:
                await self._loop_task
            except asyncio.CancelledError:
                pass
        self._loop_task = None
        self.logger.info(f"[{self.role.value}] Background loop stopped")

    @property
    def is_running(self) -> bool:
        return self._running

    @property
    def queue_size(self) -> int:
        return self._task_queue.qsize()

    def submit_task(self, instruction: str, context: Optional[Dict[str, Any]] = None) -> str:
        """
        ?먯씠?꾪듃 ?먯뿉 ?쒖뒪???쒖텧. 利됱떆 諛섑솚 (鍮꾨룞湲?泥섎━).

        Returns:
            task_id ??寃곌낵 議고쉶 ???ъ슜
        """
        task_id = str(_uuid.uuid4())
        self._task_queue.put_nowait({
            "task_id": task_id,
            "instruction": instruction,
            "context": context,
        })
        self._task_results[task_id] = {"status": "queued"}
        self.logger.info(f"[{self.role.value}] Task submitted: {task_id} ??{instruction[:60]}")
        if self.project_id:
            self._schedule_persistence(
                persist_task_submitted(
                    project_id=self.project_id,
                    task_id=task_id,
                    agent_role=self.role.value,
                    instruction=instruction[:2000],
                ),
                "persist_task_submitted",
            )
        self._emit_event("AGENT_TASK_QUEUED", {
            "task_id": task_id,
            "instruction": instruction[:100],
            "queue_size": self._task_queue.qsize(),
        })
        return task_id

    def get_task_result(self, task_id: str) -> Optional[Dict[str, Any]]:
        """?쒖뒪??寃곌낵 議고쉶."""
        return self._task_results.get(task_id)

    async def _run_loop(self):
        """諛깃렇?쇱슫???쒖뒪???뚮퉬 猷⑦봽."""
        while self._running:
            try:
                task_data = await asyncio.wait_for(
                    self._task_queue.get(), timeout=1.0,
                )
            except asyncio.TimeoutError:
                continue
            except asyncio.CancelledError:
                break

            task_id = task_data["task_id"]
            instruction = task_data["instruction"]
            context = task_data.get("context")

            self._task_results[task_id] = {"status": "running"}
            self.logger.info(f"[{self.role.value}] Processing task {task_id}")
            await persist_task_started(task_id)

            try:
                self.set_task(instruction[:50])
                result = await self.execute(instruction, context=context)
                result_payload = self._normalize_result_payload(result)
                self._task_results[task_id] = {
                    "status": "completed",
                    "result": result_payload,
                }
                await persist_task_completed(task_id, result_payload)
                self.complete_task()
                self._emit_event("AGENT_TASK_COMPLETED", {
                    "task_id": task_id,
                    "result_summary": str(result)[:200] if result else "",
                    "result": result_payload,
                })
            except Exception as e:
                self._task_results[task_id] = {
                    "status": "failed",
                    "error": str(e)[:500],
                }
                await persist_task_failed(task_id, str(e))
                self.set_error(str(e)[:200])
                self._emit_event("AGENT_TASK_FAILED", {
                    "task_id": task_id,
                    "error": str(e)[:200],
                })

    # ??? ?먯씠?꾪듃 媛?硫붿떆吏 ?꾩넚 ???

    async def send_to_agent(
        self,
        receiver_role: str,
        msg_type: MessageType,
        content: Any,
    ):
        """?ㅻⅨ ?먯씠?꾪듃?먭쾶 硫붿떆吏 ?꾩넚 (AgentManager 寃쎌쑀)."""
        if self._manager is None:
            self.logger.warning(f"[{self.role.value}] No manager set, cannot send message")
            return

        message = AgentMessage(
            sender=self.role.value,
            receiver=receiver_role,
            type=msg_type,
            content=content,
        )
        routed = await self._manager.route_message(message)
        if not routed:
            self.logger.warning(
                f"[{self.role.value}] Failed to route message to {receiver_role}"
            )
        elif self.project_id:
            await persist_agent_event(
                project_id=self.project_id,
                agent_role=self.role.value,
                event_type="message_sent",
                data={
                    "from": self.role.value,
                    "to": receiver_role,
                    "content": str(content)[:2000],
                    "message_type": msg_type.value,
                },
            )

    # ??? 硫붿떆吏 援먰솚 ???

    async def receive_message(self, message: AgentMessage):
        """硫붿떆吏 ?섏떊 ??泥섎━"""
        self.logger.info(f"[{self.role.value}] Received {message.type} from {message.sender}")
        self.inbox.append(message)
        if self.project_id:
            await persist_agent_event(
                project_id=self.project_id,
                agent_role=self.role.value,
                event_type="message_received",
                data={
                    "from": message.sender,
                    "to": self.role.value,
                    "content": str(message.content)[:2000],
                    "message_type": message.type.value,
                },
            )
        await self.process_message(message)

    @abstractmethod
    async def process_message(self, message: AgentMessage):
        """?쒕툕?대옒?ㅼ뿉??援ы쁽: ?섏떊 硫붿떆吏 泥섎━ 濡쒖쭅"""
        pass

    @abstractmethod
    async def execute(self, instruction: str, context: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """?쒕툕?대옒?ㅼ뿉??援ы쁽: ?듭떖 ?ㅽ뻾 濡쒖쭅"""
        pass

    # ??? GUI ?대깽?????

    def _emit_event(self, event_type: str, data: Dict[str, Any]):
        """GUI濡?WebSocket ?대깽??諛쒗뻾 (鍮꾨룞湲??덉쟾)"""
        if self._event_broadcaster is None:
            return
        event = AgentEvent(
            type=event_type,
            agent_role=self.role.value,
            data=data,
        )
        try:
            self._event_broadcaster(event)
        except Exception as e:
            self.logger.warning(f"Event broadcast failed: {e}")

    # ??? 吏곷젹?????

    def to_dict(self) -> Dict[str, Any]:
        """GUI???꾩넚???먯씠?꾪듃 ?곹깭 JSON"""
        result = {
            "role": self.role.value,
            "display_name": self.display_name,
            "status": self.status.value,
            "current_task": self.current_task,
            "message": self.message,
            "color": self.color,
            "icon": self.icon,
            "project_id": self.project_id,
            "queue_size": self._task_queue.qsize(),
            "is_running": self._running,
        }
        if self._skill_bundle:
            result["skills"] = self._skill_bundle.get_skill_names()
        return result

"""
DAACS OS — Task Tree (DAG)
에이전트 간 태스크 의존성 관리 — 방향 비순환 그래프

역할:
  - PM이 태스크를 생성하고 의존성 정의
  - 에이전트는 자신의 태스크만 실행 가능
  - 의존성이 충족된 태스크만 실행 가능 (ready 상태)
  - GUI 칸반 보드와 1:1 매핑
"""
import logging
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any, Dict, List, Optional, Set

logger = logging.getLogger("daacs.worktree.task_tree")


class TaskStatus(str, Enum):
    BACKLOG = "backlog"
    READY = "ready"          # 의존성 충족, 실행 가능
    IN_PROGRESS = "in_progress"
    REVIEW = "review"
    DONE = "done"
    BLOCKED = "blocked"      # 의존성 미충족
    FAILED = "failed"


@dataclass
class TaskNode:
    """태스크 트리의 하나의 노드"""
    id: str = field(default_factory=lambda: str(uuid.uuid4())[:8])
    title: str = ""
    description: str = ""
    assignee: str = ""       # 에이전트 role (e.g., "developer")
    status: TaskStatus = TaskStatus.BACKLOG
    depends_on: List[str] = field(default_factory=list)  # 다른 task id 리스트
    files: List[str] = field(default_factory=list)        # 관련 파일 경로
    result: Optional[Dict[str, Any]] = None
    created_at: str = field(default_factory=lambda: datetime.now().isoformat())
    updated_at: str = field(default_factory=lambda: datetime.now().isoformat())
    metadata: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "title": self.title,
            "description": self.description,
            "assignee": self.assignee,
            "status": self.status.value,
            "depends_on": self.depends_on,
            "files": self.files,
            "result": self.result,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }


class TaskTree:
    """
    DAG 기반 태스크 관리.

    사용법:
        tree = TaskTree()
        t1 = tree.add_task("디자인", assignee="designer")
        t2 = tree.add_task("구현", assignee="developer", depends_on=[t1.id])
        t3 = tree.add_task("리뷰", assignee="reviewer", depends_on=[t2.id])

        ready = tree.get_ready_tasks()         # 의존성 충족된 태스크
        mine = tree.get_tasks_for("developer") # 개발자 태스크만
    """

    def __init__(self):
        self._tasks: Dict[str, TaskNode] = {}

    def add_task(
        self,
        title: str,
        assignee: str = "",
        description: str = "",
        depends_on: Optional[List[str]] = None,
        files: Optional[List[str]] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> TaskNode:
        """태스크 추가"""
        # 의존성 유효성 검증
        deps = depends_on or []
        for dep_id in deps:
            if dep_id not in self._tasks:
                raise ValueError(f"Dependency task not found: {dep_id}")

        task = TaskNode(
            title=title,
            description=description,
            assignee=assignee,
            depends_on=deps,
            files=files or [],
            metadata=metadata or {},
        )

        # 의존성 충족 여부에 따라 초기 상태 결정
        if self._deps_satisfied(task):
            task.status = TaskStatus.READY
        else:
            task.status = TaskStatus.BLOCKED

        self._tasks[task.id] = task
        logger.info(f"Task added: {task.id} '{title}' → {task.status.value}")
        return task

    def update_status(self, task_id: str, status: TaskStatus, result: Optional[Dict] = None) -> TaskNode:
        """태스크 상태 변경 + 하위 태스크 상태 재계산"""
        task = self._tasks.get(task_id)
        if task is None:
            raise KeyError(f"Task not found: {task_id}")

        old_status = task.status
        task.status = status
        task.updated_at = datetime.now().isoformat()
        if result is not None:
            task.result = result

        logger.info(f"Task {task_id}: {old_status.value} → {status.value}")

        # DONE이 되면 하위 태스크들의 상태 재계산
        if status == TaskStatus.DONE:
            self._propagate_ready()

        return task

    def start_task(self, task_id: str, assignee: str) -> TaskNode:
        """태스크 시작 (READY → IN_PROGRESS)"""
        task = self._tasks.get(task_id)
        if task is None:
            raise KeyError(f"Task not found: {task_id}")
        if task.status != TaskStatus.READY:
            raise ValueError(f"Task {task_id} is not ready (status: {task.status.value})")
        if task.assignee and task.assignee != assignee:
            raise ValueError(f"Task {task_id} is assigned to {task.assignee}, not {assignee}")

        task.assignee = assignee
        return self.update_status(task_id, TaskStatus.IN_PROGRESS)

    def complete_task(self, task_id: str, result: Optional[Dict] = None) -> TaskNode:
        """태스크 완료 (IN_PROGRESS → DONE)"""
        task = self._tasks.get(task_id)
        if task is None:
            raise KeyError(f"Task not found: {task_id}")
        return self.update_status(task_id, TaskStatus.DONE, result)

    def fail_task(self, task_id: str, error: str) -> TaskNode:
        """태스크 실패"""
        return self.update_status(task_id, TaskStatus.FAILED, {"error": error})

    # ─── 쿼리 ───

    def get_ready_tasks(self) -> List[TaskNode]:
        """실행 가능한 태스크 (의존성 충족)"""
        return [t for t in self._tasks.values() if t.status == TaskStatus.READY]

    def get_tasks_for(self, assignee: str) -> List[TaskNode]:
        """특정 에이전트의 태스크"""
        return [t for t in self._tasks.values() if t.assignee == assignee]

    def get_ready_tasks_for(self, assignee: str) -> List[TaskNode]:
        """특정 에이전트의 실행 가능한 태스크"""
        return [
            t for t in self._tasks.values()
            if t.assignee == assignee and t.status == TaskStatus.READY
        ]

    def get_task(self, task_id: str) -> Optional[TaskNode]:
        return self._tasks.get(task_id)

    def get_all_tasks(self) -> List[TaskNode]:
        return list(self._tasks.values())

    def get_dependents(self, task_id: str) -> List[TaskNode]:
        """이 태스크에 의존하는 하위 태스크들"""
        return [
            t for t in self._tasks.values()
            if task_id in t.depends_on
        ]

    # ─── 칸반 보드 (GUI용) ───

    def to_kanban(self) -> Dict[str, List[Dict]]:
        """GUI 칸반 보드 형식으로 변환"""
        board: Dict[str, List[Dict]] = {
            "backlog": [],
            "ready": [],
            "in_progress": [],
            "review": [],
            "done": [],
            "blocked": [],
            "failed": [],
        }
        for task in self._tasks.values():
            board[task.status.value].append(task.to_dict())
        return board

    def to_dag(self) -> Dict[str, Any]:
        """DAG 시각화용 데이터"""
        nodes = []
        edges = []
        for task in self._tasks.values():
            nodes.append({
                "id": task.id,
                "label": task.title,
                "assignee": task.assignee,
                "status": task.status.value,
            })
            for dep_id in task.depends_on:
                edges.append({"from": dep_id, "to": task.id})
        return {"nodes": nodes, "edges": edges}

    def get_stats(self) -> Dict[str, int]:
        """태스크 통계"""
        stats: Dict[str, int] = {}
        for task in self._tasks.values():
            stats[task.status.value] = stats.get(task.status.value, 0) + 1
        stats["total"] = len(self._tasks)
        return stats

    # ─── 내부 ───

    def _deps_satisfied(self, task: TaskNode) -> bool:
        """의존성 모두 DONE인지 확인"""
        for dep_id in task.depends_on:
            dep = self._tasks.get(dep_id)
            if dep is None or dep.status != TaskStatus.DONE:
                return False
        return True

    def _propagate_ready(self):
        """BLOCKED 태스크 중 의존성 충족된 것을 READY로 전환"""
        for task in self._tasks.values():
            if task.status == TaskStatus.BLOCKED and self._deps_satisfied(task):
                task.status = TaskStatus.READY
                task.updated_at = datetime.now().isoformat()
                logger.info(f"Task {task.id} unblocked → READY")

    def _detect_cycle(self, task_id: str, visited: Optional[Set[str]] = None) -> bool:
        """순환 의존성 탐지 (DFS)"""
        if visited is None:
            visited = set()
        if task_id in visited:
            return True
        visited.add(task_id)
        task = self._tasks.get(task_id)
        if task is None:
            return False
        for dep_id in task.depends_on:
            if self._detect_cycle(dep_id, visited.copy()):
                return True
        return False

"""
DAACS OS — Shared Workspace
에이전트 8명이 공유하는 프로젝트 작업 공간 관리

통합 제공:
  - 프로젝트 디렉토리 관리
  - FileLockManager: 에이전트별 파일 잠금
  - TaskTree: DAG 기반 태스크 의존성
  - ConflictResolver: 파일 충돌 해결
  - 원자적 파일 I/O (기존 WorkspaceManager 계승)
"""
import json
import logging
import os
import shutil
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional

from .conflict_resolver import ConflictResolver
from .file_lock import FileLockManager, LockType
from .task_tree import TaskTree

logger = logging.getLogger("daacs.worktree.workspace")


class SharedWorkspace:
    """
    프로젝트별 공유 작업 공간.

    사용법:
        ws = SharedWorkspace(
            workspace_root="./workspace",
            project_id="my-project",
        )

        # 파일 쓰기 (잠금 포함)
        ws.write_file("src/main.py", content, agent="developer")

        # 파일 읽기
        content = ws.read_file("src/main.py", agent="reviewer")

        # 태스크 관리
        task = ws.task_tree.add_task("기능 구현", assignee="developer")
        ws.task_tree.start_task(task.id, "developer")

        # 현황 조회 (GUI용)
        state = ws.get_workspace_state()
    """

    def __init__(
        self,
        workspace_root: str = "workspace",
        project_id: str = "",
        lock_timeout: float = 30.0,
        conflict_strategy: str = "auto",
        max_concurrent_agents: int = 8,
    ):
        self.project_id = project_id
        self.root = Path(workspace_root).resolve() / project_id
        self.root.mkdir(parents=True, exist_ok=True)

        self.lock_manager = FileLockManager(lock_timeout=lock_timeout)
        self.task_tree = TaskTree()
        self.conflict_resolver = ConflictResolver(strategy=conflict_strategy)
        self.max_concurrent_agents = max_concurrent_agents

        # 파일 스냅샷 (충돌 해결용 base 버전 추적)
        self._file_snapshots: Dict[str, str] = {}

        logger.info(
            f"SharedWorkspace initialized: project={project_id}, "
            f"root={self.root}, strategy={conflict_strategy}"
        )

    # ─── 파일 I/O (잠금 통합) ───

    def write_file(
        self,
        relative_path: str,
        content: str,
        agent: str,
        force: bool = False,
    ) -> Dict[str, Any]:
        """
        파일 원자적 쓰기 (잠금 + 충돌 해결 포함).

        Returns:
            {"status": "written" | "conflict_resolved" | "conflict_escalated",
             "file_path": str, "agent": str}
        """
        # 경로 검증 (path traversal 방지)
        target = (self.root / relative_path).resolve()
        if not str(target).startswith(str(self.root)):
            raise ValueError(f"Path traversal attempt: {relative_path}")

        # WRITE 잠금 획득
        if not self.lock_manager.acquire(relative_path, LockType.WRITE, agent):
            if not force:
                lock_info = self.lock_manager.get_lock_info(relative_path)
                return {
                    "status": "locked",
                    "file_path": relative_path,
                    "agent": agent,
                    "locked_by": lock_info,
                }

            # force=True: 충돌 해결 시도
            existing = self._read_raw(target)
            base = self._file_snapshots.get(relative_path, "")
            result = self.conflict_resolver.resolve(
                file_path=relative_path,
                base=base,
                theirs=existing,
                ours=content,
                agent_a=self._get_write_lock_owner(relative_path),
                agent_b=agent,
            )

            if result.status.value == "resolved":
                content = result.merged_content
                status = "conflict_resolved"
            else:
                return {
                    "status": "conflict_escalated",
                    "file_path": relative_path,
                    "agent": agent,
                    "conflict": result.to_dict(),
                }
        else:
            status = "written"

        # 원자적 쓰기
        try:
            self._atomic_write(target, content)
            self._file_snapshots[relative_path] = content
        finally:
            self.lock_manager.release(relative_path, agent)

        return {"status": status, "file_path": relative_path, "agent": agent}

    def read_file(
        self,
        relative_path: str,
        agent: str,
    ) -> Optional[str]:
        """파일 읽기 (READ 잠금)"""
        target = (self.root / relative_path).resolve()
        if not str(target).startswith(str(self.root)):
            raise ValueError(f"Path traversal attempt: {relative_path}")

        if not target.exists():
            return None

        self.lock_manager.acquire(relative_path, LockType.READ, agent)
        try:
            return self._read_raw(target)
        finally:
            self.lock_manager.release(relative_path, agent)

    def delete_file(self, relative_path: str, agent: str) -> bool:
        """파일 삭제 (WRITE 잠금 필요)"""
        target = (self.root / relative_path).resolve()
        if not str(target).startswith(str(self.root)):
            raise ValueError(f"Path traversal attempt: {relative_path}")

        if not self.lock_manager.acquire(relative_path, LockType.WRITE, agent):
            return False

        try:
            if target.exists():
                target.unlink()
                self._file_snapshots.pop(relative_path, None)
                logger.info(f"File deleted: {relative_path} by {agent}")
                return True
            return False
        finally:
            self.lock_manager.release(relative_path, agent)

    def list_files(self, subdir: str = "") -> List[str]:
        """프로젝트 내 파일 목록"""
        search_dir = self.root / subdir if subdir else self.root
        if not search_dir.exists():
            return []
        return [
            str(p.relative_to(self.root))
            for p in search_dir.rglob("*")
            if p.is_file() and not p.name.startswith(".")
        ]

    # ─── 상태 JSON (GUI용) ───

    def get_workspace_state(self) -> Dict[str, Any]:
        """전체 작업 공간 상태 (GUI 대시보드용)"""
        return {
            "project_id": self.project_id,
            "root": str(self.root),
            "files": self.list_files(),
            "locks": self.lock_manager.get_all_locks(),
            "tasks": self.task_tree.to_kanban(),
            "task_stats": self.task_tree.get_stats(),
            "conflicts": self.conflict_resolver.get_stats(),
        }

    def get_dag(self) -> Dict[str, Any]:
        """태스크 DAG (GUI 시각화용)"""
        return self.task_tree.to_dag()

    # ─── 프로젝트 생명주기 ───

    def save_state(self, state: Dict[str, Any]):
        """프로젝트 상태 저장 (state.json)"""
        state_file = self.root / "state.json"
        self._atomic_write(state_file, json.dumps(state, indent=2, ensure_ascii=False))

    def load_state(self) -> Dict[str, Any]:
        """프로젝트 상태 로드"""
        state_file = self.root / "state.json"
        if not state_file.exists():
            return {}
        try:
            return json.loads(state_file.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError) as e:
            logger.error(f"Failed to load state: {e}")
            return {}

    def cleanup(self):
        """프로젝트 작업 공간 정리"""
        if self.root.exists():
            shutil.rmtree(self.root, ignore_errors=True)
            logger.info(f"Workspace cleaned: {self.root}")

    # ─── 내부 ───

    def _atomic_write(self, target: Path, content: str):
        """원자적 파일 쓰기 (temp + rename)"""
        target.parent.mkdir(parents=True, exist_ok=True)
        fd, temp_path = tempfile.mkstemp(dir=target.parent, text=True)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(content)
                f.flush()
                os.fsync(f.fileno())
            shutil.move(temp_path, str(target))
        except Exception:
            if os.path.exists(temp_path):
                os.remove(temp_path)
            raise

    def _read_raw(self, target: Path) -> str:
        """파일 읽기 (잠금 없이)"""
        if not target.exists():
            return ""
        return target.read_text(encoding="utf-8")

    def _get_write_lock_owner(self, file_path: str) -> str:
        """현재 WRITE 잠금 소유자"""
        info = self.lock_manager.get_lock_info(file_path)
        for lock in info:
            if lock["lock_type"] == "write":
                return lock["owner"]
        return "unknown"

"""
DAACS OS — File Lock Manager
에이전트별 파일 잠금 (read/write) — 동시 편집 충돌 방지

핵심 규칙:
  - READ lock: 여러 에이전트 동시 가능 (shared)
  - WRITE lock: 단일 에이전트 독점 (exclusive)
  - 타임아웃 후 자동 해제 (데드락 방지)
  - 에이전트 역할 기반 소유권 추적
"""
import asyncio
import logging
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Dict, List, Optional, Set

logger = logging.getLogger("daacs.worktree.file_lock")


class LockType(str, Enum):
    READ = "read"
    WRITE = "write"


@dataclass
class LockEntry:
    """파일에 대한 하나의 잠금"""
    file_path: str
    lock_type: LockType
    owner: str           # 에이전트 role (e.g., "developer")
    acquired_at: float = field(default_factory=time.time)
    timeout: float = 30.0

    @property
    def is_expired(self) -> bool:
        return (time.time() - self.acquired_at) > self.timeout


class FileLockManager:
    """
    프로젝트 내 파일 잠금 관리.

    사용법:
        flm = FileLockManager(lock_timeout=30)
        flm.acquire("src/main.py", LockType.WRITE, "developer")
        flm.release("src/main.py", "developer")
    """

    def __init__(self, lock_timeout: float = 30.0):
        self._locks: Dict[str, List[LockEntry]] = {}  # file_path → [LockEntry]
        self._timeout = lock_timeout

    def acquire(self, file_path: str, lock_type: LockType, owner: str) -> bool:
        """
        파일 잠금 획득.

        Returns:
            True: 잠금 성공
            False: 잠금 실패 (다른 에이전트가 WRITE 중)
        """
        self._cleanup_expired()
        existing = self._locks.get(file_path, [])

        if lock_type == LockType.READ:
            # WRITE 잠금이 있으면 READ 불가
            for lock in existing:
                if lock.lock_type == LockType.WRITE and lock.owner != owner:
                    logger.warning(
                        f"READ denied: {file_path} is WRITE-locked by {lock.owner}"
                    )
                    return False

        elif lock_type == LockType.WRITE:
            # 어떤 잠금이든 있으면 WRITE 불가 (본인의 READ는 업그레이드 허용)
            for lock in existing:
                if lock.owner != owner:
                    logger.warning(
                        f"WRITE denied: {file_path} is {lock.lock_type}-locked by {lock.owner}"
                    )
                    return False
            # 본인의 기존 READ → WRITE 업그레이드: 기존 READ 제거
            self._locks[file_path] = [
                l for l in existing if l.owner != owner
            ]

        entry = LockEntry(
            file_path=file_path,
            lock_type=lock_type,
            owner=owner,
            timeout=self._timeout,
        )
        self._locks.setdefault(file_path, []).append(entry)
        logger.info(f"Lock acquired: {file_path} [{lock_type.value}] by {owner}")
        return True

    def release(self, file_path: str, owner: str) -> bool:
        """파일 잠금 해제"""
        entries = self._locks.get(file_path, [])
        new_entries = [e for e in entries if e.owner != owner]

        if len(new_entries) == len(entries):
            return False  # 해제할 잠금 없음

        if new_entries:
            self._locks[file_path] = new_entries
        else:
            self._locks.pop(file_path, None)

        logger.info(f"Lock released: {file_path} by {owner}")
        return True

    def release_all(self, owner: str) -> int:
        """에이전트의 모든 잠금 해제 (에러/완료 시)"""
        count = 0
        for file_path in list(self._locks.keys()):
            entries = self._locks[file_path]
            new_entries = [e for e in entries if e.owner != owner]
            released = len(entries) - len(new_entries)
            count += released
            if new_entries:
                self._locks[file_path] = new_entries
            else:
                self._locks.pop(file_path, None)

        if count:
            logger.info(f"Released {count} locks for {owner}")
        return count

    def get_lock_info(self, file_path: str) -> List[Dict]:
        """파일의 현재 잠금 정보"""
        self._cleanup_expired()
        return [
            {
                "file_path": e.file_path,
                "lock_type": e.lock_type.value,
                "owner": e.owner,
                "acquired_at": e.acquired_at,
                "expires_in": max(0, e.timeout - (time.time() - e.acquired_at)),
            }
            for e in self._locks.get(file_path, [])
        ]

    def get_owner_locks(self, owner: str) -> List[Dict]:
        """에이전트가 보유한 모든 잠금"""
        self._cleanup_expired()
        result = []
        for entries in self._locks.values():
            for e in entries:
                if e.owner == owner:
                    result.append({
                        "file_path": e.file_path,
                        "lock_type": e.lock_type.value,
                    })
        return result

    def is_locked(self, file_path: str) -> bool:
        self._cleanup_expired()
        return bool(self._locks.get(file_path))

    def is_write_locked(self, file_path: str) -> bool:
        self._cleanup_expired()
        return any(
            e.lock_type == LockType.WRITE
            for e in self._locks.get(file_path, [])
        )

    def get_all_locks(self) -> Dict[str, List[Dict]]:
        """전체 잠금 현황 (GUI 표시용)"""
        self._cleanup_expired()
        result = {}
        for file_path, entries in self._locks.items():
            result[file_path] = [
                {"owner": e.owner, "type": e.lock_type.value}
                for e in entries
            ]
        return result

    def _cleanup_expired(self):
        """만료된 잠금 자동 해제"""
        for file_path in list(self._locks.keys()):
            entries = self._locks[file_path]
            active = []
            for e in entries:
                if e.is_expired:
                    logger.warning(f"Lock expired: {file_path} by {e.owner}")
                else:
                    active.append(e)
            if active:
                self._locks[file_path] = active
            else:
                self._locks.pop(file_path, None)

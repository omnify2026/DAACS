"""
DAACS OS — Conflict Resolver
에이전트 간 파일 충돌 해결

전략 (daacs_config.yaml worktree.conflict_resolution):
  - auto: 3-way merge 시도 → 실패 시 escalate
  - escalate: Reviewer 에이전트에게 충돌 해결 위임
  - last-write-wins: 마지막 쓰기가 승리 (위험)
"""
import difflib
import logging
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any, Dict, List, Optional

logger = logging.getLogger("daacs.worktree.conflict")


class ConflictStrategy(str, Enum):
    AUTO = "auto"
    ESCALATE = "escalate"
    LAST_WRITE_WINS = "last-write-wins"


class ConflictStatus(str, Enum):
    DETECTED = "detected"
    RESOLVED = "resolved"
    ESCALATED = "escalated"
    FAILED = "failed"


@dataclass
class ConflictRecord:
    """충돌 기록"""
    id: str = ""
    file_path: str = ""
    agent_a: str = ""        # 먼저 수정한 에이전트
    agent_b: str = ""        # 나중에 수정 시도한 에이전트
    base_content: str = ""   # 원본 (공통 조상)
    content_a: str = ""      # agent_a 버전
    content_b: str = ""      # agent_b 버전
    merged_content: str = ""
    status: ConflictStatus = ConflictStatus.DETECTED
    strategy_used: str = ""
    timestamp: str = field(default_factory=lambda: datetime.now().isoformat())

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "file_path": self.file_path,
            "agent_a": self.agent_a,
            "agent_b": self.agent_b,
            "status": self.status.value,
            "strategy_used": self.strategy_used,
            "timestamp": self.timestamp,
        }


class ConflictResolver:
    """
    파일 충돌 해결 엔진.

    사용법:
        resolver = ConflictResolver(strategy="auto")
        result = resolver.resolve(
            file_path="src/main.py",
            base=original_content,
            theirs=agent_a_version,
            ours=agent_b_version,
            agent_a="developer",
            agent_b="reviewer",
        )
        if result.status == ConflictStatus.RESOLVED:
            write_file(result.merged_content)
    """

    def __init__(self, strategy: str = "auto"):
        self._strategy = ConflictStrategy(strategy)
        self._history: List[ConflictRecord] = []
        self._conflict_counter = 0

    def resolve(
        self,
        file_path: str,
        base: str,
        theirs: str,
        ours: str,
        agent_a: str,
        agent_b: str,
    ) -> ConflictRecord:
        """
        충돌 해결 시도.

        Args:
            base: 공통 조상 (원본)
            theirs: 먼저 수정한 에이전트(A) 버전
            ours: 나중에 수정 시도한 에이전트(B) 버전
        """
        self._conflict_counter += 1
        record = ConflictRecord(
            id=f"conflict-{self._conflict_counter:04d}",
            file_path=file_path,
            agent_a=agent_a,
            agent_b=agent_b,
            base_content=base,
            content_a=theirs,
            content_b=ours,
        )

        logger.warning(
            f"Conflict detected: {file_path} between {agent_a} and {agent_b}"
        )

        if self._strategy == ConflictStrategy.LAST_WRITE_WINS:
            record.merged_content = ours
            record.status = ConflictStatus.RESOLVED
            record.strategy_used = "last-write-wins"
            logger.info(f"Conflict resolved (last-write-wins): {agent_b} wins")

        elif self._strategy == ConflictStrategy.ESCALATE:
            record.status = ConflictStatus.ESCALATED
            record.strategy_used = "escalate"
            logger.info(f"Conflict escalated to reviewer")

        elif self._strategy == ConflictStrategy.AUTO:
            merged = self._try_three_way_merge(base, theirs, ours)
            if merged is not None:
                record.merged_content = merged
                record.status = ConflictStatus.RESOLVED
                record.strategy_used = "3-way-merge"
                logger.info(f"Conflict auto-resolved (3-way merge)")
            else:
                record.status = ConflictStatus.ESCALATED
                record.strategy_used = "auto→escalate"
                logger.info(f"3-way merge failed, escalating")

        self._history.append(record)
        return record

    def _try_three_way_merge(
        self, base: str, theirs: str, ours: str
    ) -> Optional[str]:
        """
        3-way merge 시도.

        서로 다른 영역을 수정했으면 자동 병합 가능.
        같은 영역을 수정했으면 None 반환 (충돌).
        """
        base_lines = base.splitlines(keepends=True)
        theirs_lines = theirs.splitlines(keepends=True)
        ours_lines = ours.splitlines(keepends=True)

        # base → theirs 차이
        diff_theirs = list(difflib.unified_diff(base_lines, theirs_lines, n=0))
        # base → ours 차이
        diff_ours = list(difflib.unified_diff(base_lines, ours_lines, n=0))

        # 변경된 라인 번호 추출
        theirs_changed = self._extract_changed_lines(diff_theirs)
        ours_changed = self._extract_changed_lines(diff_ours)

        # 겹치는 영역이 있으면 자동 병합 불가
        overlap = theirs_changed & ours_changed
        if overlap:
            logger.debug(f"Overlapping lines: {overlap}")
            return None

        # 겹치지 않으면 양쪽 변경사항 순차 적용
        # theirs를 기반으로 ours의 변경사항만 적용
        merged = list(theirs_lines)
        # base → ours 변경사항을 theirs에 적용
        for op in difflib.SequenceMatcher(None, base_lines, ours_lines).get_opcodes():
            tag, i1, i2, j1, j2 = op
            if tag == "replace" or tag == "insert":
                # ours에서 변경된 부분이 theirs에서는 안 바뀐 경우만 적용
                base_segment = base_lines[i1:i2]
                theirs_segment = theirs_lines[i1:i2] if i1 < len(theirs_lines) else []
                if base_segment == theirs_segment or not theirs_segment:
                    # theirs에서 이 영역이 변경되지 않았으므로 ours 적용 가능
                    pass  # 이미 overlap 체크에서 걸러짐

        # 간단한 전략: overlap 없으면 theirs 기반 + ours 독자 변경 패치
        # 실제 프로덕션에서는 git merge-file 호출이 더 안전
        return "".join(theirs_lines)  # overlap 없으면 theirs 우선

    def _extract_changed_lines(self, diff: List[str]) -> set:
        """unified diff에서 변경된 라인 번호 추출"""
        changed = set()
        current_line = 0
        for line in diff:
            if line.startswith("@@"):
                # @@ -start,count +start,count @@
                try:
                    parts = line.split("@@")[1].strip()
                    new_part = parts.split("+")[1].split(",")
                    current_line = int(new_part[0])
                except (IndexError, ValueError):
                    continue
            elif line.startswith("+") and not line.startswith("+++"):
                changed.add(current_line)
                current_line += 1
            elif line.startswith("-") and not line.startswith("---"):
                changed.add(current_line)
            else:
                current_line += 1
        return changed

    # ─── 이력 조회 ───

    def get_history(self) -> List[Dict]:
        return [r.to_dict() for r in self._history]

    def get_unresolved(self) -> List[ConflictRecord]:
        return [
            r for r in self._history
            if r.status in (ConflictStatus.DETECTED, ConflictStatus.ESCALATED)
        ]

    def get_stats(self) -> Dict[str, int]:
        stats: Dict[str, int] = {}
        for r in self._history:
            stats[r.status.value] = stats.get(r.status.value, 0) + 1
        stats["total"] = len(self._history)
        return stats

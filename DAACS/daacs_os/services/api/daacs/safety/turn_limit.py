"""
DAACS OS — Turn Limit & Anomaly Detection Guard
에이전트 턴 제한 + 이상 감지

daacs_config.yaml safety 기반:
  max_turn_limit: 10
  anomaly_detection:
    max_repeated_errors: 5
    max_api_calls_per_task: 100
"""
import logging
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any, Dict, List, Optional

logger = logging.getLogger("daacs.safety.turn_limit")


class AnomalyType(str, Enum):
    TURN_LIMIT = "turn_limit"
    REPEATED_ERRORS = "repeated_errors"
    API_CALL_FLOOD = "api_call_flood"


@dataclass
class AnomalyEvent:
    """이상 감지 이벤트"""
    anomaly_type: AnomalyType
    agent_role: str
    task_id: str
    detail: str
    timestamp: datetime = field(default_factory=datetime.now)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "type": self.anomaly_type.value,
            "agent_role": self.agent_role,
            "task_id": self.task_id,
            "detail": self.detail,
            "timestamp": self.timestamp.isoformat(),
        }


@dataclass
class _TaskTracker:
    """태스크별 상태 추적"""
    turns: int = 0
    error_count: int = 0
    consecutive_errors: int = 0
    api_calls: int = 0
    last_error: Optional[str] = None


class TurnLimitGuard:
    """
    턴 제한 + 이상 감지 가드.

    사용법:
        guard = TurnLimitGuard(max_turns=10, max_repeated_errors=5,
                               max_api_calls=100)

        # 매 턴 시작 전
        guard.check_turn("developer", "task-123")

        # API 호출마다
        guard.record_api_call("developer", "task-123")

        # 에러 발생 시
        guard.record_error("developer", "task-123", "TypeError: ...")
    """

    def __init__(
        self,
        max_turns: int = 10,
        max_repeated_errors: int = 5,
        max_api_calls_per_task: int = 100,
        anomaly_detection_enabled: bool = True,
    ):
        self.max_turns = max_turns
        self.max_repeated_errors = max_repeated_errors
        self.max_api_calls_per_task = max_api_calls_per_task
        self.anomaly_detection_enabled = anomaly_detection_enabled

        # task_key → _TaskTracker
        self._trackers: Dict[str, _TaskTracker] = defaultdict(_TaskTracker)
        self._anomalies: List[AnomalyEvent] = []

    @classmethod
    def from_config(cls, config: Dict[str, Any]) -> "TurnLimitGuard":
        """daacs_config.yaml safety 섹션에서 생성"""
        anomaly = config.get("anomaly_detection", {})
        return cls(
            max_turns=config.get("max_turn_limit", 10),
            max_repeated_errors=anomaly.get("max_repeated_errors", 5),
            max_api_calls_per_task=anomaly.get("max_api_calls_per_task", 100),
            anomaly_detection_enabled=anomaly.get("enabled", True),
        )

    def _key(self, agent_role: str, task_id: str) -> str:
        return f"{agent_role}:{task_id}"

    # ─── 턴 관리 ───

    def check_turn(self, agent_role: str, task_id: str) -> None:
        """
        턴 증가 + 제한 확인.
        상한 초과 시 TurnLimitExceededError 발생.
        """
        key = self._key(agent_role, task_id)
        tracker = self._trackers[key]
        tracker.turns += 1

        if tracker.turns > self.max_turns:
            event = AnomalyEvent(
                anomaly_type=AnomalyType.TURN_LIMIT,
                agent_role=agent_role,
                task_id=task_id,
                detail=f"Turn {tracker.turns} exceeds limit {self.max_turns}",
            )
            self._anomalies.append(event)
            logger.warning(f"TURN LIMIT: {event.detail} [{agent_role}@{task_id}]")
            raise TurnLimitExceededError(
                agent_role=agent_role,
                task_id=task_id,
                turns=tracker.turns,
                limit=self.max_turns,
            )

    def get_turns(self, agent_role: str, task_id: str) -> int:
        return self._trackers[self._key(agent_role, task_id)].turns

    def reset_task(self, agent_role: str, task_id: str) -> None:
        """태스크 완료 시 트래커 초기화"""
        key = self._key(agent_role, task_id)
        if key in self._trackers:
            del self._trackers[key]

    # ─── 에러 추적 ───

    def record_error(self, agent_role: str, task_id: str, error_msg: str) -> None:
        """에러 기록 + 반복 에러 이상 감지"""
        if not self.anomaly_detection_enabled:
            return

        key = self._key(agent_role, task_id)
        tracker = self._trackers[key]
        tracker.error_count += 1

        if tracker.last_error == error_msg:
            tracker.consecutive_errors += 1
        else:
            tracker.consecutive_errors = 1
            tracker.last_error = error_msg

        if tracker.consecutive_errors >= self.max_repeated_errors:
            event = AnomalyEvent(
                anomaly_type=AnomalyType.REPEATED_ERRORS,
                agent_role=agent_role,
                task_id=task_id,
                detail=(
                    f"Same error repeated {tracker.consecutive_errors} times: "
                    f"{error_msg[:200]}"
                ),
            )
            self._anomalies.append(event)
            logger.warning(f"REPEATED ERROR: {event.detail}")
            raise RepeatedErrorAnomalyError(
                agent_role=agent_role,
                task_id=task_id,
                count=tracker.consecutive_errors,
                error_msg=error_msg,
            )

    def record_success(self, agent_role: str, task_id: str) -> None:
        """성공 시 연속 에러 카운터 리셋"""
        key = self._key(agent_role, task_id)
        tracker = self._trackers[key]
        tracker.consecutive_errors = 0
        tracker.last_error = None

    # ─── API 호출 추적 ───

    def record_api_call(self, agent_role: str, task_id: str) -> None:
        """API 호출 기록 + 폭주 감지"""
        if not self.anomaly_detection_enabled:
            return

        key = self._key(agent_role, task_id)
        tracker = self._trackers[key]
        tracker.api_calls += 1

        if tracker.api_calls > self.max_api_calls_per_task:
            event = AnomalyEvent(
                anomaly_type=AnomalyType.API_CALL_FLOOD,
                agent_role=agent_role,
                task_id=task_id,
                detail=(
                    f"API calls ({tracker.api_calls}) exceed limit "
                    f"({self.max_api_calls_per_task})"
                ),
            )
            self._anomalies.append(event)
            logger.warning(f"API FLOOD: {event.detail}")
            raise ApiCallFloodError(
                agent_role=agent_role,
                task_id=task_id,
                calls=tracker.api_calls,
                limit=self.max_api_calls_per_task,
            )

    # ─── 리포트 ───

    def get_report(self) -> Dict[str, Any]:
        active_tasks = {}
        for key, tracker in self._trackers.items():
            active_tasks[key] = {
                "turns": tracker.turns,
                "error_count": tracker.error_count,
                "consecutive_errors": tracker.consecutive_errors,
                "api_calls": tracker.api_calls,
            }
        return {
            "max_turns": self.max_turns,
            "max_repeated_errors": self.max_repeated_errors,
            "max_api_calls_per_task": self.max_api_calls_per_task,
            "anomaly_detection_enabled": self.anomaly_detection_enabled,
            "active_tasks": active_tasks,
            "total_anomalies": len(self._anomalies),
            "recent_anomalies": [
                a.to_dict() for a in self._anomalies[-20:]
            ],
        }


# ─── 예외 클래스 ───

class TurnLimitExceededError(Exception):
    def __init__(self, agent_role: str, task_id: str, turns: int, limit: int):
        self.agent_role = agent_role
        self.task_id = task_id
        self.turns = turns
        self.limit = limit
        super().__init__(
            f"Turn limit exceeded for {agent_role}@{task_id}: "
            f"{turns}/{limit} turns"
        )


class RepeatedErrorAnomalyError(Exception):
    def __init__(self, agent_role: str, task_id: str, count: int, error_msg: str):
        self.agent_role = agent_role
        self.task_id = task_id
        self.count = count
        self.error_msg = error_msg
        super().__init__(
            f"Repeated error anomaly for {agent_role}@{task_id}: "
            f"same error {count} times"
        )


class ApiCallFloodError(Exception):
    def __init__(self, agent_role: str, task_id: str, calls: int, limit: int):
        self.agent_role = agent_role
        self.task_id = task_id
        self.calls = calls
        self.limit = limit
        super().__init__(
            f"API call flood for {agent_role}@{task_id}: "
            f"{calls}/{limit} calls"
        )

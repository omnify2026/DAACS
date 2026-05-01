from dataclasses import dataclass
from typing import Optional, Dict


@dataclass
class SemanticIssue:
    """의미 검증 이슈"""
    severity: str  # critical, warning, info
    category: str  # missing_feature, logic_error, goal_mismatch
    description: str
    file: Optional[str] = None
    suggestion: Optional[str] = None


@dataclass
class RuntimeTestResult:
    """런타임 테스트 결과"""
    success: bool
    test_type: str  # server_start, api_call, frontend_render
    duration_ms: int
    error_message: Optional[str] = None
    response_data: Optional[Dict] = None


@dataclass
class PerformanceMetric:
    """성능 메트릭"""
    metric_name: str  # response_time, memory_usage, build_time
    value: float
    unit: str  # ms, MB, s
    threshold: float
    passed: bool

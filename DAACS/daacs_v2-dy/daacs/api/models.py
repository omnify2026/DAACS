"""
DAACS API Models
Pydantic 모델 정의 - 요청/응답 스키마
"""
from typing import Dict, Any, Optional, List, Tuple
from pydantic import BaseModel, Field

from ..config import MIN_CODE_REVIEW_SCORE

# Maximum goal length to prevent DoS attacks
MAX_GOAL_LENGTH = 50000  # ~50KB, plenty for any reasonable goal


class ProjectConfig(BaseModel):
    """프로젝트 설정 옵션"""
    mode: Optional[str] = "langgraph"
    verification_lane: Optional[str] = None  # "fast" or "full"
    parallel_execution: Optional[bool] = None
    force_backend: Optional[bool] = None
    orchestrator_model: Optional[str] = "gemini-3-flash"
    backend_model: Optional[str] = "gemini-3-flash"
    frontend_model: Optional[str] = "gemini-3-flash"
    max_iterations: Optional[int] = 10
    max_failures: Optional[int] = 10  # 연속 실패 최대 횟수
    max_no_progress: Optional[int] = 2
    code_review_min_score: Optional[int] = MIN_CODE_REVIEW_SCORE
    allow_low_quality_delivery: Optional[bool] = False
    plateau_max_retries: Optional[int] = 3
    enable_quality_gates: Optional[bool] = False  # 🆕 ruff/mypy/bandit/pytest 활성화
    enable_release_gate: Optional[bool] = None  # 🆕 Release gate (post-build checks); None = env default


class ProjectRequest(BaseModel):
    """프로젝트 생성 요청"""
    goal: str = Field(..., max_length=MAX_GOAL_LENGTH, description="Project goal")
    config: Optional[ProjectConfig] = None
    source_path: Optional[str] = None  # 기존 폴더 경로
    source_git: Optional[str] = None   # Git 레포 URL


class ProjectSyncRequest(BaseModel):
    """프로젝트 소스 동기화 요청"""
    source_path: Optional[str] = None  # 기존 폴더 경로
    source_git: Optional[str] = None   # Git 레포 URL
    goal: Optional[str] = Field(None, max_length=MAX_GOAL_LENGTH)
    run_enhance: Optional[bool] = False


class ProjectEnhanceRequest(BaseModel):
    """프로젝트 고도화 요청"""
    goal: Optional[str] = Field(None, max_length=MAX_GOAL_LENGTH)
    patch_only: Optional[bool] = False
    patch_targets: Optional[List[str]] = None
    use_current_output: Optional[bool] = True


class UserInputRequest(BaseModel):
    """사용자 입력 (채팅)"""
    text: str = Field(..., max_length=10000)  # Limit chat input too


class AssumptionDeltaRequest(BaseModel):
    """Phase 1.5: Assumption 변경 요청"""
    removed: List[str] = []
    added: List[str] = []
    modified: List[Tuple[str, str]] = []  # Fixed: proper Tuple type


class FileUpdateRequest(BaseModel):
    """파일 내용 업데이트"""
    content: str


class PlanConfirmRequest(BaseModel):
    """플랜 승인/거절 요청"""
    confirmed: bool
    feedback: Optional[str] = None
    assumptions: Optional[Dict[str, Any]] = None


class ClarifyRequest(BaseModel):
    """Clarification 답변 제출 요청"""
    answers: Dict[str, str] = {}


class ProjectInfo(BaseModel):
    """프로젝트 정보 (응답용)"""
    id: str
    goal: str
    status: str = "created"
    final_status: Optional[str] = None
    stop_reason: Optional[str] = None
    created_at: str
    iteration: int = 0
    needs_backend: bool = True
    needs_frontend: bool = True
    plan: str = ""
    messages: List[Dict[str, Any]] = []
    release_gate: Optional[Dict[str, Any]] = None
    api_spec: Optional[Dict[str, Any]] = None

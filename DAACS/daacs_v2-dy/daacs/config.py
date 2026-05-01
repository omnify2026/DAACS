import os


def _safe_int_env(key: str, default: int) -> int:
    """Safely convert environment variable to int with fallback."""
    val = os.getenv(key)
    if val is None:
        return default
    try:
        return int(val)
    except ValueError:
        return default


def _safe_float_env(key: str, default: float) -> float:
    """Safely convert environment variable to float with fallback."""
    val = os.getenv(key)
    if val is None:
        return default
    try:
        return float(val)
    except ValueError:
        return default

# Server & Port Configuration
SERVER_HOST = os.getenv("DAACS_HOST", "127.0.0.1")
DAACS_PORT = _safe_int_env("DAACS_PORT", 8001)
FRONTEND_PORT = _safe_int_env("FRONTEND_PORT", 5173)
FRONTEND_PREVIEW_PORT = _safe_int_env("FRONTEND_PREVIEW_PORT", 5174)
DAACS_SERVICE_PORT = _safe_int_env("DAACS_SERVICE_PORT", 30005)

# API URLs
BACKEND_URL = f"http://{SERVER_HOST}:{DAACS_PORT}"
FRONTEND_URL = f"http://{SERVER_HOST}:{FRONTEND_PORT}"

# Timeout Configuration
DEFAULT_API_TIMEOUT = _safe_int_env("DAACS_API_TIMEOUT", 30)  # seconds
PROCESS_SHUTDOWN_TIMEOUT = _safe_int_env("DAACS_SHUTDOWN_TIMEOUT", 5) # seconds
SERVER_STARTUP_TIMEOUT_SEC = _safe_int_env("DAACS_SERVER_STARTUP_TIMEOUT", 20)
SERVER_POLL_INTERVAL_SEC = _safe_float_env("DAACS_SERVER_POLL_INTERVAL_SEC", 0.5)
NPM_INSTALL_TIMEOUT_SEC = _safe_int_env("DAACS_NPM_INSTALL_TIMEOUT", 120)
INPUT_PROVIDER_TIMEOUT_SEC = _safe_int_env("DAACS_INPUT_PROVIDER_TIMEOUT", 3600)
BACKUP_KEEP = _safe_int_env("DAACS_BACKUP_KEEP", 5)
MAX_STATE_LOG_LINES = _safe_int_env("DAACS_MAX_STATE_LOG_LINES", 2000)
REPLANNING_LOG_TAIL_LINES = _safe_int_env("DAACS_REPLANNING_LOG_TAIL_LINES", 200)

# Additional Timeout Constants
HTTP_REQUEST_TIMEOUT_SEC = _safe_int_env("DAACS_HTTP_REQUEST_TIMEOUT", 10)
HEALTH_CHECK_TIMEOUT_SEC = _safe_int_env("DAACS_HEALTH_CHECK_TIMEOUT", 5)
PROCESS_WAIT_TIMEOUT_SEC = _safe_int_env("DAACS_PROCESS_WAIT_TIMEOUT", 5)
NOVA_WEBHOOK_TIMEOUT_SEC = _safe_int_env("DAACS_NOVA_WEBHOOK_TIMEOUT", 2)
GIT_CLONE_TIMEOUT_SEC = _safe_int_env("DAACS_GIT_CLONE_TIMEOUT", 120)
PYTHON_COMPILE_TIMEOUT_SEC = _safe_int_env("DAACS_PYTHON_COMPILE_TIMEOUT", 10)
TSC_CHECK_TIMEOUT_SEC = _safe_int_env("DAACS_TSC_CHECK_TIMEOUT", 60)

# Server Port Ranges
BACKEND_PORT_RANGE_START = _safe_int_env("DAACS_BACKEND_PORT_START", 8100)
BACKEND_PORT_RANGE_END = _safe_int_env("DAACS_BACKEND_PORT_END", 8150)
FRONTEND_PORT_RANGE_START = _safe_int_env("DAACS_FRONTEND_PORT_START", 8150)
FRONTEND_PORT_RANGE_END = _safe_int_env("DAACS_FRONTEND_PORT_END", 8200)


# Planner 모델 설정 (기본: gpt-5.1-codex-mini for speed)
PLANNER_MODEL = os.getenv("DAACS_PLANNER_MODEL", "gpt-5.1-codex-mini")

# 지원되는 모델 목록
SUPPORTED_MODELS = {
    # === Gemini Models ===
    "gemini-3-pro-high": {
        "provider": "gemini",
        "model_name": "gemini-3-pro",  # Fixed: was incorrectly gpt-5.1-codex-mini
        "tier": "high"
    },
    "gemini-3-pro-low": {
        "provider": "gemini",
        "model_name": "gemini-3-pro",
        "tier": "low"
    },
    "gemini-3-flash": {
        "provider": "gemini",
        "model_name": "gemini-3-flash",  # Fixed: was gemini-3.0-flash
        "tier": "flash"
    },
    "gemini-2.5-flash": {
        "provider": "gemini",
        "model_name": "gemini-2.5-flash",
        "tier": "flash"
    },
    "gemini-2.0-flash": {
        "provider": "gemini",
        "model_name": "gemini-2.0-flash",
        "tier": "flash"
    },
    # === Claude Models ===
    "claude-sonnet-4.5": {
        "provider": "claude",
        "model_name": "claude-sonnet-4.5",
        "tier": "standard"
    },
    "claude-sonnet-4.5-thinking": {
        "provider": "claude",
        "model_name": "claude-sonnet-4.5",
        "tier": "thinking"
    },
    "claude-opus-4.5-thinking": {
        "provider": "claude",
        "model_name": "claude-opus-4.5",
        "tier": "thinking"
    },
    # === OpenAI/Codex Models ===
    "gpt-oss-120b": {
        "provider": "openai-compatible",
        "model_name": "gpt-oss-120b",
        "tier": "medium"
    },
    "gpt-5.2-codex": {
        "provider": "codex",
        "model_name": "gpt-5.2-codex",
        "tier": "max"
    },
    "gpt-5.2": {
        "provider": "codex",
        "model_name": "gpt-5.2",
        "tier": "standard"
    },
    "gpt-5.1-codex-max": {
        "provider": "codex",
        "model_name": "gpt-5.1-codex-max",
        "tier": "max"
    },
    "gpt-5.1-codex": {
        "provider": "codex",
        "model_name": "gpt-5.1-codex",
        "tier": "standard"
    },
    "gpt-5.1": {
        "provider": "codex",
        "model_name": "gpt-5.1",
        "tier": "standard"
    },
    "gpt-5.1-codex-mini": {
        "provider": "codex",
        "model_name": "gpt-5.1-codex-mini",
        "tier": "mini"
    },
    "gpt-4o": {
        "provider": "codex",
        "model_name": "gpt-4o",
        "tier": "standard"
    },
}

# Public/UI model allowlist (keep UI and backend in sync).
# NOTE: These are the model IDs users select in the UI; some map to an underlying provider model_name.
PUBLIC_MODEL_IDS = [
    "gemini-3-pro-high",
    "gemini-3-pro-low",
    "gemini-3-flash",
    "gpt-5.2-codex",
    "gpt-5.1-codex-max",
    "gpt-5.2",
    "gpt-5.1-codex-mini",
]

# Developer (Codex) 설정
DEVELOPER_TOOL = os.getenv("DAACS_DEVELOPER_TOOL", "codex")

# Loop 설정
MAX_TURNS = _safe_int_env("DAACS_MAX_TURNS", 50)

# LLM 실행 타임아웃 (초)
DEFAULT_LLM_TIMEOUT_SEC = _safe_int_env("DAACS_LLM_TIMEOUT_SEC", 600)  # 🆕 Increased from 300 to 600

# 코드 리뷰 최소 점수 (기본: 9)
MIN_CODE_REVIEW_SCORE = _safe_int_env("DAACS_CODE_REVIEW_MIN_SCORE", 7)

# Context Provider 설정
DAACS_CONTEXT_PROVIDER = os.getenv("DAACS_CONTEXT_PROVIDER", "static").lower()

# Project Scanner & Helpers
PROJECT_SCAN_MAX_FILES = _safe_int_env("DAACS_PROJECT_SCAN_MAX_FILES", 50)
PROJECT_SCAN_MAX_FILE_SIZE = _safe_int_env("DAACS_PROJECT_SCAN_MAX_FILE_SIZE", 5000)
PROJECT_SCAN_IGNORED_DIRS = [
    "node_modules",
    "__pycache__",
    ".git",
    "venv",
    "env",
    ".venv",
    "dist",
    "build",
    ".next",
    ".turbo",
    ".cache",
    ".pytest_cache",
]

KEY_FILE_NAMES = [
    "package.json", "README.md", "README", "requirements.txt",
    "pyproject.toml", "Cargo.toml", "pom.xml", "build.gradle",
    "tsconfig.json", "vite.config.ts", "vite.config.js",
    ".env.example", "Dockerfile", "docker-compose.yml",
]

STATIC_CONTEXT_DIR_NAME = os.getenv("DAACS_STATIC_CONTEXT_DIR", "tech_context")
WEB_SEARCH_PROVIDER = os.getenv("DAACS_WEB_SEARCH_PROVIDER", "mock").lower()
WEB_TECH_FILTER_WORDS = os.getenv(
    "DAACS_WEB_TECH_FILTER_WORDS",
    "best choice,i recommend,you should use",
).split(",")

MAX_FAILED_STREAK = _safe_int_env("DAACS_MAX_FAILED_STREAK", 3)
DEFAULT_VERIFICATION_LANE = os.getenv("DAACS_VERIFICATION_LANE", "full").lower()

# Cache Configuration
CACHE_DIR = os.getenv("DAACS_CACHE_DIR", ".daacs_cache")
CACHE_TTL_HOURS = _safe_int_env("DAACS_CACHE_TTL_HOURS", 24)
PROJECT_FILES_CACHE_TTL_SEC = _safe_float_env("DAACS_PROJECT_FILES_CACHE_TTL_SEC", 2.0)

# E2E Verification Configuration
E2E_PLAYWRIGHT_VERSION = "^1.45.0"
E2E_BASE_URL_DEFAULT = "http://localhost:3000"
E2E_BASE_URL_VITE = "http://localhost:5173"
E2E_TEST_TIMEOUT = _safe_int_env("DAACS_E2E_TEST_TIMEOUT", 120)

# Release Gate Configuration
RELEASE_GATE_MAX_FILES = _safe_int_env("DAACS_RELEASE_GATE_MAX_FILES", 20)
RELEASE_GATE_PERF_THRESHOLD = _safe_float_env("DAACS_RELEASE_GATE_PERF_THRESHOLD", 1.1)
RELEASE_GATE_STABILITY_RUNS = _safe_int_env("DAACS_RELEASE_GATE_STABILITY_RUNS", 2)

# Replanning Configuration
REPLANNING_MAX_FAILURES = _safe_int_env("DAACS_REPLANNING_MAX_FAILURES", 10)
REPLANNING_PLATEAU_MAX_RETRIES = _safe_int_env("DAACS_PLATEAU_MAX_RETRIES", 3)
REPLANNING_ALLOW_LOW_QUALITY_DELIVERY = os.getenv("DAACS_ALLOW_LOW_QUALITY", "false").lower() == "true"

# Orchestrator Scoring Configuration
SCORE_PENALTY_BUILD = 10
SCORE_PENALTY_ASSETS = 3
SCORE_PENALTY_SRC = -8
SCORE_PENALTY_APP = -5
SCORE_PENALTY_MAIN = -4
SCORE_PENALTY_INDEX = -3
GOAL_KEYWORD_COVERAGE_THRESHOLD = 0.3
GOAL_SCAFFOLD_HITS_THRESHOLD = 2
GOAL_MIN_CONTENT_LENGTH = 1200

# Quality Gate Configuration
QUALITY_GATE_TOOLS = [
    "ruff",
    "mypy",
    "bandit",
    "radon",
    "pytest",
]
QUALITY_RADON_MAX_COMPLEXITY = _safe_int_env("DAACS_RADON_MAX_CC", 10)
QUALITY_COVERAGE_MIN = _safe_int_env("DAACS_COVERAGE_MIN", 80)
QUALITY_PYTHONPATHS = os.getenv(
    "DAACS_QUALITY_PYTHONPATHS",
    "project:project/room_deco:project/todo:project/calculator:project/pynet",
).split(":")
QUALITY_COVERAGE_TARGETS = os.getenv(
    "DAACS_QUALITY_COVERAGE_TARGETS",
    "project/pynet,project/calculator,project/room_deco,project/todo",
).split(",")
QUALITY_RADON_EXCLUDE = os.getenv(
    "DAACS_RADON_EXCLUDE",
    "envs,.conda_pkgs,.git,__pycache__",
)

"""
DAACS - Shared Constants
Centralized constants used across multiple modules.
"""
from typing import FrozenSet, Dict

# ==============================================================================
# Directory/File Ignore Patterns
# ==============================================================================
IGNORED_DIRS: FrozenSet[str] = frozenset({
    'node_modules',
    '.git',
    '__pycache__',
    'venv',
    '.venv',
    'env',
    'dist',
    'build',
    '.next',
    '.cache',
    '.pytest_cache',
    '.daacs_cache',
    '.daacs_source',
    '.daacs_backups',
    '.mypy_cache',
    '.ruff_cache',
    'coverage',
    'htmlcov',
    '.tox',
    '.eggs',
    '*.egg-info',
})

IGNORED_FILES: FrozenSet[str] = frozenset({
    '.DS_Store',
    'Thumbs.db',
    '.gitignore',
    '.env',
    '.env.local',
    'package-lock.json',
    'yarn.lock',
    'pnpm-lock.yaml',
    '*.pyc',
    '*.pyo',
    '*.log',
})

KEY_FILES: FrozenSet[str] = frozenset({
    'package.json',
    'requirements.txt',
    'pyproject.toml',
    'setup.py',
    'main.py',
    'app.py',
    'index.ts',
    'index.tsx',
    'index.js',
    'tsconfig.json',
    'vite.config.ts',
    'next.config.js',
})

# ==============================================================================
# Timing Constants (in seconds)
# ==============================================================================
DEFAULT_API_TIMEOUT_SEC: int = 30
PROCESS_SHUTDOWN_TIMEOUT_SEC: int = 5
SERVER_STARTUP_TIMEOUT_SEC: int = 20
SERVER_STARTUP_DELAY_SEC: float = 2.0
BACKEND_STARTUP_DELAY_SEC: float = 5.0
FRONTEND_STARTUP_DELAY_SEC: float = 10.0
NPM_INSTALL_TIMEOUT_SEC: int = 120
HEALTH_CHECK_TIMEOUT_SEC: int = 5
HEALTH_CHECK_INTERVAL_SEC: float = 0.5
LLM_CALL_TIMEOUT_SEC: int = 120
GIT_TIMEOUT_SEC: int = 30
GIT_NETWORK_TIMEOUT_SEC: int = 60

# ==============================================================================
# Limits and Thresholds
# ==============================================================================
MAX_PROJECT_FILES: int = 500
MAX_FILE_SIZE_BYTES: int = 1024 * 1024  # 1MB
MAX_LLM_CALLS_PER_PROJECT: int = 100
MAX_RETRY_ATTEMPTS: int = 3
MIN_CODE_REVIEW_SCORE: float = 70.0
COMPLEXITY_THRESHOLD_WARNING: int = 15
COMPLEXITY_THRESHOLD_CRITICAL: int = 25
LINES_THRESHOLD_WARNING: int = 100
LINES_THRESHOLD_CRITICAL: int = 200

# ==============================================================================
# Port Ranges
# ==============================================================================
BACKEND_PORT_START: int = 8100
BACKEND_PORT_END: int = 8200
FRONTEND_PORT_START: int = 3000
FRONTEND_PORT_END: int = 3100

# ==============================================================================
# Status Values
# ==============================================================================
PROJECT_STATUS_PENDING: str = "pending"
PROJECT_STATUS_RUNNING: str = "running"
PROJECT_STATUS_COMPLETED: str = "completed"
PROJECT_STATUS_FAILED: str = "failed"
PROJECT_STATUS_PAUSED: str = "paused"

# ==============================================================================
# Error Message Constants
# ==============================================================================
ERROR_PREFIX: str = "ERROR:"
ERROR_TIMEOUT: str = "Operation timed out"
ERROR_CONNECTION: str = "Connection failed"
ERROR_PARSE: str = "Failed to parse response"

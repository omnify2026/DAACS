"""
DAACS - LLM Call Rate Limiter
Manages per-project LLM call counts for rate limiting.
Replaces global variables with a class-based approach.
"""
import threading
from typing import Dict, Optional


class LLMRateLimiter:
    """Thread-safe rate limiter for LLM calls per project."""
    
    _instance: Optional['LLMRateLimiter'] = None
    _lock = threading.Lock()
    
    def __new__(cls) -> 'LLMRateLimiter':
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = super().__new__(cls)
                    cls._instance._initialize()
        return cls._instance
    
    def _initialize(self):
        """Initialize instance variables."""
        self._project_counts: Dict[str, int] = {}
        self._global_count: int = 0
        self._max_calls: int = 100
        self._counts_lock = threading.Lock()
    
    @property
    def max_calls(self) -> int:
        return self._max_calls
    
    @max_calls.setter
    def max_calls(self, limit: int):
        self._max_calls = limit
    
    def get_count(self, project_id: Optional[str] = None) -> int:
        """Get current call count for a project or global."""
        with self._counts_lock:
            if project_id:
                return self._project_counts.get(project_id, 0)
            return self._global_count
    
    def increment(self, project_id: Optional[str] = None) -> int:
        """Increment and return new count for rate limiting."""
        with self._counts_lock:
            if project_id:
                current = self._project_counts.get(project_id, 0)
                self._project_counts[project_id] = current + 1
                return self._project_counts[project_id]
            else:
                self._global_count += 1
                return self._global_count
    
    def reset(self, project_id: Optional[str] = None):
        """Reset counts for a project or all."""
        with self._counts_lock:
            if project_id:
                self._project_counts[project_id] = 0
            else:
                self._global_count = 0
                self._project_counts.clear()
    
    def is_limit_reached(self, project_id: Optional[str] = None) -> bool:
        """Check if rate limit is reached."""
        return self.get_count(project_id) >= self._max_calls


# Singleton instance for backward compatibility
_rate_limiter = LLMRateLimiter()


# Backward-compatible functions
def set_max_llm_calls(limit: int):
    _rate_limiter.max_calls = limit


def get_llm_call_count(project_id: str = None) -> int:
    return _rate_limiter.get_count(project_id)


def reset_llm_call_count(project_id: str = None):
    _rate_limiter.reset(project_id)


def _increment_call_count(project_id: str = None) -> int:
    return _rate_limiter.increment(project_id)

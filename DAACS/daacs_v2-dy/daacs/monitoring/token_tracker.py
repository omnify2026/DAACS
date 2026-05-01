"""
Token Tracker Module
Tracks token usage and calculates costs across different LLM providers.
"""
from typing import Dict, Any
import logging
import threading
from datetime import datetime

logger = logging.getLogger("TokenTracker")

# Cost per 1k tokens (USD) - as of 2025/2026 estimates
# Reference prices, should be updated regularly
MODEL_PRICING = {
    # OpenAI
    "gpt-5.2-codex": {"input": 0.03, "output": 0.06},
    "gpt-5.1-codex-max": {"input": 0.01, "output": 0.03},
    "gpt-5.1-codex-mini": {"input": 0.001, "output": 0.002},
    "gpt-4o": {"input": 0.005, "output": 0.015},
    
    # Gemini
    "gemini-3-pro-high": {"input": 0.0025, "output": 0.0075},
    "gemini-3-flash": {"input": 0.0001, "output": 0.0002},
    
    # Claude
    "claude-sonnet-4.5": {"input": 0.003, "output": 0.015},
    "claude-opus-4.5-thinking": {"input": 0.015, "output": 0.075},
}

class TokenTracker:
    _instance = None
    _lock = threading.Lock()
    
    def __init__(self):
        self.usage_log = []
        self.total_usage = {
            "input_tokens": 0,
            "output_tokens": 0,
            "total_tokens": 0,
            "total_cost": 0.0,
        }
        self.session_start = datetime.now()

    @classmethod
    def get_instance(cls):
        with cls._lock:
            if cls._instance is None:
                cls._instance = cls()
        return cls._instance

    def track_request(self, model: str, input_tokens: int, output_tokens: int, provider: str = "unknown"):
        """Track a single LLM request"""
        cost = self._calculate_cost(model, input_tokens, output_tokens)
        
        with self._lock:
            self.total_usage["input_tokens"] += input_tokens
            self.total_usage["output_tokens"] += output_tokens
            self.total_usage["total_tokens"] += (input_tokens + output_tokens)
            self.total_usage["total_cost"] += cost
            
            entry = {
                "timestamp": datetime.now().isoformat(),
                "provider": provider,
                "model": model,
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
                "cost": cost
            }
            self.usage_log.append(entry)
            
            # Log periodically or if expensive
            if cost > 0.05:
                logger.info(f"[TokenTracker] Expensive request: ${cost:.4f} ({model})")

    def _calculate_cost(self, model: str, input_tokens: int, output_tokens: int) -> float:
        # Normalize model name (handle aliases if needed)
        pricing = MODEL_PRICING.get(model)
        if not pricing:
            # Fallback for unknown models (zero cost or warning)
            return 0.0
        
        input_cost = (input_tokens / 1000) * pricing["input"]
        output_cost = (output_tokens / 1000) * pricing["output"]
        return input_cost + output_cost

    def get_summary(self) -> Dict[str, Any]:
        """Return usage summary"""
        with self._lock:
            return {
                "session_start": self.session_start.isoformat(),
                "total_usage": self.total_usage.copy(),
                "request_count": len(self.usage_log),
                "model_breakdown": self._get_model_breakdown()
            }
            
    def _get_model_breakdown(self) -> Dict[str, Any]:
        breakdown = {}
        for entry in self.usage_log:
            model = entry["model"]
            if model not in breakdown:
                breakdown[model] = {"tokens": 0, "cost": 0.0, "requests": 0}
            
            breakdown[model]["tokens"] += (entry["input_tokens"] + entry["output_tokens"])
            breakdown[model]["cost"] += entry["cost"]
            breakdown[model]["requests"] += 1
        return breakdown

    def reset_stats(self):
        with self._lock:
            self.usage_log = []
            self.total_usage = {
                "input_tokens": 0,
                "output_tokens": 0,
                "total_tokens": 0,
                "total_cost": 0.0,
            }
            self.session_start = datetime.now()

# Singleton instance for module-level import backward compatibility
token_tracker = TokenTracker.get_instance()

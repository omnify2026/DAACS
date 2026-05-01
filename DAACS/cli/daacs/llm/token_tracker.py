"""
DAACS Token Tracker
모든 LLM 호출의 토큰 사용량과 비용을 추적합니다.
"""

import time
from typing import Dict, List, Optional
from dataclasses import dataclass, field
import logging

logger = logging.getLogger("TokenTracker")


@dataclass
class TokenUsage:
    """단일 LLM 호출의 토큰 사용량"""
    agent_name: str
    input_tokens: int
    output_tokens: int
    timestamp: float = field(default_factory=time.time)
    model: str = "unknown"
    
    @property
    def total_tokens(self) -> int:
        return self.input_tokens + self.output_tokens
    
    @property
    def estimated_cost_usd(self) -> float:
        """
        대략적인 비용 추정 (USD)
        Gemini Pro 기준: 입력 $0.00025/1K, 출력 $0.0005/1K
        """
        input_cost = (self.input_tokens / 1000) * 0.00025
        output_cost = (self.output_tokens / 1000) * 0.0005
        return input_cost + output_cost


class TokenTracker:
    """
    싱글톤 패턴으로 전체 세션의 토큰 사용량을 추적합니다.
    """
    _instance: Optional["TokenTracker"] = None
    
    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance._initialized = False
        return cls._instance
    
    def __init__(self):
        if self._initialized:
            return
        self._initialized = True
        self.usages: List[TokenUsage] = []
        self.session_start = time.time()
        logger.info("[TokenTracker] Initialized")
    
    def log_usage(
        self,
        agent_name: str,
        input_tokens: int,
        output_tokens: int,
        model: str = "unknown"
    ) -> TokenUsage:
        """토큰 사용량을 기록합니다."""
        usage = TokenUsage(
            agent_name=agent_name,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            model=model
        )
        self.usages.append(usage)
        logger.info(
            f"[TokenTracker] {agent_name}: "
            f"in={input_tokens}, out={output_tokens}, "
            f"cost=${usage.estimated_cost_usd:.4f}"
        )
        return usage
    
    def log_usage_from_chars(
        self,
        agent_name: str,
        input_chars: int,
        output_chars: int,
        model: str = "unknown"
    ) -> TokenUsage:
        """문자 수로부터 토큰 사용량을 추정합니다. (1 token ≈ 4 chars)"""
        return self.log_usage(
            agent_name=agent_name,
            input_tokens=input_chars // 4,
            output_tokens=output_chars // 4,
            model=model
        )
    
    def get_summary(self) -> Dict:
        """전체 세션의 토큰 사용량 요약을 반환합니다."""
        total_input = sum(u.input_tokens for u in self.usages)
        total_output = sum(u.output_tokens for u in self.usages)
        total_cost = sum(u.estimated_cost_usd for u in self.usages)
        
        # 에이전트별 집계
        by_agent: Dict[str, Dict] = {}
        # 모델별 집계 (New)
        by_model: Dict[str, Dict] = {}

        for u in self.usages:
            # Agent Aggregation
            if u.agent_name not in by_agent:
                by_agent[u.agent_name] = {
                    "input_tokens": 0,
                    "output_tokens": 0,
                    "calls": 0,
                    "cost_usd": 0.0
                }
            by_agent[u.agent_name]["input_tokens"] += u.input_tokens
            by_agent[u.agent_name]["output_tokens"] += u.output_tokens
            by_agent[u.agent_name]["calls"] += 1
            by_agent[u.agent_name]["cost_usd"] += u.estimated_cost_usd

            # Model Aggregation (New)
            model_key = u.model if u.model else "unknown"
            if model_key not in by_model:
                by_model[model_key] = {
                    "input_tokens": 0,
                    "output_tokens": 0,
                    "calls": 0,
                    "cost_usd": 0.0
                }
            by_model[model_key]["input_tokens"] += u.input_tokens
            by_model[model_key]["output_tokens"] += u.output_tokens
            by_model[model_key]["calls"] += 1
            by_model[model_key]["cost_usd"] += u.estimated_cost_usd
        
        return {
            "total_input_tokens": total_input,
            "total_output_tokens": total_output,
            "total_tokens": total_input + total_output,
            "total_cost_usd": total_cost,
            "total_calls": len(self.usages),
            "session_duration_seconds": time.time() - self.session_start,
            "by_agent": by_agent,
            "by_model": by_model
        }
    
    def print_receipt(self):
        """콘솔에 영수증 형태로 출력합니다."""
        summary = self.get_summary()
        
        print("\n" + "=" * 60)
        print("  💰 DAACS Token Usage Receipt")
        print("=" * 60)
        print(f"  Total Calls: {summary['total_calls']}")
        print(f"  Total Tokens: {summary['total_tokens']:,}")
        print(f"    - Input: {summary['total_input_tokens']:,}")
        print(f"    - Output: {summary['total_output_tokens']:,}")
        print(f"  Estimated Cost: ${summary['total_cost_usd']:.4f} USD")
        print(f"  Session Duration: {summary['session_duration_seconds']:.1f}s")
        
        print("-" * 60)
        print("  By Model (CLI):")
        for model, data in summary["by_model"].items():
            print(f"    [{model}]: {data['calls']} calls, "
                  f"{data['input_tokens'] + data['output_tokens']:,} tokens "
                  f"(${data['cost_usd']:.4f})")

        print("-" * 60)
        print("  By Agent:")
        for agent, data in summary["by_agent"].items():
            print(f"    {agent}: {data['calls']} calls, "
                  f"{data['input_tokens'] + data['output_tokens']:,} tokens, "
                  f"${data['cost_usd']:.4f}")
        print("=" * 60 + "\n")
    
    def reset(self):
        """추적 데이터를 초기화합니다."""
        self.usages = []
        self.session_start = time.time()
        logger.info("[TokenTracker] Reset")


# Convenience function
def get_tracker() -> TokenTracker:
    """TokenTracker 싱글톤 인스턴스를 반환합니다."""
    return TokenTracker()


from typing import Dict, Any, List

class Verifier:
    def __init__(self, agent):
        self.agent = agent

    def verify_action(self, action: Dict[str, Any], result: str) -> Dict[str, Any]:
        """Verify the action execution result using the agent."""
        return self.agent.review_result(action, result)

    def classify_failure(self, result: str, failed_verdicts: List[Dict]) -> str:
        """Classify the type of failure based on result and verdicts."""
        if "rollout recorder" in result or "Operation not permitted" in result:
             return "permission"
        
        reasons = [v.get("reason", "") for v in failed_verdicts]
        if any("tests" in r for r in reasons):
             return "tests_fail"
        if any("build" in r for r in reasons):
             return "build_fail"
        if any("lint" in r for r in reasons):
             return "lint_fail"
        return "verify_fail"

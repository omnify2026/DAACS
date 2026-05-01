
import logging
import time
from typing import Dict, Any, List, Optional

logger = logging.getLogger(__name__)

class Executor:
    """
    Handles Action Execution, Success/Failure Logic, and Replanning.
    """
    def __init__(self, agent: Any, clients: Dict[str, Any], event_emitter: Any, verifier: Any) -> None:
        self.agent = agent
        self.clients = clients
        self._emit_event = event_emitter
        self.verifier = verifier

    def execute_action(self, action: Dict[str, Any]) -> str:
        """Execute a single action and return result."""
        instruction = action.get("instruction") or action.get("cmd") or ""
        client_name = str(action.get("client") or "frontend").lower().strip()
        client = self.clients.get(client_name, self.clients.get("frontend"))
        
        logger.info(f"Executing action: {instruction}")
        self._emit_event("ACTION_START", {"action": action, "client": client_name})
        
        # Guard against missing execute method (mock clients might behave differently logic is safe)
        if not hasattr(client, 'execute'):
             logger.error(f"Client {client_name} does not have execute method.")
             return "Error: Client configuration issue"

        result = client.execute(instruction)
        logger.info(f"Codex Result: {result}")
        return result

    def handle_success(self, action: Dict[str, Any], plan: Dict[str, Any], 
                      enable_quality_gates: bool, quality_inserted: bool) -> tuple[bool, bool, Dict]:
        """
        Handle action success. 
        Returns (is_complete, quality_inserted, updated_plan)
        """
        logger.info("Action successful.")
        is_complete = self.agent.state.get("current_index", 0) >= self.agent.state.get("total_actions", 0)
        
        # Quality gates logic
        if (enable_quality_gates 
            and not quality_inserted 
            and action.get("type") in {"codegen", "refactor"}):
            quality_actions = self.agent.quality_gate_actions()
            if quality_actions:
                insert_at = plan.get("current_index", 0)
                # Helper to insert into plan
                plan["actions"] = plan["actions"][:insert_at] + quality_actions + plan["actions"][insert_at:]
                # Don't advance index, so we execute the new quality actions next? 
                # Original code: plan["current_index"] = insert_at. 
                # Since outer loop increments, we might need to be careful.
                # Actually original code:
                # plan["actions"] = ...
                # plan["current_index"] = insert_at
                # self.agent.state["current_index"] = insert_at
                # is_complete check...
                
                plan["current_index"] = insert_at
                self.agent.state["current_index"] = insert_at
                self.agent.state["total_actions"] = len(plan["actions"])
                quality_inserted = True
                logger.info("Quality gate actions inserted after codegen/refactor success.")
                is_complete = plan.get("current_index", 0) >= len(plan.get("actions", []))
        
        return is_complete, quality_inserted, plan

    def handle_failure(self, action, result, review, plan, current_goal, turn, consecutive_failures) -> Dict[str, Any]:
        """
        Handle action failure. 
        Returns next action instruction dict: {"action": "stop"|"replan"|"continue"|"retry", ...}
        """
        logger.warning("Action failed.")
        
        failed_verdicts = [v for v in review.get("verify", {}).get("verdicts", []) if not v.get("ok")]
        if self.verifier:
             # Just logging or unused in logic currently, but good for tracing
             _ = self.verifier.classify_failure(result, failed_verdicts)
        
        if "rollout recorder" in result or "Operation not permitted" in result:
            logger.error("Codex failed due to rollout recorder permission. Run with full access (danger-full-access).")
        
        # Replanning request to agent
        next_plan = self.agent.plan_next(current_goal)
        
        if next_plan and next_plan.get("stop"):
            return {"action": "stop", "reason": next_plan.get("reason", "")}
        
        if next_plan and next_plan.get("next_goal") and not next_plan.get("next_actions"):
            return {"action": "replan", "new_goal": next_plan["next_goal"]}
        
        if next_plan and next_plan.get("next_actions"):
            # Append/Replace plan actions
            remaining = plan["actions"][plan.get("current_index", 0):]
            plan["actions"] = next_plan["next_actions"] + remaining
            plan["current_index"] = 0
            self.agent.state["current_index"] = 0
            new_goal = next_plan.get("next_goal", current_goal)
            logger.info(f"Planner suggested new actions; updating plan. current_goal={new_goal}")
            return {"action": "continue", "new_goal": new_goal}
        
        if review.get("needs_retry"):
            logger.info("Will retry this action with backoff...")
            # Retry previous index
            target_idx = max(plan.get("current_index", 1) - 1, 0)
            plan["current_index"] = target_idx
            self.agent.state["current_index"] = target_idx
            time.sleep(min(2 ** (turn - 1), 5))
            return {"action": "retry"}
        
        return {"action": "continue"}

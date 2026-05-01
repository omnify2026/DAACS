from typing import Any, Dict

from ..base import BaseAgent
from ..protocol import AgentMessage, MessageType, AgentStatus
from ...quality_scorer import QualityScorer
from ...patcher import CodePatcher
from ...graph.config_loader import DAACSConfig


class ReviewerAgent(BaseAgent):
    """
    Reviewer Agent: Reviews code quality.
    """
    def __init__(self, agent_id: str):
        super().__init__(agent_id, role="reviewer")
        self.scorer = QualityScorer()
        
        # Load constraints from Configuration
        self.config = DAACSConfig.get_instance()
        self.constraints = self.config.get_constraints()
        
        # Ensure allowed_extensions is a set for faster lookup
        if "allowed_extensions" in self.constraints:
            self.constraints["allowed_extensions"] = set(self.constraints["allowed_extensions"])


    async def process_message(self, message: AgentMessage):
        if message.type == MessageType.REQUEST:
            self.update_status(AgentStatus.BUSY)
            await self._review_code(message.sender, message.content)
            self.update_status(AgentStatus.IDLE)

    def review_file(self, file_name: str, code: str) -> Dict[str, Any]:
        """
        Synchronous review logic for use by Workflow Wrappers.
        Returns a dictionary with status, score, feedback, and patched_code.
        """
        result = {
            "file": file_name,
            "status": "pending",
            "score": 0.0,
            "feedback": "",
            "patched_code": None,
            "reason": ""
        }

        # 0. Pre-Flight: Syntax Check & Auto-Fix (Machine Layer)
        code, patched_syntax, syntax_errors = CodePatcher.check_and_fix_syntax(code, file_name)
        
        if patched_syntax:
            self.logger.info(f"Auto-Fixed Syntax Error in {file_name}")
            result["feedback"] += "(Auto-fixed Syntax Error) "
            result["patched_code"] = code
            
        if syntax_errors:
            self.logger.warning(f"Syntax Error in {file_name}: {syntax_errors}")
            result["status"] = "rejected"
            result["score"] = 0.0
            result["feedback"] = f"Syntax Error (Parse Failed): {syntax_errors[0]}. Please fix syntax."
            result["reason"] = "Syntax Error"
            return result

        # Use QualityScorer
        score_result = self.scorer.score_code_content(code)
        score = score_result.get("score", 0)
        feedback = score_result.get("feedback", "No feedback")
        if result["feedback"]: # append if existing
             feedback = f"{result['feedback']} {feedback}"
        
        # 1. Extension Check (Security Guard)
        allowed_exts = self.constraints.get("allowed_extensions")
        if not self.scorer.check_file_extension(file_name, allowed_extensions=allowed_exts):
            self.logger.warning(f"Security Alert: Unauthorized file type '{file_name}'")
            result["status"] = "rejected"
            result["score"] = 0.0
            result["feedback"] = f"Security Violation: File type '{file_name}' not allowed."
            result["reason"] = "Security Violation"
            return result
            
        # 2. Constraint Check
        violations = self.scorer.check_constraints(code, self.constraints)
        
        # 3. Auto-Fix Attempt
        if violations:
            self.logger.info(f"Attempting to auto-patch violations: {violations}")
            patched_code, was_patched = CodePatcher.patch(code, self.constraints)
            
            if was_patched:
                # Re-score patched code
                code = patched_code
                violations = self.scorer.check_constraints(code, self.constraints) 
                if not violations:
                    self.logger.info("Auto-patch successful! Violations resolved.")
                    feedback += ". (Auto-fixed by Reviewer)"
                    score = max(score, 8.0) 
                    result["patched_code"] = code # Update patched code
            
        if violations:
            score = min(score, 5.0)
            feedback += f". VIOLATIONS: {'; '.join(violations)}"
            self.logger.warning(f"Constraint Violations (Unfixed): {violations}")

        self.logger.info(f"Code Score: {score}/10")
        
        result["score"] = score
        result["feedback"] = feedback
        
        if score >= 8.0:
            result["status"] = "verified"
        else:
            result["status"] = "rejected"
            result["reason"] = "Score below threshold (8.0)"
            
        return result

    async def _review_code(self, sender: str, content: Any):
        file_name = content.get("file")
        code = content.get("code")
        self.logger.info(f"Reviewing code for {file_name} from {sender}")
        
        review_result = self.review_file(file_name, code)
        
        # Map result to AgentMessage
        if review_result["status"] == "verified":
             await self.send_message(
                receiver="planner-01",
                content=review_result,
                msg_type=MessageType.DONE
            )
        else:
             await self.send_message(
                receiver="planner-01",
                content=review_result,
                msg_type=MessageType.REJECT
            )


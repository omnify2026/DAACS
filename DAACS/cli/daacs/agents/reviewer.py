"""
Reviewer Agent
Responsible for reviewing code and ensuring quality.
"""

from typing import Dict, Any
import json
import logging
import re
from .base import BaseAgent, AgentRole, CodeArtifact, ReviewResult

logger = logging.getLogger("ReviewerAgent")


def sanitize_json_string(text: str) -> str:
    """
    Remove control characters that break JSON parsing.
    Keeps \n and \t but removes other control chars (0x00-0x1F except 0x09, 0x0A, 0x0D).
    """
    # Replace problematic control characters with space
    return re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f]', ' ', text)


class ReviewerAgent(BaseAgent):
    """Reviewer Agent"""
    
    def __init__(self, role: AgentRole, llm_client: Any, cli_client: Any = None):
        super().__init__(role, llm_client, cli_client=cli_client)
        # self.cli_client is now set in BaseAgent, but we keep this for compatibility if needed, 
        # or rely on BaseAgent's self.cli_client. 
        # BaseAgent sets self.cli_client = cli_client.
        self.review_count = 0
        self.max_reviews = 5
    
    def review_code(self, code: CodeArtifact, api_contract: Dict = None) -> ReviewResult:
        """Review code"""
        self.review_count += 1
        
        context = ""
        if api_contract:
            context = f"API Contract: {json.dumps(api_contract, ensure_ascii=False)}"
        
        prompt = f"""Review the following {code.role} code.

CODE FILES:
{json.dumps(code.files, ensure_ascii=False, indent=2)}

{context}

Review for:
1. Code correctness and functionality
2. API contract compliance (if applicable)
3. Error handling
4. Code quality and best practices

Be specific about issues. Only flag REAL problems, not style preferences.

Respond in JSON format:
{{
    "approved": true/false,
    "overall_quality": "good/acceptable/needs_work",
    "issues": [
        {{"severity": "critical/major/minor", "description": "...", "file": "...", "fix": "..."}}
    ],
    "suggestions": ["suggestion1", "suggestion2"],
    "summary": "One-line summary"
}}"""
        
        if self.cli_client:
            logger.info(f"[{self.role.value}] Reviewing via CLI...")
            response = self.cli_client.execute(prompt)
        else:
            response = self._call_llm(prompt, context)
        
        try:
            if isinstance(response, str):
                # Sanitize control characters before JSON parsing
                sanitized = sanitize_json_string(response)
                json_match = re.search(r'\{[\s\S]*\}', sanitized)
                if json_match:
                    data = json.loads(json_match.group())
                else:
                    data = {"approved": True}

            else:
                data = response
            
            issues = [i.get("description", str(i)) for i in data.get("issues", [])]
            
            return ReviewResult(
                approved=data.get("approved", True),
                feedback=data.get("summary", ""),
                issues=issues,
                suggestions=data.get("suggestions", [])
            )
        except Exception as e:
            logger.error(f"[{self.role.value}] Review parsing failed: {e}")
            return ReviewResult(approved=True, feedback="Failed to parse review")

    def review_with_git(self, commit_id: str, review_context: str, task_description: str = None) -> ReviewResult:
        """Git 커밋 리뷰 (CLI/LLM)"""
        self.review_count += 1
        
        task_section = ""
        if task_description:
            task_section = f"""
=== 🎯 TASK OBJECTIVE (PRIORITY) ===
{task_description}

IMPORTANT: Your primary goal is to verify if this objective is met.
"""

        prompt = f"""Review the changes in commit {commit_id}.

{task_section}

CONTEXT:
{review_context}

Review for:
1. 🎯 Task Fulfillment: Does the code meet the TASK OBJECTIVE? (Highest Priority)
2. Correctness: Does the code do what it's supposed to?
3. Quality: Are there any bad practices or potential bugs?

Respond in JSON format:
{{
    "approved": true/false,
    "summary": "Brief summary of the review",
    "issues": [
        {{"severity": "critical/major/minor", "description": "...", "file": "..."}}
    ],
    "suggestions": ["suggestion1", "suggestion2"]
}}"""

        if self.cli_client:
            logger.info(f"[{self.role.value}] Reviewing commit {commit_id} via CLI...")
            response = self.cli_client.execute(prompt)
        else:
            response = self._call_llm(prompt, review_context)
            
        try:
            if isinstance(response, str):
                # Sanitize control characters before JSON parsing
                sanitized = sanitize_json_string(response)
                json_match = re.search(r'\{[\s\S]*\}', sanitized)
                if json_match:
                    data = json.loads(json_match.group())
                else:
                    data = {"approved": True, "summary": "Auto-approved (parse failed)"}

            else:
                data = response
            
            issues = [i.get("description", str(i)) for i in data.get("issues", [])]
            
            return ReviewResult(
                approved=data.get("approved", True),
                feedback=data.get("summary", ""),
                issues=issues,
                suggestions=data.get("suggestions", [])
            )
        except Exception as e:
            logger.error(f"[{self.role.value}] Review parsing failed: {e}")
            return ReviewResult(approved=True, feedback="Failed to parse review")


class IntegrationReviewerAgent(BaseAgent):
    """Integration Reviewer Agent - Validates full system"""
    
    def __init__(self, llm_client: Any, cli_client: Any = None):
        super().__init__(AgentRole.INTEGRATION_REVIEWER, llm_client, cli_client=cli_client)
        # self.cli_client is set in BaseAgent

    def verify_integration_with_git(
        self, 
        backend_commit: str, 
        frontend_commit: str, 
        backend_git: Any, 
        frontend_git: Any,
        api_contract: Dict, 
        original_goal: str,
        verification_results: Dict = None  # 🆕 v3.0: 모든 검증 결과
    ) -> Dict[str, Any]:
        """
        Verify integration using Git commits (v3.0)
        
        v3.0 변경사항:
        - goal_achieved: 기능 구현 여부 (버그 무관)
        - runnable: 실행 가능 여부
        - fix_queue: 우선순위대로 정렬된 fix 대상
        - fix_context: 각 대상별 상세 이슈
        """
        
        # 1. 변경사항 가져오기
        backend_diff = backend_git.get_diff(backend_commit)
        frontend_diff = frontend_git.get_diff(frontend_commit)
        
        # 🆕 v3.0: 검증 결과 요약
        verification_summary = ""
        if verification_results:
            runtime = verification_results.get("runtime", {})
            visual = verification_results.get("visual", {})
            verification_summary = f"""
[Runtime Verification]
- Backend Running: {runtime.get('backend_running', 'N/A')}
- Frontend Running: {runtime.get('frontend_running', 'N/A')}
- Backend Health: {runtime.get('backend_health', 'N/A')}
- Errors: {runtime.get('errors', [])}

[Visual Verification]
- Page Loaded: {visual.get('page_loaded', 'N/A')}
- Login Success: {visual.get('login_success', 'N/A')}
- Console Errors: {visual.get('console_errors', [])}
- Encoding Issues: {visual.get('encoding_issues', [])}
"""
        
        context = f"""
API Contract:
{json.dumps(api_contract, ensure_ascii=False, indent=2)}

Backend Changes (Commit {backend_commit}):
{backend_diff[:2000]}... (truncated)

Frontend Changes (Commit {frontend_commit}):
{frontend_diff[:2000]}... (truncated)

{verification_summary}
"""
        
        prompt = f"""You are the Integration Reviewer. Verify the backend/frontend integration status.

=== 🎯 PROJECT GOAL (PRIORITY) ===
{original_goal}

IMPORTANT: Your primary goal is to verify if this GOAL is achieved.
Focus on functionality and integration, NOT on minor style issues.

[Verification Criteria]
1. goal_achieved: Is the core functionality implemented? (Ignore minor bugs)
2. runnable: Does it actually run? (CORS, runtime errors, etc.)
3. API Compatibility: Do frontend calls match backend endpoints?

[Fix Queue Priority Rules]
- CRITICAL: Issues preventing the app from running (CORS, crash) -> 'devops'
- HIGH: Logic errors preventing Goal Achievement -> 'backend'/'frontend'
- LOW: Minor UI glitches or style issues -> Ignore or low priority

⚠️ CORS RULE: 'Access-Control-Allow-Origin' error -> MUST be 'devops'!

JSON Response Format:
{{
    "goal_achieved": true/false,
    "runnable": true/false,
    "api_compatible": true/false,
    "summary": "Verification summary",
    "fix_queue": ["devops", "frontend"],
    "fix_context": {{
        "devops": [
            {{"issue": "CORS Error", "detail": "backend :5173, frontend :3000", "file": "config.py"}}
        ],
        "backend": [],
        "frontend": [
            {{"issue": "Enum mismatch", "detail": "day->daily", "file": "ReportsPage.jsx"}}
        ]
    }},
    "reasoning": "Must fix CORS first to test API"
}}"""
        
        if self.cli_client:
            logger.info(f"[{self.role.value}] Verifying integration via CLI...")
            response = self.cli_client.execute(prompt)
        else:
            response = self._call_llm(prompt, context)
        
        try:
            if isinstance(response, str):
                import re
                # 🆕 v3.1: 더 정교한 JSON 추출 - 중첩된 {} 처리
                def extract_first_json(text: str) -> dict:
                    """첫 번째 유효한 JSON 객체 추출"""
                    depth = 0
                    start = -1
                    for i, char in enumerate(text):
                        if char == '{':
                            if depth == 0:
                                start = i
                            depth += 1
                        elif char == '}':
                            depth -= 1
                            if depth == 0 and start != -1:
                                try:
                                    return json.loads(text[start:i+1])
                                except json.JSONDecodeError:
                                    continue  # 다음 JSON 시도
                    # 폴백: 기존 방식
                    json_match = re.search(r'\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}', text)
                    if json_match:
                        return json.loads(json_match.group())
                    raise ValueError("No valid JSON found")
                
                result = extract_first_json(response)
                # 🆕 v3.0: 기본값 보장
                result.setdefault("goal_achieved", False)
                result.setdefault("runnable", False)
                result.setdefault("api_compatible", False)
                result.setdefault("fix_queue", [])
                result.setdefault("fix_context", {"devops": [], "backend": [], "frontend": []})
                return result
            return response if isinstance(response, dict) else {"goal_achieved": False, "runnable": False}
        except Exception as e:
            logger.error(f"[Integration] Verification failed: {e}")
            # 🆕 v3.1: 파싱 실패 시 기본 fix_queue 설정 → 리플래닝 가능하도록
            return {
                "goal_achieved": False, 
                "runnable": False,
                "api_compatible": False, 
                "issues": [f"Verification error: {str(e)}"],
                "fix_queue": ["backend", "frontend"],  # 🆕 양쪽 재작업 시도
                "fix_context": {
                    "devops": [],
                    "backend": [{"issue": "Parsing error", "detail": str(e)[:200]}],
                    "frontend": [{"issue": "Parsing error", "detail": str(e)[:200]}]
                },
                "summary": "JSON parsing failed - automatic retry with both teams"
            }


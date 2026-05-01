"""
Architect Agent
Responsible for analyzing goals, creating task plans, and defining API contracts.
"""

from typing import Dict, List, Any
import json
import logging
from .base import BaseAgent, AgentRole, Task, TaskPlan

logger = logging.getLogger("ArchitectAgent")

class ArchitectAgent(BaseAgent):
    """Architect Agent - Task Decomposition & API Contract"""
    
    def __init__(self, llm_client: Any):
        super().__init__(AgentRole.ARCHITECT, llm_client)
    
    def analyze_goal(self, goal: str, tech_context: Dict = None, user_requirements: List[str] = None, replan_context: Dict = None) -> Dict:
        """Analyze goal with user requirements and replanning context"""
        context = ""
        if tech_context:
            context = f"""
Technical Context:
- Facts: {tech_context.get('facts', [])}
- Constraints: {tech_context.get('constraints', [])}
- Recommended Stack: {tech_context.get('recommended_stack', {})}
"""
        
        replan_section = ""
        if replan_context:
            replan_section = f"""
            
=== 🔄 REPLANNING CONTEXT (CRITICAL) ===
This is a REPLANNING attempt. The previous attempt failed or was rejected.
Reason: {replan_context.get('reason', 'Unknown')}
Feedback: {replan_context.get('feedback', 'None')}
Assumptions to Change: {replan_context.get('assumptions', 'None')}

YOU MUST ADJUST THE PLAN TO ADDRESS THESE ISSUES.
"""

        user_req_section = ""
        if user_requirements:
            user_req_section = f"""

=== 🚨 USER EXPLICIT REQUIREMENTS (MUST FOLLOW) ===
The user has explicitly stated the following requirements. You MUST incorporate these exactly as stated:
{chr(10).join([f"- {req}" for req in user_requirements])}

IMPORTANT: These are non-negotiable. Do not modify or ignore these requirements.
"""
        else:
            user_req_section = """

=== USER REQUIREMENTS ===
The user has not specified any explicit requirements.
You have FULL AUTONOMY to make the best decisions for this project.
"""
        
        prompt = f"""Analyze the following user goal and extract key requirements:

USER GOAL: {goal}
{replan_section}
{user_req_section}
Think step by step:
1. What does the user REALLY want?
2. What are the core features needed?
3. For areas the user did NOT specify, what would be the BEST choices?
4. What would make the user say "perfect!"?

Respond in JSON format:
{{
    "goal_summary": "One-line summary of the goal",
    "core_features": ["feature1", "feature2", ...],
    "constraints": ["constraint1", "constraint2", ...],
    "user_specified": ["things user explicitly asked for"],
    "llm_decided": ["things you decided autonomously"],
    "success_criteria": ["criterion1", "criterion2", ...],
    "ui_language": "korean|english"
}}"""
        
        response = self._call_llm(prompt, context)
        
        try:
            if isinstance(response, str):
                import re
                json_match = re.search(r'\{[\s\S]*\}', response)
                if json_match:
                    return json.loads(json_match.group())
            return response if isinstance(response, dict) else {"goal_summary": goal}
        except:
            return {"goal_summary": goal, "core_features": [], "constraints": []}
    
    # 🆕 v3.0: Valid assignees for task plan (Strictly Implementation Teams Only)
    VALID_ASSIGNEES = ["designer", "backend_developer", "frontend_developer", "devops"]
    
    def create_task_plan(self, goal_analysis: Dict, goal: str) -> TaskPlan:
        """Create task plan with v3.0 dynamic execution support"""
        prompt = f"""Based on the goal analysis, create a detailed task plan for the development team.

GOAL: {goal}
ANALYSIS: {json.dumps(goal_analysis, ensure_ascii=False, indent=2)}

Create tasks with:
- Clear IDs (D1 for design, T1/T2/T3 for implementation)
- Dependencies between tasks (depends_on)
- Priority ordering (lower = earlier)

=== YOUR ROLE ===
You are the ARCHITECT - an Orchestrator who PLANS but NEVER EXECUTES.
Your job is to assign tasks to implementation teams, NOT to yourself.

=== VALID ASSIGNEES (use ONLY these 4) ===
- "designer": UI wireframe, mockup, design system, color palette
- "backend_developer": FastAPI endpoints, database, business logic
- "frontend_developer": React/Next.js UI components, project setup, API integration
- "devops": CORS, proxy, ports, environment setup, CI/CD, deployment

=== FORBIDDEN ASSIGNEES ===
❌ "architect" - YOU are the architect, you PLAN but don't EXECUTE
❌ "integration_reviewer" - System handles this automatically

=== TASK ASSIGNMENT RULES ===
1. "Project Init/Setup" → frontend_developer (or devops for infra-heavy projects)
2. "UI/UX Design" → designer
3. "API Implementation" → backend_developer
4. "Frontend Components" → frontend_developer
5. "Deployment/CI-CD" → devops

Respond in JSON format:
{{
    "tasks": [
        {{
            "id": "D1",
            "name": "UI/UX Design",
            "description": "Create wireframe, mockup, design system",
            "assigned_to": "designer",
            "priority": 1,
            "depends_on": []
        }},
        {{
            "id": "T1",
            "name": "Backend API Implementation",
            "description": "Implement FastAPI endpoints per API contract",
            "assigned_to": "backend_developer",
            "priority": 1,
            "depends_on": []
        }},
        {{
            "id": "T2",
            "name": "Frontend Implementation",
            "description": "Build React UI components based on design",
            "assigned_to": "frontend_developer",
            "priority": 2,
            "depends_on": ["D1", "T1"]
        }},
        {{
            "id": "T3",
            "name": "Deployment Setup",
            "description": "Configure CI/CD and deployment",
            "assigned_to": "devops",
            "priority": 3,
            "depends_on": ["T1", "T2"]
        }}
    ],
    "summary": "Overall plan summary"
}}"""
        
        response = self._call_llm(prompt)
        
        try:
            if isinstance(response, str):
                import re
                json_match = re.search(r'\{[\s\S]*\}', response)
                if json_match:
                    data = json.loads(json_match.group())
                else:
                    data = {"tasks": [], "summary": "Failed to parse"}
            else:
                data = response
            
            tasks = []
            role_mapping = {
                "architect": AgentRole.ARCHITECT,
                "designer": AgentRole.DESIGNER,  # 🆕 v3.0: Designer role
                "backend_developer": AgentRole.BACKEND_DEV,
                "frontend_developer": AgentRole.FRONTEND_DEV,
                "backend_reviewer": AgentRole.BACKEND_REVIEWER,
                "frontend_reviewer": AgentRole.FRONTEND_REVIEWER,
                "devops": AgentRole.DEVOPS,  # 🆕 v3.0: DevOps role
                "integration_reviewer": AgentRole.INTEGRATION_REVIEWER
            }
            
            # 🆕 Auto-correction for invalid assignees
            def auto_correct_assignee(task_dict: Dict) -> str:
                """Architect는 Executor가 아니므로 다른 역할로 자동 교정"""
                assignee = task_dict.get("assigned_to", "")
                name = task_dict.get("name", "").lower()
                
                # architect가 아니면 그대로 반환
                if assignee not in ["architect", "integration_reviewer"]:
                    return assignee
                
                # 태스크 이름 기반으로 적절한 역할 추론
                if any(kw in name for kw in ["design", "ui/ux", "wireframe", "mockup", "color", "typography"]):
                    logger.info(f"[Architect] Auto-correcting '{name}': architect → designer")
                    return "designer"
                elif any(kw in name for kw in ["deploy", "ci/cd", "release", "build", "environment"]):
                    logger.info(f"[Architect] Auto-correcting '{name}': architect → devops")
                    return "devops"
                elif any(kw in name for kw in ["api", "backend", "database", "server"]):
                    logger.info(f"[Architect] Auto-correcting '{name}': architect → backend_developer")
                    return "backend_developer"
                else:
                    # 기본: frontend_developer
                    logger.info(f"[Architect] Auto-correcting '{name}': architect → frontend_developer")
                    return "frontend_developer"
            
            for t in data.get("tasks", []):
                # 자동 교정 적용
                corrected_assignee = auto_correct_assignee(t)
                t["assigned_to"] = corrected_assignee
                
                role_str = t.get("assigned_to", "frontend_developer")
                role = role_mapping.get(role_str, AgentRole.FRONTEND_DEV)
                
                tasks.append(Task(
                    id=t.get("id", "T?"),
                    name=t.get("name", "Unknown"),
                    description=t.get("description", ""),
                    assigned_to=role,
                    priority=t.get("priority", 99),
                    depends_on=t.get("depends_on", []),
                    estimated_effort=t.get("estimated_effort", "medium")
                ))
            
            return TaskPlan(tasks=tasks, summary=data.get("summary", ""))
            
        except Exception as e:
            logger.error(f"[Architect] Failed to create task plan: {e}")
            return TaskPlan(
                tasks=[
                    Task("T1", "API Contract", "Define API", AgentRole.ARCHITECT, 1),
                    Task("T2", "Backend", "Implement API", AgentRole.BACKEND_DEV, 2, ["T1"]),
                    Task("T3", "Frontend", "Build UI", AgentRole.FRONTEND_DEV, 2, ["T1"]),
                    Task("T4", "Integration", "Test together", AgentRole.INTEGRATION_REVIEWER, 3, ["T2", "T3"])
                ],
                summary=f"Build application for: {goal}"
            )
    
    def create_api_contract(self, task_plan: TaskPlan, goal_analysis: Dict) -> Dict:
        """Create API Contract"""
        prompt = f"""Create a detailed API contract for the development team.

GOAL ANALYSIS: {json.dumps(goal_analysis, ensure_ascii=False)}
FEATURES TO IMPLEMENT: {goal_analysis.get('core_features', [])}

Create an API specification that:
1. Covers ALL required features
2. Has consistent endpoint naming
3. Defines request/response formats clearly
4. Includes error cases
5. Enforce WRAPPED responses for all endpoints (e.g. {{"user": {{...}}}} instead of just {{...}}) to ensure extensibility and frontend compatibility.

Respond in JSON format:
{{
    "base_url": "http://localhost:8080",
    "endpoints": [
        {{
            "method": "GET",
            "path": "/api/items",
            "description": "Get all items",
            "request_body": null,
            "response_body": {{"items": "[...]"}},
            "error_cases": ["500 if server error"]
        }}
    ],
    "data_models": {{
        "Item": {{"id": "int", "title": "string", "completed": "boolean"}}
    }}
}}"""
        
        response = self._call_llm(prompt)
        
        try:
            if isinstance(response, str):
                import re
                json_match = re.search(r'\{[\s\S]*\}', response)
                if json_match:
                    return json.loads(json_match.group())
            return response if isinstance(response, dict) else {"endpoints": []}
        except:
            return {"endpoints": [], "error": "Failed to parse API contract"}
    
    def is_plan_sufficient(self, task_plan: TaskPlan, api_contract: Dict) -> bool:
        """Judge if plan is sufficient"""
        prompt = f"""Review this development plan and decide if it's sufficient to proceed.

TASK PLAN:
{task_plan.to_report()}

API CONTRACT:
{json.dumps(api_contract, ensure_ascii=False, indent=2)}

Check:
1. Are all features covered by tasks?
2. Are task dependencies correct?
3. Is the API contract complete enough for parallel development?
4. Are there any gaps or ambiguities?

Respond with JSON:
{{
    "sufficient": true/false,
    "reasoning": "Your reasoning",
    "missing_items": ["item1", "item2"] // if not sufficient
}}"""
        
        response = self._call_llm(prompt)
        
        try:
            if isinstance(response, str):
                import re
                json_match = re.search(r'\{[\s\S]*\}', response)
                if json_match:
                    data = json.loads(json_match.group())
                    return data.get("sufficient", True)
            return True
        except:
            return True
    
    # ==================== 🆕 v3.0: Fix Plan & Validation ====================
    
    def create_fix_plan(self, fix_issues: List[Dict], existing_plan: List[Dict] = None) -> List[Dict]:
        """
        🆕 v3.0: Create focused fix plan (디자인/목표 분석 SKIP)
        
        Args:
            fix_issues: Integration Review에서 발견된 문제 목록
            existing_plan: 이전 Task Plan (컨텍스트용)
        
        Returns:
            List[Dict]: 수정 작업 Task 목록
        """
        prompt = f"""You are an Architect creating a FOCUSED fix plan.

=== ISSUES TO FIX ===
{json.dumps(fix_issues, ensure_ascii=False, indent=2)}

=== PREVIOUS PLAN (context only) ===
{json.dumps(existing_plan or [], ensure_ascii=False, indent=2)}

=== RULES ===
1. Create ONLY tasks to fix the specific issues above
2. DO NOT re-analyze goals or re-design architecture
3. Task IDs MUST start with "FIX-" (e.g., "FIX-1", "FIX-2") to avoid ID conflicts
4. Explicitly mention the file paths that need to be fixed in the description
5. Assign to implementation teams ONLY: "designer", "backend_developer", "frontend_developer", "devops"
6. DO NOT assign to "architect" or "integration_reviewer"

Respond in JSON format:
{{
    "tasks": [
        {{
            "id": "FIX-1",
            "name": "Fix backend runtime error",
            "description": "Fix the specific error: ...",
            "assigned_to": "backend_developer",
            "priority": 1,
            "depends_on": []
        }}
    ]
}}"""
        
        response = self._call_llm(prompt)
        
        try:
            if isinstance(response, str):
                import re
                json_match = re.search(r'\{[\s\S]*\}', response)
                if json_match:
                    data = json.loads(json_match.group())
                    return data.get("tasks", [])
            return response.get("tasks", []) if isinstance(response, dict) else []
        except Exception as e:
            logger.error(f"[Architect] Failed to create fix plan: {e}")
            # Fallback: 간단한 수정 Task 생성
            return [{
                "id": "FIX-1",
                "name": "General Fix",
                "description": f"Fix issues: {fix_issues}",
                "assigned_to": "backend_developer",
                "priority": 1,
                "depends_on": []
            }]
    
    def validate_task_plan(self, task_plan: List[Dict]) -> tuple:
        """
        🆕 v3.0: Task Plan 검증
        
        검사 항목:
        1. 유효한 assigned_to 값
        2. 유효한 depends_on 참조
        3. 순환 의존성
        4. 디자인 → 프론트엔드 의존성
        
        Returns:
            tuple: (is_valid: bool, errors: List[str])
        """
        errors = []
        task_ids = {t.get("id") for t in task_plan}
        
        # 1. 유효한 assigned_to 검사
        for task in task_plan:
            if task.get("assigned_to") not in self.VALID_ASSIGNEES:
                errors.append(f"Invalid assigned_to '{task.get('assigned_to')}' in {task.get('id')}")
        
        # 2. depends_on 참조 검사
        for task in task_plan:
            for dep in task.get("depends_on", []):
                if dep not in task_ids:
                    errors.append(f"Invalid dependency '{dep}' in {task.get('id')}")
        
        # 3. 순환 의존성 검사
        if self._has_cycle(task_plan):
            errors.append("Circular dependency detected")
        
        # 4. 디자인 → 프론트엔드 의존성 검사
        frontend_tasks = [t for t in task_plan if t.get("assigned_to") == "frontend_developer"]
        design_tasks = [t for t in task_plan if t.get("assigned_to") == "designer"]
        
        if design_tasks and frontend_tasks:
            design_ids = {t.get("id") for t in design_tasks}
            for ft in frontend_tasks:
                deps = set(ft.get("depends_on", []))
                if not deps.intersection(design_ids):
                    errors.append(f"Frontend task {ft.get('id')} should depend on design tasks")
        
        return (len(errors) == 0, errors)
    
    def _has_cycle(self, tasks: List[Dict]) -> bool:
        """위상 정렬로 순환 의존성 검사"""
        from collections import deque
        
        if not tasks:
            return False
        
        # 그래프 구성
        graph = {t.get("id"): set(t.get("depends_on", [])) for t in tasks}
        in_degree = {t.get("id"): len(t.get("depends_on", [])) for t in tasks}
        
        # 진입 차수가 0인 노드로 시작
        queue = deque([tid for tid, deg in in_degree.items() if deg == 0])
        visited = 0
        
        while queue:
            node = queue.popleft()
            visited += 1
            for tid in graph:
                if node in graph[tid]:
                    # 이 로직이 잘못됨 - depends_on은 역방향
                    pass
            # 정방향 그래프로 재구성
            for tid, deps in graph.items():
                if node in deps:
                    in_degree[tid] -= 1
                    if in_degree[tid] == 0:
                        queue.append(tid)
        
        return visited != len(tasks)

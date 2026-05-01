"""
DAACS Agent Base Classes
Contains core agent definitions, roles, and shared data structures.
"""

from typing import Dict, List, Any, Optional
from dataclasses import dataclass, field
from enum import Enum
import json
import logging

logger = logging.getLogger("AgentBase")

class AgentRole(Enum):
    """Agent Roles"""
    ARCHITECT = "architect"
    DESIGNER = "designer"  # 🆕 v3.0: Designer role
    BACKEND_DEV = "backend_developer"
    FRONTEND_DEV = "frontend_developer"
    BACKEND_REVIEWER = "backend_reviewer"
    FRONTEND_REVIEWER = "frontend_reviewer"
    INTEGRATION_REVIEWER = "integration_reviewer"
    DEVOPS = "devops"

@dataclass
class Task:
    """Task Definition"""
    id: str
    name: str
    description: str
    assigned_to: AgentRole
    priority: int  # 1 = highest
    depends_on: List[str] = field(default_factory=list)  # task ids
    status: str = "pending"  # pending, in_progress, completed, failed
    estimated_effort: str = "medium"  # low, medium, high
    
    def to_dict(self) -> Dict:
        return {
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "assigned_to": self.assigned_to.value,
            "priority": self.priority,
            "depends_on": self.depends_on,
            "status": self.status,
            "estimated_effort": self.estimated_effort
        }

@dataclass
class TaskPlan:
    """Sprint Plan"""
    tasks: List[Task]
    api_contract: Dict = field(default_factory=dict)
    summary: str = ""
    
    def get_parallel_groups(self) -> List[List[Task]]:
        """Return groups of tasks that can be executed in parallel based on dependencies"""
        groups = []
        completed = set()
        remaining = list(self.tasks)
        
        while remaining:
            current_group = [
                t for t in remaining
                if all(dep in completed for dep in t.depends_on)
            ]
            
            if not current_group:
                # Prevent infinite loop in case of circular dependency
                current_group = remaining[:1]
            
            groups.append(current_group)
            for t in current_group:
                completed.add(t.id)
                remaining.remove(t)
        
        return groups
    
    def to_report(self) -> str:
        """Generate detailed report"""
        lines = [
            "╔══════════════════════════════════════════════════════════════════╗",
            "║                    📋 SPRINT PLAN                                 ║",
            "╠══════════════════════════════════════════════════════════════════╣"
        ]
        
        for task in self.tasks:
            lines.append(f"║ [{task.id}] {task.name:<50} ║")
            lines.append(f"║   └─ Assigned: {task.assigned_to.value:<44} ║")
            lines.append(f"║   └─ Priority: {task.priority:<41} ║")
            deps = ", ".join(task.depends_on) if task.depends_on else "None"
            lines.append(f"║   └─ Depends: {deps:<43} ║")
            lines.append(f"║   └─ Desc: {task.description[:40]:<44} ║")
            lines.append("╠══════════════════════════════════════════════════════════════════╣")
        
        lines.append("╚══════════════════════════════════════════════════════════════════╝")
        return "\n".join(lines)

@dataclass 
class ReviewResult:
    """Review Result"""
    approved: bool
    feedback: str
    issues: List[str] = field(default_factory=list)
    suggestions: List[str] = field(default_factory=list)

@dataclass
class CodeArtifact:
    """Code Artifact"""
    files: Dict[str, str]  # filename -> content
    role: str  # "backend" or "frontend"
    iteration: int = 1

class BaseAgent:
    """Base Agent Class"""
    
    def __init__(
        self,
        role: AgentRole,
        llm_client: Any,
        persona: str = "",
        cli_client: Any = None
    ):
        self.role = role
        self.llm = llm_client
        self.persona = persona or self._default_persona()
        self.conversation_history: List[Dict] = []
        self.cli_client = cli_client
        
        # Log CLI type for verification
        # 1. Check specific CLI client first
        if self.cli_client and hasattr(self.cli_client, "cli_type"):
            print(f"[{self.role.value}] Initialized with CLI: {self.cli_client.cli_type}")
        # 2. Check LLM client
        elif hasattr(self.llm, "cli_type"):
            print(f"[{self.role.value}] Initialized with CLI: {self.llm.cli_type}")
        elif hasattr(self.llm, "client") and hasattr(self.llm.client, "cli_type"):
            print(f"[{self.role.value}] Initialized with CLI: {self.llm.client.cli_type}")
        
    def _default_persona(self) -> str:
        """Default personas by role"""
        personas = {
            AgentRole.ARCHITECT: """You are a senior software architect with 15+ years of experience.
You excel at:
- Breaking down complex requirements into manageable tasks
- Designing clean, scalable architectures
- Defining clear API contracts that enable parallel development
- Making pragmatic decisions balancing time vs quality""",
            
            AgentRole.BACKEND_DEV: """You are a skilled backend developer specializing in Python and FastAPI.
You excel at:
- Writing clean, efficient, production-ready code
- Implementing robust APIs with proper error handling
- Following best practices (SOLID, DRY, KISS)
- Responding to code review feedback constructively

🚫 DO NOT CREATE: README.md, CONTRIBUTING.md, CHANGELOG.md, docs/*.md, *.txt
   ONLY create code files (.py, .json, .yaml)""",
            
            AgentRole.FRONTEND_DEV: """You are a UX-focused frontend developer who prioritizes USER EXPERIENCE over features.

You think from the user's perspective:
- What will users ACTUALLY do first?
- How can we reduce cognitive load?
- What's the minimal path to the goal?

You NEVER add features 'just because' - every element must serve the user.

=== DESIGN PHILOSOPHY ===
- Create VISUALLY APPEALING modern interfaces
- Use intentional color choices that match the project mood
- Gradients and effects are OK when they serve a purpose
- Generous whitespace improves readability
- Clear visual hierarchy guides the user

Reference great SaaS products for inspiration: linear.app, notion.so, stripe.com

=== CRITICAL REQUIREMENTS ===
- Frontend MUST run on port 3000 (configure in vite.config.js or package.json)
- Backend API calls should use http://localhost:8080

🚫 DO NOT CREATE: README.md, CONTRIBUTING.md, CHANGELOG.md, docs/*.md, *.txt
   ONLY create code files (.jsx, .tsx, .css, .js, .json, .html)""",
            
            AgentRole.BACKEND_REVIEWER: """You are a meticulous code reviewer for backend systems.
You focus on:
- API design correctness and consistency
- Error handling and edge cases
- Performance and security concerns
- Code quality and maintainability
You provide actionable, specific feedback.""",
            
            AgentRole.FRONTEND_REVIEWER: """You are a thoughtful frontend code reviewer focused on UX quality.

You evaluate:
- UX quality - Is the user flow intuitive?
- Visual design - Does it look professional and intentional?
- Component architecture and reusability
- Accessibility and responsive design

You provide constructive, specific feedback.
Focus on user experience over arbitrary style rules.""",
            
            AgentRole.INTEGRATION_REVIEWER: """You are a senior QA engineer focused on system integration.
You verify:
- API compatibility between frontend and backend
- Data format consistency
- Goal fulfillment - does the code meet user requirements?
- End-to-end functionality
You make autonomous decisions about quality sufficiency."""
        }
        return personas.get(self.role, "You are a helpful software engineer.")
    
    def _call_llm(self, prompt: str, context: str = "") -> str:
        """Call LLM with history"""
        full_prompt = f"""{self.persona}

=== CONTEXT ===
{context}

=== CONVERSATION HISTORY ===
{self._format_history()}

=== CURRENT REQUEST ===
{prompt}
"""
        
        try:
            if hasattr(self.llm, 'invoke_structured'):
                response = self.llm.invoke_structured(full_prompt)
            elif hasattr(self.llm, 'execute'):
                response = self.llm.execute(full_prompt)
            else:
                response = str(self.llm(full_prompt))
            
            # Add to history
            self.conversation_history.append({
                "role": self.role.value,
                "prompt": prompt[:200] + "..." if len(prompt) > 200 else prompt,
                "response": response[:500] + "..." if len(response) > 500 else response
            })
            
            return response
        except Exception as e:
            logger.error(f"[{self.role.value}] LLM call failed: {e}")
            return f"Error: {str(e)}"
    
    def _format_history(self) -> str:
        """Format conversation history"""
        if not self.conversation_history:
            return "(No previous conversation)"
        
        lines = []
        for entry in self.conversation_history[-5:]:  # Last 5 only
            if isinstance(entry, dict):
                prompt = entry.get('prompt', '')
                response = entry.get('response', '')
                role = entry.get('role', 'unknown')
                prompt_str = str(prompt)[:200] if prompt else ''
                response_str = str(response)[:200] if response else ''
                lines.append(f"[{role}]: {prompt_str}")
                lines.append(f"→ {response_str}...")
        return "\n".join(lines)
    
    def send_message(self, to_agent: 'BaseAgent', message: str):
        """Send message to another agent"""
        logger.info(f"[{self.role.value} → {to_agent.role.value}]: {message[:100]}...")
        to_agent.receive_message(self, message)
    
    def receive_message(self, from_agent: 'BaseAgent', message: str):
        """Receive message"""
        self.conversation_history.append({
            "role": from_agent.role.value,
            "prompt": message,
            "response": "(received)"
        })

    def think_before_act(self, context: str) -> str:
        """
        🤔 Thinking Mode: Analyze before acting.
        Forces the agent to stop and think about the requirements, risks, and plan.
        """
        logger.info(f"[{self.role.value}] 🤔 Thinking about task...")
        print(f"   🤔 [{self.role.value}] Thinking...")
        
        thinking_prompt = f"""
You are about to execute a task. STOP and THINK.

CONTEXT:
{context}

1. Analyze the requirements deeply.
2. Identify potential risks, edge cases, or ambiguities.
3. Formulate a step-by-step plan.
4. Output your thought process clearly.

Output format:
[ANALYSIS] ...
[RISKS] ...
[PLAN] ...
"""
        # Use a separate LLM call for thinking
        # If we have a CLI client, we might want to use it, but for pure reasoning, 
        # the standard LLM call is fine.
        
        thoughts = self._call_llm(thinking_prompt)
        
        print(f"   💡 Thoughts generated ({len(thoughts)} chars)")
        return thoughts

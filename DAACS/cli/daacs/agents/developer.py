"""
Developer Agent
Responsible for implementing tasks and writing code (Backend/Frontend).
"""

from typing import Dict, Any, Optional
import json
import logging
from .base import BaseAgent, AgentRole, Task, CodeArtifact

logger = logging.getLogger("DeveloperAgent")

class DeveloperAgent(BaseAgent):
    """Developer Agent (Backend/Frontend)"""
    
    def __init__(self, role: AgentRole, llm_client: Any, cli_client: Any = None):
        super().__init__(role, llm_client, cli_client=cli_client)
        # self.cli_client is set in BaseAgent
        self.current_code: Dict[str, str] = {}
        self.last_commit: Optional[str] = None
    
    def implement_task(
        self, 
        task: Task, 
        api_contract: Dict, 
        instructions: str = ""
    ) -> CodeArtifact:
        """Implement task (Legacy State-based)"""
        role_name = "backend" if self.role == AgentRole.BACKEND_DEV else "frontend"
        
        prompt = f"""Implement the following task:

TASK: {task.name}
DESCRIPTION: {task.description}

API CONTRACT:
{json.dumps(api_contract, ensure_ascii=False, indent=2)}

ADDITIONAL INSTRUCTIONS:
{instructions}

{"== BACKEND REQUIREMENTS ==" if role_name == "backend" else "== FRONTEND REQUIREMENTS =="}
{"- Python 3.12, FastAPI" if role_name == "backend" else "- React with Vite"}
{"- Port 8080, CORS enabled for http://localhost:5173" if role_name == "backend" else "- Connect to http://localhost:8080"}
{"- Include uvicorn.run() in main.py" if role_name == "backend" else "- Modern UI with gradients and animations"}
{"- Error format: {\"detail\": \"message\"}" if role_name == "backend" else "- Handle errors gracefully"}

Generate production-ready code. DO NOT generate README.md or any documentation files."""
        
        if self.cli_client:
            logger.info(f"[{self.role.value}] Executing implementation via CLI...")
            response = self.cli_client.execute(prompt)
        else:
            response = self._call_llm(prompt)
        
        files = self._parse_files(response)
        self.current_code = files
        
        return CodeArtifact(files=files, role=role_name)
    
    # CLI별 프롬프트 규칙 정의
    CLI_PROMPT_RULES = {
        "gemini": """
=== GEMINI SPECIFIC RULES ===
- You MUST explicitly use the file creation tool to create files.
- Do NOT output markdown code blocks for file content.
- Create files directly in the working directory.
""",
        "claude": """
=== CLAUDE SPECIFIC RULES ===
- Do NOT generate any documentation files (README.md, docs/, etc.).
- Focus ONLY on the source code implementation.
- Be concise.
""",
        "codex": ""
    }

    def implement_with_git(
        self,
        task: Dict,
        api_contract: Dict,
        git: Any # GitCollaborator
    ) -> str:
        """
        Implement task using Git
        Returns: commit_id
        """
        role_name = "backend" if self.role == AgentRole.BACKEND_DEV else "frontend"
        
        # 🆕 CLI cwd 확인 및 프롬프트에 포함
        cwd_instruction = ""
        cli_rules = ""
        
        if self.cli_client:
            # CWD Instruction
            if hasattr(self.cli_client, 'cwd'):
                cwd_path = self.cli_client.cwd
                cwd_instruction = f"""\n\n=== WORKING DIRECTORY ===
You are working in: {cwd_path}
Create ALL files in this directory.
"""
                logger.info(f"[{self.role.value}] CLI cwd: {cwd_path}")
            
            # CLI Specific Rules
            if hasattr(self.cli_client, 'cli_type'):
                cli_type = self.cli_client.cli_type
                cli_rules = self.CLI_PROMPT_RULES.get(cli_type, "")
                if cli_rules:
                    logger.info(f"[{self.role.value}] Applied rules for {cli_type}")
        
        prompt = f"""{cwd_instruction}{cli_rules}
Implement the following task:

TASK: {task.get('name', 'Implementation')}
DESCRIPTION: {task.get('description', '')}

API CONTRACT:
{json.dumps(api_contract, ensure_ascii=False, indent=2)}

{"== BACKEND REQUIREMENTS ==" if role_name == "backend" else "== FRONTEND REQUIREMENTS =="}
{"- Python 3.12, FastAPI" if role_name == "backend" else "- React with Vite"}
{"- Port 8080, CORS enabled for http://localhost:5173" if role_name == "backend" else "- Connect to http://localhost:8080"}
{"- Include uvicorn.run() in main.py for startup" if role_name == "backend" else "- Modern UI with gradients and animations"}
{"- Error format: {{\"detail\": \"message\"}}" if role_name == "backend" else "- Handle errors gracefully"}
{"- Create requirements.txt" if role_name == "backend" else "- Create package.json"}

=== CRITICAL RULES ===
1. SCOPE ENFORCEMENT: Implement ONLY what is described in the TASK DESCRIPTION. Do not add extra features "just in case".
2. NO OVER-ENGINEERING: Keep the solution simple and focused on the current requirement.
3. FILE CREATION: Create ONLY necessary source code files. Do NOT create README, docs, or test files unless explicitly asked.
4. PRODUCTION READY: Code must be clean, commented, and runnable.

Create ALL necessary files for a working {role_name}."""
        
        # 🧠 Thinking Mode
        thoughts = self.think_before_act(f"Task: {task.get('name')}\nDescription: {task.get('description')}")
        prompt = f"{thoughts}\n\n{prompt}"

        if self.cli_client:
            logger.info(f"[{self.role.value}] Implementing via CLI (cwd={getattr(self.cli_client, 'cwd', 'N/A')})...")
            try:
                self.cli_client.execute(prompt)
            except Exception as e:
                logger.error(f"[{self.role.value}] CLI execution failed: {e}")
                # 에러 발생 시에도 진행 (빈 커밋이라도 생성하여 흐름 유지)
        else:
            logger.warning(f"[{self.role.value}] No CLI client, using LLM only")
            self._call_llm(prompt)
        
        commit_id = git.commit_work(
            self.role.value,
            f"구현: {task.get('name', 'task')}"
        )
        self.last_commit = commit_id
        
        return commit_id
    
    def fix_with_git(
        self,
        feedback: str,
        git: Any # GitCollaborator
    ) -> str:
        """
        Fix code based on feedback and commit
        Returns: commit_id
        """
        # 🆕 CLI cwd 확인 및 프롬프트에 포함
        cwd_instruction = ""
        cli_rules = ""
        
        if self.cli_client:
            if hasattr(self.cli_client, 'cwd'):
                cwd_path = self.cli_client.cwd
                cwd_instruction = f"""\n\n=== WORKING DIRECTORY ===
You are working in: {cwd_path}
Modify files in this directory.
"""
            
            if hasattr(self.cli_client, 'cli_type'):
                cli_type = self.cli_client.cli_type
                cli_rules = self.CLI_PROMPT_RULES.get(cli_type, "")
        
        prompt = f"""{self.persona}
{cwd_instruction}{cli_rules}
Fix the code based on reviewer feedback.

REVIEWER FEEDBACK:
{feedback}

Fix the issues mentioned above. Only modify files that need fixing.
"""
        
        if self.cli_client:
            logger.info(f"[{self.role.value}] Fixing via CLI (cwd={getattr(self.cli_client, 'cwd', 'N/A')})...")
            try:
                self.cli_client.execute(prompt)
            except Exception as e:
                logger.error(f"[{self.role.value}] CLI execution failed: {e}")
        else:
            self._call_llm(prompt)
        
        # 🆕 Generate Korean commit message via LLM
        commit_msg_prompt = f"""
Summarize the following feedback in Korean (under 50 chars) for a git commit message.
FEEDBACK: {feedback}
OUTPUT ONLY THE KOREAN SUMMARY.
"""
        try:
            if self.cli_client:
                # Use a separate simple call if possible, or just use the first line of feedback translated
                # For simplicity and speed, let's just use a simple translation or format
                korean_msg = f"수정: {feedback[:30]}..." # Fallback
            else:
                korean_msg = self._call_llm(commit_msg_prompt).strip()
        except:
            korean_msg = f"수정: {feedback[:30]}..."

        commit_id = git.commit_work(
            self.role.value,
            korean_msg
        )
        self.last_commit = commit_id
        
        return commit_id
    
    def respond_to_feedback(self, feedback: str, current_code: Dict[str, str]) -> CodeArtifact:
        """Respond to feedback (Legacy State-based)"""
        role_name = "backend" if self.role == AgentRole.BACKEND_DEV else "frontend"
        
        prompt = f"""Fix the code based on reviewer feedback.

CURRENT CODE:
{json.dumps(current_code, ensure_ascii=False, indent=2)}

REVIEWER FEEDBACK:
{feedback}

Fix the issues mentioned in the feedback.
Only modify the parts that need fixing, keep the rest intact."""
        
        if self.cli_client:
            response = self.cli_client.execute(prompt)
        else:
            response = self._call_llm(prompt)
        
        files = self._parse_files(response)
        self.current_code.update(files)
        
        return CodeArtifact(files=self.current_code, role=role_name)
    
    def _parse_files(self, response: str) -> Dict[str, str]:
        """Parse files from response"""
        import re
        files = {}
        
        file_pattern = r'FILE:\s*([^\n]+)\s*```(?:\w+)?\s*([\s\S]*?)```'
        matches = re.findall(file_pattern, response, re.MULTILINE)
        
        for filename, content in matches:
            filename = filename.strip()
            content = content.strip()
            if filename and content:
                files[filename] = content
        
        return files

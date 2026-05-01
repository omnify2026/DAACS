"""
Refactorer Agent
Responsible for code cleanup and refactoring.
Uses GLM CLI (fixed).
"""

from typing import Dict, Any
import logging
from .base import BaseAgent, AgentRole

logger = logging.getLogger("RefactorerAgent")


class RefactorerAgent(BaseAgent):
    """
    Refactorer Agent (GLM Fixed)
    
    Specializes in:
    1. Code cleanup and formatting
    2. Removing dead code
    3. Improving code structure (DRY, SOLID)
    4. Renaming for clarity
    
    DOES NOT change business logic.
    """
    
    def __init__(self, llm_client: Any, cli_client: Any = None):
        # GLM CLI is fixed for this agent
        super().__init__(AgentRole.DEVOPS, llm_client, cli_client=cli_client)
        self.role_name = "refactorer"
    
    def refactor_code(self, code_files: Dict[str, str], context: str = "") -> Dict[str, str]:
        """
        Refactor the given code files.
        Returns: Dict of refactored files.
        """
        logger.info("[Refactorer] ✨ Starting code refactoring...")
        print("   ✨ [Refactorer] Cleaning up code...")
        
        import json
        
        prompt = f"""You are a Senior Code Refactoring Specialist using GLM.

Your goal is to CLEAN UP and REFACTOR the code WITHOUT changing business logic.

[CODE FILES]
{json.dumps(code_files, ensure_ascii=False, indent=2)}

[CONTEXT]
{context}

[REFACTORING RULES]
1. DO NOT change business logic or functionality.
2. Improve code structure (DRY, SOLID principles).
3. Remove dead code and unused imports.
4. Improve variable/function names for clarity.
5. Add type hints where missing.
6. Format code consistently (PEP8 for Python, Prettier for JS/TS).
7. Split large functions into smaller ones if needed.

[OUTPUT FORMAT]
Return the refactored files in JSON format:
{{
    "filename.py": "refactored code content",
    "filename2.tsx": "refactored code content"
}}

ONLY output the JSON, no explanations.
"""
        
        try:
            if self.cli_client:
                response = self.cli_client.execute(prompt)
            else:
                response = self._call_llm(prompt)
            
            # Parse JSON response
            if isinstance(response, str):
                import re
                json_match = re.search(r'\{[\s\S]*\}', response)
                if json_match:
                    refactored = json.loads(json_match.group())
                    logger.info(f"[Refactorer] ✅ Refactored {len(refactored)} files")
                    return refactored
            
            return code_files  # Return original if parsing fails
            
        except Exception as e:
            logger.error(f"[Refactorer] Refactoring failed: {e}")
            return code_files
    
    def refactor_with_git(self, git_collaborator: Any, project_dir: str) -> str:
        """
        Refactor code in the project directory and commit.
        """
        logger.info(f"[Refactorer] ✨ Refactoring project: {project_dir}")
        print(f"   ✨ [Refactorer] Refactoring {project_dir}...")
        
        import os
        import glob
        
        # Read current files
        code_files = {}
        patterns = ["**/*.py", "**/*.tsx", "**/*.ts", "**/*.jsx", "**/*.js"]
        
        for pattern in patterns:
            for filepath in glob.glob(os.path.join(project_dir, pattern), recursive=True):
                # Skip node_modules and __pycache__
                if "node_modules" in filepath or "__pycache__" in filepath:
                    continue
                try:
                    with open(filepath, "r", encoding="utf-8") as f:
                        rel_path = os.path.relpath(filepath, project_dir)
                        code_files[rel_path] = f.read()
                except:
                    pass
        
        if not code_files:
            logger.info("[Refactorer] No code files found to refactor")
            return None
        
        # Refactor
        refactored = self.refactor_code(code_files)
        
        # Write back
        for rel_path, content in refactored.items():
            full_path = os.path.join(project_dir, rel_path)
            os.makedirs(os.path.dirname(full_path), exist_ok=True)
            with open(full_path, "w", encoding="utf-8") as f:
                f.write(content)
        
        # Commit
        commit_id = git_collaborator.commit_work("refactorer", "리팩토링: 코드 정리 및 개선")
        logger.info(f"[Refactorer] ✅ Committed: {commit_id}")
        
        return commit_id

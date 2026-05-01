"""
DocWriter Agent
Responsible for generating documentation.
Uses DeepSeek CLI (fixed).
"""

from typing import Dict, Any
import logging
import os
from .base import BaseAgent, AgentRole

logger = logging.getLogger("DocWriterAgent")


class DocWriterAgent(BaseAgent):
    """
    DocWriter Agent (DeepSeek Fixed)
    
    Specializes in:
    1. README.md generation
    2. API documentation
    3. Code comments and docstrings
    4. CHANGELOG generation
    """
    
    def __init__(self, llm_client: Any, cli_client: Any = None):
        # DeepSeek CLI is fixed for this agent
        super().__init__(AgentRole.DEVOPS, llm_client, cli_client=cli_client)
        self.role_name = "docwriter"
    
    def generate_readme(self, project_dir: str, project_info: Dict = None) -> str:
        """
        Generate README.md for the project.
        """
        logger.info(f"[DocWriter] 📝 Generating README for {project_dir}...")
        print(f"   📝 [DocWriter] Writing README.md...")
        
        import json
        
        # Gather project info
        files_summary = []
        for root, dirs, files in os.walk(project_dir):
            # Skip common non-source directories
            dirs[:] = [d for d in dirs if d not in ["node_modules", "__pycache__", ".git", "venv", ".venv"]]
            for f in files:
                if f.endswith((".py", ".ts", ".tsx", ".js", ".jsx", ".json", ".yaml", ".yml")):
                    rel_path = os.path.relpath(os.path.join(root, f), project_dir)
                    files_summary.append(rel_path)
        
        prompt = f"""You are a Technical Documentation Specialist using DeepSeek.

Generate a professional README.md for this project.

[PROJECT DIRECTORY]
{project_dir}

[FILES]
{json.dumps(files_summary[:50], indent=2)}  # Limit to 50 files

[PROJECT INFO]
{json.dumps(project_info or {}, ensure_ascii=False, indent=2)}

[README REQUIREMENTS]
1. Project Title and Description
2. Features list
3. Tech Stack
4. Installation instructions
5. Usage examples
6. API documentation (if applicable)
7. Contributing guidelines (brief)
8. License

Write in a professional, clear style. Use emojis sparingly for visual appeal.
Output ONLY the README content in Markdown format.
"""
        
        try:
            if self.cli_client:
                readme_content = self.cli_client.execute(prompt)
            else:
                readme_content = self._call_llm(prompt)
            
            # Write README
            readme_path = os.path.join(project_dir, "README.md")
            with open(readme_path, "w", encoding="utf-8") as f:
                f.write(readme_content)
            
            logger.info(f"[DocWriter] ✅ README.md created at {readme_path}")
            return readme_path
            
        except Exception as e:
            logger.error(f"[DocWriter] README generation failed: {e}")
            return None
    
    def generate_api_docs(self, project_dir: str, api_spec: Dict = None) -> str:
        """
        Generate API documentation.
        """
        logger.info(f"[DocWriter] 📄 Generating API docs for {project_dir}...")
        print(f"   📄 [DocWriter] Writing API docs...")
        
        import json
        
        prompt = f"""You are a Technical Documentation Specialist.

Generate API documentation based on the following specification.

[API SPECIFICATION]
{json.dumps(api_spec or {}, ensure_ascii=False, indent=2)}

[OUTPUT FORMAT]
Generate a Markdown document with:
1. API Overview
2. Base URL and Authentication
3. Endpoints (grouped by resource)
   - Method, Path, Description
   - Request parameters/body
   - Response format
   - Example request/response
4. Error codes

Output ONLY the Markdown content.
"""
        
        try:
            if self.cli_client:
                docs_content = self.cli_client.execute(prompt)
            else:
                docs_content = self._call_llm(prompt)
            
            # Write API docs
            docs_dir = os.path.join(project_dir, "docs")
            os.makedirs(docs_dir, exist_ok=True)
            api_docs_path = os.path.join(docs_dir, "API.md")
            
            with open(api_docs_path, "w", encoding="utf-8") as f:
                f.write(docs_content)
            
            logger.info(f"[DocWriter] ✅ API docs created at {api_docs_path}")
            return api_docs_path
            
        except Exception as e:
            logger.error(f"[DocWriter] API docs generation failed: {e}")
            return None
    
    def document_with_git(self, git_collaborator: Any, project_dir: str, api_spec: Dict = None) -> str:
        """
        Generate all documentation and commit.
        """
        logger.info(f"[DocWriter] 📚 Documenting project: {project_dir}")
        print(f"   📚 [DocWriter] Generating documentation...")
        
        # Generate README
        self.generate_readme(project_dir)
        
        # Generate API docs if spec provided
        if api_spec:
            self.generate_api_docs(project_dir, api_spec)
        
        # Commit
        commit_id = git_collaborator.commit_work("docwriter", "문서화: README 및 API 문서 생성")
        logger.info(f"[DocWriter] ✅ Committed: {commit_id}")
        
        return commit_id

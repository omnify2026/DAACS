"""
DevOps Agent
Responsible for fixing runtime environment, infrastructure, and configuration issues.
"""

from typing import Dict, Any, List, Optional
import logging
import json
import os
from .base import BaseAgent, AgentRole

logger = logging.getLogger("DevOpsAgent")

class DevOpsAgent(BaseAgent):
    """
    DevOps Agent
    
    Specializes in:
    1. Dependency Management (pip, npm)
    2. Database Initialization (init_db.py)
    3. Configuration Management (.env, config.py)
    4. Process Management (Kill ports)
    
    RESTRICTIONS:
    - CANNOT modify business logic (*.py, *.tsx)
    - CANNOT create new features
    """
    
    def __init__(self, llm_client: Any, cli_client: Any = None):
        super().__init__(AgentRole.DEVOPS, llm_client, cli_client=cli_client)
        # self.cli_client is set in BaseAgent
        self.max_rounds = 3

    def analyze_and_fix(self, error_log: str, project_dir: str, context: Dict = None) -> Dict[str, Any]:
        """
        Analyzes the error log and attempts to fix the environment.
        Returns a report of actions taken.
        """
        logger.info(f"[DevOps] 🔧 Analyzing error in {project_dir}...")
        
        # 1. Context Preparation
        context = context or {}
        backend_dir = os.path.join(project_dir, "backend")
        frontend_dir = os.path.join(project_dir, "frontend")
        
        # Summarize error log (Token Optimization)
        # Take the last 20 lines or lines containing "Error"/"Exception"
        error_lines = [line for line in error_log.split('\n') if "Error" in line or "Exception" in line or "Traceback" in line]
        summary_log = "\n".join(error_lines[-20:]) if error_lines else error_log[-1000:]

        prompt = f"""You are a Senior DevOps Engineer.
Your goal is to FIX the runtime error in the project environment.

[ERROR LOG]
{summary_log}

[CONTEXT]
Project Dir: {project_dir}
Backend Dir: {backend_dir}
Frontend Dir: {frontend_dir}
OS: Windows

[RESTRICTIONS]
1. DO NOT modify source code (*.py, *.tsx) containing business logic.
2. ONLY modify configuration files (.env, config.py, requirements.txt, package.json).
3. ONLY run shell commands (pip, npm, python, kill).
4. If the error is a LOGIC error (e.g. 422 Validation Error), return "logic_issue".

[AVAILABLE ACTIONS]
- `run_command`: Execute shell command (e.g. "pip install ...", "python init_db.py")
- `write_file`: Create/Edit config file
- `read_file`: Read config file

[MISSION]
Analyze the error and execute the necessary actions to fix the environment.
Think step-by-step:
1. Identify the root cause (Dependency? DB? Port? Config?).
2. Formulate a plan.
3. Execute the plan using tools.

Respond in JSON format:
{{
    "analysis": "Brief analysis of the error",
    "action_plan": ["step 1", "step 2"],
    "commands_to_run": [
        {{"cmd": "pip install ...", "cwd": "{backend_dir}"}}
    ],
    "files_to_edit": [
        {{"path": "...", "content": "..."}}
    ],
    "is_logic_error": false
}}
"""
        
        # 2. LLM Call (Reasoning)
        if self.cli_client:
            response = self.cli_client.execute(prompt)
        else:
            response = self._call_llm(prompt)
            
        # 3. Parse Response
        try:
            if isinstance(response, str):
                import re
                json_match = re.search(r'\{[\s\S]*\}', response)
                if json_match:
                    plan = json.loads(json_match.group())
                else:
                    logger.error("[DevOps] Failed to parse JSON response")
                    return {"fixed": False, "message": "Failed to parse plan"}
            else:
                plan = response
                
            # 4. Check if Logic Error
            if plan.get("is_logic_error"):
                logger.info("[DevOps] Identified as Logic Error. Returning to Developer.")
                return {"fixed": False, "type": "logic_error", "message": plan.get("analysis")}

            # 5. Execute Plan (Action)
            logger.info(f"[DevOps] 🛠️ Executing Plan: {plan.get('action_plan')}")
            
            # 5.1 Edit Files
            for file_edit in plan.get("files_to_edit", []):
                path = file_edit["path"]
                content = file_edit["content"]
                logger.info(f"[DevOps] 📝 Editing file: {path}")
                os.makedirs(os.path.dirname(path), exist_ok=True)
                with open(path, "w", encoding="utf-8") as f:
                    f.write(content)
                    
            # 5.2 Run Commands
            for cmd_info in plan.get("commands_to_run", []):
                cmd = cmd_info["cmd"]
                cwd = cmd_info.get("cwd", project_dir)
                logger.info(f"[DevOps] 💻 Running: {cmd} in {cwd}")
                
                # Use subprocess for actual execution (Safe wrapper needed in real env)
                import subprocess
                try:
                    result = subprocess.run(cmd, shell=True, cwd=cwd, capture_output=True, text=True)
                    if result.returncode != 0:
                        logger.warning(f"[DevOps] Command failed: {result.stderr}")
                    else:
                        logger.info(f"[DevOps] Command success: {result.stdout[:100]}...")
                except Exception as e:
                    logger.error(f"[DevOps] Execution failed: {e}")

            return {
                "fixed": True,
                "report": plan.get("analysis"),
                "actions": plan.get("action_plan")
            }

        except Exception as e:
            logger.error(f"[DevOps] Execution failed: {e}")
            return {"fixed": False, "message": str(e)}

    def execute_test(self, test_cmd: str, cwd: str) -> Dict[str, Any]:
        """
        Executes a test command and returns the result.
        """
        logger.info(f"[DevOps] 🧪 Running test: {test_cmd} in {cwd}")
        
        try:
            # Use CLI if available
            if self.cli_client:
                # We need a way to get exit code from CLI. 
                # Most CLI clients return output string.
                # If we use run_command tool via CLI, we might get structured output.
                # For now, let's assume we use the shell execution wrapper or subprocess if local.
                
                # If running locally (which we are):
                import subprocess
                result = subprocess.run(test_cmd, shell=True, cwd=cwd, capture_output=True, text=True)
                
                success = result.returncode == 0
                output = result.stdout + "\n" + result.stderr
                
                return {
                    "success": success,
                    "error": output if not success else "",
                    "output": output
                }
            else:
                # Fallback for non-local (not implemented fully)
                return {"success": False, "error": "No CLI client for test execution"}
                
        except Exception as e:
            logger.error(f"[DevOps] Test execution failed: {e}")
            return {"success": False, "error": str(e)}

    # ==================== 🔥 GOD MODE METHODS ====================
    
    def kill_port(self, port: int) -> Dict[str, Any]:
        """
        🔥 God Mode: Kill process on a specific port (Windows).
        """
        logger.info(f"[DevOps] 🔫 Killing process on port {port}...")
        print(f"   🔫 [DevOps] Killing port {port}...")
        
        import subprocess
        try:
            # Find PID using netstat
            find_cmd = f'netstat -ano | findstr ":{port}"'
            result = subprocess.run(find_cmd, shell=True, capture_output=True, text=True)
            
            if result.stdout:
                lines = result.stdout.strip().split('\n')
                pids = set()
                for line in lines:
                    parts = line.split()
                    if len(parts) >= 5:
                        pids.add(parts[-1])
                
                # Kill each PID
                for pid in pids:
                    if pid and pid.isdigit():
                        kill_cmd = f'taskkill /PID {pid} /F'
                        subprocess.run(kill_cmd, shell=True)
                        logger.info(f"[DevOps] Killed PID {pid}")
                
                return {"success": True, "killed_pids": list(pids)}
            else:
                return {"success": True, "message": f"No process on port {port}"}
                
        except Exception as e:
            logger.error(f"[DevOps] kill_port failed: {e}")
            return {"success": False, "error": str(e)}
    
    def manage_venv(self, action: str, venv_path: str, requirements: str = None) -> Dict[str, Any]:
        """
        🔥 God Mode: Manage Python virtual environments.
        Actions: create, install, activate_cmd
        """
        logger.info(f"[DevOps] 🐍 Venv {action}: {venv_path}")
        print(f"   🐍 [DevOps] Venv {action}: {venv_path}")
        
        import subprocess
        try:
            if action == "create":
                cmd = f"python -m venv {venv_path}"
                result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
                return {"success": result.returncode == 0, "output": result.stdout + result.stderr}
            
            elif action == "install":
                pip_path = os.path.join(venv_path, "Scripts", "pip.exe")
                if not os.path.exists(pip_path):
                    pip_path = os.path.join(venv_path, "bin", "pip")  # Linux/Mac
                
                req_file = requirements or "requirements.txt"
                cmd = f'"{pip_path}" install -r {req_file}'
                result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
                return {"success": result.returncode == 0, "output": result.stdout + result.stderr}
            
            elif action == "activate_cmd":
                # Return activation command (user runs this)
                activate = os.path.join(venv_path, "Scripts", "activate")
                return {"success": True, "activate_cmd": activate}
            
            else:
                return {"success": False, "error": f"Unknown action: {action}"}
                
        except Exception as e:
            logger.error(f"[DevOps] manage_venv failed: {e}")
            return {"success": False, "error": str(e)}
    
    def manage_docker(self, action: str, container_name: str, image: str = None, ports: str = None) -> Dict[str, Any]:
        """
        🔥 God Mode: Manage Docker containers.
        Actions: run, stop, rm, build, ps
        """
        logger.info(f"[DevOps] 🐳 Docker {action}: {container_name}")
        print(f"   🐳 [DevOps] Docker {action}: {container_name}")
        
        import subprocess
        try:
            if action == "run":
                port_arg = f"-p {ports}" if ports else ""
                cmd = f'docker run -d --name {container_name} {port_arg} {image}'
            elif action == "stop":
                cmd = f'docker stop {container_name}'
            elif action == "rm":
                cmd = f'docker rm -f {container_name}'
            elif action == "build":
                cmd = f'docker build -t {image} .'
            elif action == "ps":
                cmd = 'docker ps -a'
            else:
                return {"success": False, "error": f"Unknown action: {action}"}
            
            result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
            return {"success": result.returncode == 0, "output": result.stdout + result.stderr}
            
        except Exception as e:
            logger.error(f"[DevOps] manage_docker failed: {e}")
            return {"success": False, "error": str(e)}
    
    def run_db_migration(self, migration_cmd: str, cwd: str) -> Dict[str, Any]:
        """
        🔥 God Mode: Run database migrations (Alembic, Django, etc).
        """
        logger.info(f"[DevOps] 🗃️ Running migration: {migration_cmd}")
        print(f"   🗃️ [DevOps] DB Migration: {migration_cmd}")
        
        import subprocess
        try:
            result = subprocess.run(migration_cmd, shell=True, cwd=cwd, capture_output=True, text=True)
            return {"success": result.returncode == 0, "output": result.stdout + result.stderr}
        except Exception as e:
            logger.error(f"[DevOps] run_db_migration failed: {e}")
            return {"success": False, "error": str(e)}
    
    def install_dependencies(self, requirements_file: str, cwd: str) -> Dict[str, Any]:
        """
        🔥 God Mode: Install Python dependencies from requirements.txt.
        """
        logger.info(f"[DevOps] 📦 Installing deps from {requirements_file}")
        print(f"   📦 [DevOps] Installing: {requirements_file}")
        
        import subprocess
        try:
            cmd = f'pip install -r {requirements_file}'
            result = subprocess.run(cmd, shell=True, cwd=cwd, capture_output=True, text=True)
            return {"success": result.returncode == 0, "output": result.stdout + result.stderr}
        except Exception as e:
            logger.error(f"[DevOps] install_dependencies failed: {e}")
            return {"success": False, "error": str(e)}

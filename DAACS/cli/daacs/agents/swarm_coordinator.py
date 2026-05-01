"""
Swarm Coordinator
Manages the collaboration between Developer, DevOps, and QA agents.
Implements the "Self-Correction Loop" for autonomous coding.
"""

import logging
from typing import Dict, Any, List, Optional
from .base import AgentRole, Task
from .developer import DeveloperAgent
from .devops import DevOpsAgent
from .reviewer import ReviewerAgent

logger = logging.getLogger("SwarmCoordinator")

class SwarmCoordinator:
    """
    Orchestrates the Swarm of agents to complete a task with zero human intervention.
    """
    
    def __init__(self, llm_client: Any, cli_client: Any = None):
        self.llm_client = llm_client
        self.cli_client = cli_client
        
        # Initialize Agents
        self.developer = DeveloperAgent(AgentRole.BACKEND_DEV, llm_client, cli_client) # Role will be dynamic
        self.devops = DevOpsAgent(llm_client, cli_client)
        self.qa = ReviewerAgent(AgentRole.BACKEND_REVIEWER, llm_client) # Role dynamic
        
        self.max_retries = 3

    def run_swarm_loop(self, task: Task, api_contract: Dict, project_dir: str, role: str = "backend") -> Dict[str, Any]:
        """
        Executes the Self-Correction Loop:
        1. Developer: Implement + Test
        2. DevOps: Run Test
        3. Loop: Fix until Pass or Max Retries
        4. QA: Final Review
        """
        logger.info(f"[Swarm] 🐝 Starting loop for task: {task.name} ({role})")
        print(f"\n🐝 [Swarm] Starting Autonomous Loop: {task.name}")
        
        # Update Agent Roles
        self.developer.role = AgentRole.BACKEND_DEV if role == "backend" else AgentRole.FRONTEND_DEV
        self.qa.role = AgentRole.BACKEND_REVIEWER if role == "backend" else AgentRole.FRONTEND_REVIEWER
        
        # Step 1: Implementation (Code + Test)
        print("   👨‍💻 Developer: Implementing code & tests...")
        # We inject a specific instruction to generate tests
        test_instruction = """
        [CRITICAL] You MUST create a test file to verify your code.
        - Backend: Create `test_{task_name}.py` using `pytest` and `httpx`.
        - Frontend: Create `Test{Component}.tsx` using `vitest` or `testing-library`.
        The test MUST be runnable and verify the core functionality.
        """
        
        # Call Developer
        # Note: DeveloperAgent.implement_task or implement_with_git needs to be called.
        # We assume we are using the Git-based flow if cli_client is present, but for now let's stick to the method that returns files or commits.
        # Let's use a unified wrapper or just call implement_with_git if we have git.
        
        # For this implementation, let's assume we are using the existing methods but we need to ensure tests are generated.
        # We will pass the instruction.
        
        # TODO: We need a GitCollaborator instance here. 
        # For now, let's assume the caller passes it or we create it.
        # To keep it simple for this first version, we will return a "Plan" or "Result" dict.
        
        pass 
        # Wait, I need to implement the actual logic.
        # I need the GitCollaborator to be passed in or created.
        
        return {"status": "pending_implementation"}

    def run_swarm_with_git(self, task: Dict, api_contract: Dict, git_collaborator: Any, project_dir: str, role: str = "backend") -> Dict[str, Any]:
        """
        Git-based Swarm Loop (Self-Correction)
        1. Developer: Implement + Test
        2. DevOps: Run Test
        3. Loop: Fix until Pass or Max Retries
        4. QA: Final Review
        """
        logger.info(f"[Swarm] 🐝 Starting Git Swarm for {task.get('name')}")
        print(f"\n🐝 [Swarm] Starting Autonomous Loop: {task.get('name')}")
        
        # Update Roles
        self.developer.role = AgentRole.BACKEND_DEV if role == "backend" else AgentRole.FRONTEND_DEV
        self.qa.role = AgentRole.BACKEND_REVIEWER if role == "backend" else AgentRole.FRONTEND_REVIEWER
        
        # 1. Developer Implement
        print("   👨‍💻 Developer: Coding...")
        
        # Inject Test Instruction
        test_instruction = """
[CRITICAL REQUIREMENT]
You MUST create a valid test file to verify your code.
- Backend: Create `test_{task_name}.py` using `pytest` and `httpx`.
- Frontend: Create `Test{Component}.tsx` using `vitest` or `testing-library`.
The test MUST be runnable and verify the core functionality.
"""
        # Append to task description temporarily
        original_desc = task.get("description", "")
        task["description"] = original_desc + test_instruction
        
        commit_id = self.developer.implement_with_git(task, api_contract, git_collaborator)
        task["description"] = original_desc # Restore
        
        # 2. Loop
        attempts = 0
        success = False
        final_status = "failed"
        
        while attempts < self.max_retries:
            print(f"\n   🔄 Iteration {attempts + 1}/{self.max_retries}")
            
            # 2.1 DevOps: Run Test
            print("   🛠️ DevOps: Running tests...")
            # Detect test command
            # TODO: Make this dynamic based on project type
            test_cmd = "pytest" if role == "backend" else "npm test"
            
            test_result = self.devops.execute_test(test_cmd, project_dir)
            
            if test_result["success"]:
                print("      ✅ Tests Passed!")
                
                # 2.2 QA Review (Only if tests pass)
                print("   🧐 QA: Reviewing code...")
                review_result = self.qa.review_with_git(
                    commit_id=self.developer.last_commit,
                    review_context=f"Tests Passed.\nOutput: {test_result['output'][:500]}",
                    task_description=task.get("description")
                )
                
                if review_result.approved:
                    print("      ✅ QA Approved!")
                    success = True
                    final_status = "completed"
                    break
                else:
                    print(f"      ❌ QA Rejected: {review_result.feedback}")
                    print("   👨‍💻 Developer: Fixing QA issues...")
                    fix_prompt = f"""QA Rejected your code.
Feedback: {review_result.feedback}
Issues: {review_result.issues}
Fix the code to satisfy QA."""
                    self.developer.fix_with_git(fix_prompt, git_collaborator)
                    attempts += 1
                    
            else:
                print(f"      ❌ Tests Failed: {test_result['error'][:100]}...")
                
                # 2.3 Fix (Test Failure)
                print("   👨‍💻 Developer: Fixing Test Failures...")
                fix_prompt = f"""Tests failed.
Error Output:
{test_result['error']}

Fix the code and/or the test to make it pass."""
                self.developer.fix_with_git(fix_prompt, git_collaborator)
                attempts += 1
        
        if not success:
            print("   ❌ Max retries reached. Task failed.")
            
        return {
            "success": success,
            "commit": self.developer.last_commit,
            "attempts": attempts,
            "status": final_status
        }

    def run_full_pipeline(
        self, 
        task: Dict, 
        api_contract: Dict, 
        git_collaborator: Any, 
        project_dir: str, 
        role: str = "backend",
        refactorer: Any = None,
        docwriter: Any = None
    ) -> Dict[str, Any]:
        """
        🚀 Full 7-Step Pipeline (nordiske_space Style)
        
        1. Developer → 코드 작성
        2. DevOps → 테스트 실행
        3. QA → 코드 리뷰
        4. Developer → 리뷰 반영 & 수정 (Loop)
        5. Refactorer (GLM) → 리팩토링
        6. DocWriter (DeepSeek) → 문서화
        → 최종 결과
        """
        logger.info(f"[Pipeline] 🚀 Starting Full Pipeline for {task.get('name')}")
        print(f"\n{'='*60}")
        print(f"  🚀 FULL PIPELINE: {task.get('name')}")
        print(f"{'='*60}")
        
        # Step 1-4: Core Development Loop (existing logic)
        print("\n📌 Phase 1: Development & QA Loop")
        dev_result = self.run_swarm_with_git(task, api_contract, git_collaborator, project_dir, role)
        
        if not dev_result["success"]:
            print("   ❌ Development Loop Failed. Escalating to Architect...")
            # Auto-Escalation: Return with escalation flag
            return {
                "success": False,
                "escalate_to": "architect",
                "reason": "Dev loop failed after max retries",
                "details": dev_result
            }
        
        # Step 5: Refactoring (GLM Fixed)
        print("\n📌 Phase 2: Refactoring (GLM)")
        if refactorer:
            try:
                refactor_commit = refactorer.refactor_with_git(git_collaborator, project_dir)
                print(f"   ✅ Refactoring complete: {refactor_commit}")
            except Exception as e:
                logger.warning(f"[Pipeline] Refactoring skipped: {e}")
                print(f"   ⚠️ Refactoring skipped: {e}")
        else:
            print("   ⚠️ Refactorer not provided, skipping...")
        
        # Step 6: Documentation (DeepSeek Fixed)
        print("\n📌 Phase 3: Documentation (DeepSeek)")
        if docwriter:
            try:
                doc_commit = docwriter.document_with_git(git_collaborator, project_dir, api_contract)
                print(f"   ✅ Documentation complete: {doc_commit}")
            except Exception as e:
                logger.warning(f"[Pipeline] Documentation skipped: {e}")
                print(f"   ⚠️ Documentation skipped: {e}")
        else:
            print("   ⚠️ DocWriter not provided, skipping...")
        
        print(f"\n{'='*60}")
        print(f"  ✅ PIPELINE COMPLETE")
        print(f"{'='*60}\n")
        
        return {
            "success": True,
            "commit": self.developer.last_commit,
            "status": "pipeline_complete"
        }

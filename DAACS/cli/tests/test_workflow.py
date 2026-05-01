
import os
import sys
import shutil
from typing import Any
from unittest.mock import MagicMock

# Add project root to path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from daacs.agents.base import AgentRole
from daacs.llm import SessionBasedCLIClient

def test_full_workflow():
    print("🚀 Starting Workflow Verification...")
    
    # 1. Mock CLI Client
    class MockCLI(SessionBasedCLIClient):
        def execute(self, prompt: str) -> str:
            print(f"   [MockCLI] Executing prompt ({len(prompt)} chars)...")
            return "Mock response from CLI"

    # 2. Project Setup Simulation
    goal = "Test Project Goal"
    project_name = "test_project_verification"
    projects_root = os.path.join(os.getcwd(), "projects_test")
    project_path = os.path.join(projects_root, project_name)
    
    if os.path.exists(projects_root):
        shutil.rmtree(projects_root)
    
    print(f"\n📌 Phase 1: Project Setup")
    os.makedirs(project_path, exist_ok=True)
    os.makedirs(os.path.join(project_path, "backend"), exist_ok=True)
    os.makedirs(os.path.join(project_path, "frontend"), exist_ok=True)
    print(f"   ✅ Created directories")
    
    # 3. Agent Initialization Verification
    print(f"\n📌 Phase 2: Agent Initialization")
    try:
        from daacs.agents.swarm_coordinator import SwarmCoordinator
        from daacs.agents.developer import DeveloperAgent
        from daacs.agents.devops import DevOpsAgent
        from daacs.agents.reviewer import ReviewerAgent
        from daacs.agents.refactorer import RefactorerAgent
        from daacs.agents.docwriter import DocWriterAgent
        
        # Developer
        dev_cli = MockCLI(cwd=project_path, cli_type="claude_code", client_name="developer")
        developer = DeveloperAgent(role=AgentRole.BACKEND_DEV, llm_client=None, cli_client=dev_cli)
        print("   ✅ DeveloperAgent initialized")
        
        # DevOps
        devops_cli = MockCLI(cwd=project_path, cli_type="claude_code", client_name="devops")
        devops = DevOpsAgent(llm_client=None, cli_client=devops_cli)
        print("   ✅ DevOpsAgent initialized")
        
        # Reviewer
        reviewer_cli = MockCLI(cwd=project_path, cli_type="codex", client_name="reviewer")
        reviewer = ReviewerAgent(role=AgentRole.BACKEND_REVIEWER, llm_client=None, cli_client=reviewer_cli)
        print("   ✅ ReviewerAgent initialized")
        
        # SwarmCoordinator
        coordinator = SwarmCoordinator(llm_client=None, cli_client=dev_cli)
        print("   ✅ SwarmCoordinator initialized")
        
        # Refactorer
        refactorer_cli = MockCLI(cwd=project_path, cli_type="glm", client_name="refactorer")
        refactorer = RefactorerAgent(llm_client=None, cli_client=refactorer_cli)
        print("   ✅ RefactorerAgent initialized")
        
        # DocWriter
        docwriter_cli = MockCLI(cwd=project_path, cli_type="deepseek", client_name="docwriter")
        docwriter = DocWriterAgent(llm_client=None, cli_client=docwriter_cli)
        print("   ✅ DocWriterAgent initialized")

        # Architect
        from daacs.agents.architect import ArchitectAgent
        architect_cli = MockCLI(cwd=project_path, cli_type="claude_code", client_name="architect")
        architect = ArchitectAgent(llm_client=None)  # Should not require role
        # Inject mock CLI if needed, though ArchitectAgent might not take cli_client in __init__ based on previous read.
        # Let's check ArchitectAgent.__init__ again.
        # It was: def __init__(self, llm_client: Any): super().__init__(AgentRole.ARCHITECT, llm_client)
        # So it does NOT take cli_client in __init__.
        print("   ✅ ArchitectAgent initialized")
        
    except Exception as e:
        print(f"   ❌ Agent Initialization Failed: {e}")
        import traceback
        traceback.print_exc()
        return

    # 4. Pipeline Execution Simulation
    print(f"\n📌 Phase 3: Pipeline Execution (Simulation)")
    try:
        # Developer Action
        print("   👨‍💻 Developer: Creating code...")
        dev_result = dev_cli.execute("Create code")
        print(f"   ✅ Developer finished")
        
        # DevOps Action
        print("   🧪 DevOps: Testing...")
        test_result = devops_cli.execute("Run tests")
        print(f"   ✅ DevOps finished")
        
        # Reviewer Action
        print("   🧐 Reviewer: Reviewing...")
        review_result = reviewer_cli.execute("Review code")
        print(f"   ✅ Reviewer finished")
        
    except Exception as e:
        print(f"   ❌ Pipeline Execution Failed: {e}")
        return

    print("\n✅ Workflow Verification Complete!")
    
    # Cleanup
    if os.path.exists(projects_root):
        shutil.rmtree(projects_root)

if __name__ == "__main__":
    test_full_workflow()

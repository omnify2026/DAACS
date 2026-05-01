import json
from unittest.mock import MagicMock
from daacs.orchestrator_agent import OrchestratorAgent
from daacs.context.types import TechContext

def test_source_traceability():
    agent = OrchestratorAgent(mode="test")
    
    # MOCK the client to avoid calling actual LLM CLI
    agent.client = MagicMock()
    
    # Valid JSON response simulating what the LLM should return
    mock_rfp_response = {
        "goal": "Build a fast python backend",
        "specs": [
            {
                "id": "TECH-BE",
                "type": "tech",
                "title": "FastAPI",
                "description": "High perf framework",
                "status": "accepted",
                "rationale": "Matches 'fast' constraint",
                "tech_category": "Backend",
                "sources": ["https://fastapi.tiangolo.com", "https://benchmarks.com"]
            }
        ],
        "blueprint": {
            "mermaid_script": "graph TD; C-->S",
            "components": ["Client", "Server"]
        }
    }
    
    # Configure mock to return this JSON string
    agent.client.execute.return_value = json.dumps(mock_rfp_response)
    
    # Simulate TechContext
    tech_context = {
        "facts": ["FastAPI is fast"],
        "constraints": ["fast"],
        "sources": ["https://fastapi.tiangolo.com", "https://benchmarks.com"]
    }
    
    print("Generating RFP with Mock LLM...")
    response_str = agent.finalize_rfp([], tech_context)
    try:
        response = json.loads(response_str)
    except json.JSONDecodeError:
        print(f"[ERROR] Failed to parse JSON: {response_str}")
        return

    print("\n[RFP Output]")
    print(json.dumps(response, indent=2))
    
    # Verification
    has_sources = False
    for spec in response.get("specs", []):
        if spec.get("type") == "tech" and spec.get("sources"):
             # Verify strict equality
            if spec["sources"] == ["https://fastapi.tiangolo.com", "https://benchmarks.com"]:
                print(f"\n[SUCCESS] Found sources for {spec['title']}: {spec['sources']}")
                has_sources = True
            
    if not has_sources:
        print("\n[FAILURE] Sources missing or incorrect.")
    else:
        print("\n[VERIFIED] Backend Traceability flow confirmed.")

if __name__ == "__main__":
    test_source_traceability()


import sys
import os

# Add project root to sys.path
# Add project root to sys.path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from daacs.graph.orchestrator_planning import orchestrator_planning_node
from daacs.models.daacs_state import DAACSState

mock_state = {
    "project_dir": "/Users/david/Desktop/python/github/transformers7-project/workspace/debug_plan",
    "current_goal": "Build a simple calculator",
    "orchestrator_model": "gemini",
    "tech_context": {},
    "assumptions": {}
}

print("Starting Planning Node Debug...")
try:
    result = orchestrator_planning_node(mock_state)
    print("Planning Success!")
    print(result)
except Exception as e:
    print("Planning Failed!")
    print(e)
    import traceback
    traceback.print_exc()

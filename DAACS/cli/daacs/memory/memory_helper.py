"""
DAACS Memory Helper
Bridge between the Workflow and MemoryManager.
Formats retrieved memories for LLM consumption.
"""

import logging
from typing import List, Dict, Any
from .vector_store import MemoryManager

logger = logging.getLogger("MemoryHelper")

class MemoryHelper:
    """
    Helper class to integrate MemoryManager into Agent workflows.
    """
    
    def __init__(self):
        self.memory = MemoryManager()
        
    def get_planning_context(self, goal: str) -> str:
        """
        Retrieve relevant planning memories for a goal.
        
        Returns:
            Formatted string for LLM prompt.
        """
        if not self.memory._initialized:
            return ""
            
        memories = self.memory.search_memory(
            query=goal,
            n_results=3,
            filter_metadata={"type": "plan"}
        )
        
        if not memories:
            return ""
            
        context = "\n=== 🧠 PAST EXPERIENCES (MEMORY) ===\n"
        context += "The following are successful plans from similar past projects. Use them as reference:\n"
        
        for i, mem in enumerate(memories, 1):
            content = mem.get("content", "")
            context += f"\n--- Experience #{i} ---\n{content[:500]}...\n"
            
        return context

    def get_fix_context(self, error_description: str) -> str:
        """
        Retrieve relevant fix memories for an error.
        
        Returns:
            Formatted string for LLM prompt.
        """
        if not self.memory._initialized:
            return ""
            
        memories = self.memory.search_memory(
            query=error_description,
            n_results=3,
            filter_metadata={"type": "fix"}
        )
        
        if not memories:
            return ""
            
        context = "\n=== 🧠 RECALLED SOLUTIONS (MEMORY) ===\n"
        context += "The following are solutions to similar errors from the past. Consider them:\n"
        
        for i, mem in enumerate(memories, 1):
            content = mem.get("content", "")
            context += f"\n--- Solution #{i} ---\n{content[:500]}...\n"
            
        return context
        
    def store_plan(self, goal: str, plan_summary: str):
        """Store a successful plan."""
        if self.memory._initialized:
            self.memory.add_memory(
                text=f"Goal: {goal}\nPlan: {plan_summary}",
                metadata={"type": "plan", "success": True},
                memory_type="plan"
            )
            
    def store_fix(self, error: str, solution: str):
        """Store a successful fix."""
        if self.memory._initialized:
            self.memory.add_memory(
                text=f"Error: {error}\nSolution: {solution}",
                metadata={"type": "fix", "success": True},
                memory_type="fix"
            )

import json
import os
from typing import List, Dict, Any
import difflib
from datetime import datetime

class MemoryManager:
    def __init__(self, memory_file="workspace/memory.json"):
        self.memory_file = memory_file
        # Ensure workspace dir exists
        os.makedirs(os.path.dirname(self.memory_file), exist_ok=True)
        self.memories = self._load()

    def _load(self) -> List[Dict]:
        if not os.path.exists(self.memory_file):
            return []
        try:
            with open(self.memory_file, 'r') as f:
                return json.load(f)
        except Exception as e:
            print(f"Failed to load memory: {e}")
            return []

    def save_experience(self, goal: str, plan: Any, score: float):
        """Save a new experience to long-term memory."""
        entry = {
            "timestamp": datetime.now().isoformat(),
            "goal": goal,
            "plan": plan,
            "score": score
        }
        self.memories.append(entry)
        self._save()

    def _save(self):
        try:
            with open(self.memory_file, 'w') as f:
                json.dump(self.memories, f, indent=2)
        except Exception as e:
            print(f"Failed to save memory: {e}")

    def retrieve_experience(self, current_goal: str, threshold=0.4) -> List[Dict]:
        """
        Retrieve relevant past experiences based on goal similarity.
        Returns top 3 matches sorted by score.
        """
        relevant = []
        for mem in self.memories:
            # Simple string similarity
            similarity = difflib.SequenceMatcher(None, current_goal, mem['goal']).ratio()
            if similarity >= threshold:
                relevant.append({
                    "memory": mem,
                    "similarity": similarity
                })
        
        # Sort by score (primary) and similarity (secondary)
        relevant.sort(key=lambda x: (x['memory']['score'], x['similarity']), reverse=True)
        
        return [r['memory'] for r in relevant[:3]]

# Singleton for easy access if needed
memory_manager = MemoryManager()

"""
Memory Store
Persistent storage for project context, error patterns, and learnings.
Enables agents to learn from past mistakes and maintain context across sessions.
"""

import os
import json
import logging
from typing import Dict, Any, List, Optional
from datetime import datetime
import hashlib

logger = logging.getLogger("MemoryStore")


class MemoryStore:
    """
    Long-term Memory for DAACS
    
    Stores:
    1. Project context (file structure, decisions)
    2. Error patterns (what failed, how it was fixed)
    3. Key decisions (architectural choices, rationale)
    """
    
    def __init__(self, memory_dir: str = ".daacs/memory"):
        self.memory_dir = memory_dir
        self.projects_dir = os.path.join(memory_dir, "projects")
        self.errors_dir = os.path.join(memory_dir, "errors")
        self.decisions_dir = os.path.join(memory_dir, "decisions")
        
        # Ensure directories exist
        for d in [self.projects_dir, self.errors_dir, self.decisions_dir]:
            os.makedirs(d, exist_ok=True)
        
        # Load error patterns cache
        self.error_patterns_file = os.path.join(self.errors_dir, "patterns.json")
        self.error_patterns = self._load_json(self.error_patterns_file, default=[])
        
        logger.info(f"[Memory] Initialized at {memory_dir}")
    
    def _load_json(self, path: str, default: Any = None) -> Any:
        """Load JSON file safely."""
        try:
            if os.path.exists(path):
                with open(path, "r", encoding="utf-8") as f:
                    return json.load(f)
        except Exception as e:
            logger.warning(f"[Memory] Failed to load {path}: {e}")
        return default if default is not None else {}
    
    def _save_json(self, path: str, data: Any) -> bool:
        """Save data to JSON file."""
        try:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
            return True
        except Exception as e:
            logger.error(f"[Memory] Failed to save {path}: {e}")
            return False
    
    # ==================== PROJECT CONTEXT ====================
    
    def save_project_context(self, project_id: str, context: Dict[str, Any]) -> bool:
        """
        Save project context for future reference.
        
        Context includes:
        - file_structure: List of files
        - tech_stack: Technologies used
        - api_contract: API specification
        - decisions: Key architectural decisions
        """
        context["_updated_at"] = datetime.now().isoformat()
        path = os.path.join(self.projects_dir, f"{project_id}.json")
        
        # Merge with existing context
        existing = self._load_json(path, default={})
        existing.update(context)
        
        success = self._save_json(path, existing)
        if success:
            logger.info(f"[Memory] Saved project context: {project_id}")
            print(f"   💾 [Memory] Project context saved: {project_id}")
        return success
    
    def load_project_context(self, project_id: str) -> Optional[Dict[str, Any]]:
        """Load project context."""
        path = os.path.join(self.projects_dir, f"{project_id}.json")
        context = self._load_json(path)
        if context:
            logger.info(f"[Memory] Loaded project context: {project_id}")
        return context
    
    # ==================== ERROR PATTERNS ====================
    
    def log_error_pattern(self, error_type: str, error_log: str, solution: str, context: Dict = None) -> bool:
        """
        Record an error pattern and its solution.
        Used to learn from past mistakes.
        """
        # Generate error signature (hash of key parts)
        signature = hashlib.md5(f"{error_type}:{error_log[:200]}".encode()).hexdigest()[:8]
        
        pattern = {
            "id": signature,
            "error_type": error_type,
            "error_sample": error_log[:500],  # Truncate for storage
            "solution": solution,
            "context": context or {},
            "created_at": datetime.now().isoformat(),
            "hit_count": 1
        }
        
        # Check if similar pattern exists
        for i, p in enumerate(self.error_patterns):
            if p["id"] == signature:
                # Update existing pattern
                self.error_patterns[i]["hit_count"] += 1
                self.error_patterns[i]["solution"] = solution  # Update with latest fix
                self._save_json(self.error_patterns_file, self.error_patterns)
                logger.info(f"[Memory] Updated error pattern: {signature} (hits: {self.error_patterns[i]['hit_count']})")
                return True
        
        # Add new pattern
        self.error_patterns.append(pattern)
        self._save_json(self.error_patterns_file, self.error_patterns)
        logger.info(f"[Memory] Logged new error pattern: {signature}")
        print(f"   📝 [Memory] New error pattern learned: {error_type}")
        return True
    
    def get_similar_errors(self, error_log: str, limit: int = 3) -> List[Dict[str, Any]]:
        """
        Find similar past errors and their solutions.
        Uses simple keyword matching (can be upgraded to vector similarity).
        """
        if not self.error_patterns:
            return []
        
        # Simple keyword matching
        keywords = set(error_log.lower().split())
        scored = []
        
        for pattern in self.error_patterns:
            sample_keywords = set(pattern["error_sample"].lower().split())
            overlap = len(keywords & sample_keywords)
            if overlap > 0:  # Lowered threshold for better matching
                scored.append((overlap, pattern))
        
        # Sort by score and return top matches
        scored.sort(key=lambda x: x[0], reverse=True)
        results = [p for _, p in scored[:limit]]
        
        if results:
            logger.info(f"[Memory] Found {len(results)} similar error patterns")
            print(f"   🔍 [Memory] Found {len(results)} similar past errors")
        
        return results
    
    # ==================== DECISIONS ====================
    
    def save_decision(self, key: str, value: str, reason: str, project_id: str = "global") -> bool:
        """
        Record a key decision with rationale.
        Examples: "auth_method": "JWT", "ORM used for simplicity"
        """
        decisions_file = os.path.join(self.decisions_dir, f"{project_id}.json")
        decisions = self._load_json(decisions_file, default={})
        
        decisions[key] = {
            "value": value,
            "reason": reason,
            "decided_at": datetime.now().isoformat()
        }
        
        success = self._save_json(decisions_file, decisions)
        if success:
            logger.info(f"[Memory] Saved decision: {key} = {value}")
        return success
    
    def get_decision(self, key: str, project_id: str = "global") -> Optional[Dict[str, Any]]:
        """Get a past decision."""
        decisions_file = os.path.join(self.decisions_dir, f"{project_id}.json")
        decisions = self._load_json(decisions_file, default={})
        return decisions.get(key)
    
    # ==================== SUMMARY ====================
    
    def get_memory_summary(self) -> Dict[str, Any]:
        """Get summary of stored memories."""
        projects = len([f for f in os.listdir(self.projects_dir) if f.endswith(".json")])
        errors = len(self.error_patterns)
        decisions = len([f for f in os.listdir(self.decisions_dir) if f.endswith(".json")])
        
        return {
            "projects_stored": projects,
            "error_patterns": errors,
            "decision_files": decisions,
            "memory_dir": self.memory_dir
        }

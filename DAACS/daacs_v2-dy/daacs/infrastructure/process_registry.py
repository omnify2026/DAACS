
import threading
import subprocess
from typing import Dict, Optional, List
import logging

logger = logging.getLogger(__name__)

class ProcessRegistry:
    """
    Thread-safe registry for managing project server processes.
    Singleton pattern ensures global access consistent with previous behavior,
    but encapsulated for better testing and safety.
    """
    _instance = None
    _lock = threading.RLock()

    def __new__(cls):
        with cls._lock:
            if cls._instance is None:
                cls._instance = super(ProcessRegistry, cls).__new__(cls)
                cls._instance._registry = {} # {project_id: {server_type: subprocess.Popen}}
                cls._instance._registry_lock = threading.RLock()
            return cls._instance

    def register(self, project_id: str, server_type: str, process: subprocess.Popen) -> None:
        with self._registry_lock:
            if project_id not in self._registry:
                self._registry[project_id] = {}
            
            # If a process already exists for this type, warn and overwrite (caller should have stopped it)
            if server_type in self._registry[project_id]:
                old_proc = self._registry[project_id][server_type]
                if old_proc.poll() is None:
                    logger.warning(f"Overwriting running {server_type} process for project {project_id}")
            
            self._registry[project_id][server_type] = process
            logger.debug(f"Registered {server_type} process for project {project_id}")

    def get(self, project_id: str, server_type: str) -> Optional[subprocess.Popen]:
        with self._registry_lock:
            return self._registry.get(project_id, {}).get(server_type)

    def get_all(self, project_id: str) -> Dict[str, subprocess.Popen]:
        with self._registry_lock:
            return self._registry.get(project_id, {}).copy()

    def unregister(self, project_id: str, server_type: str) -> None:
        with self._registry_lock:
            if project_id in self._registry:
                self._registry[project_id].pop(server_type, None)
                if not self._registry[project_id]:
                    del self._registry[project_id]

    def clear_project(self, project_id: str) -> None:
        with self._registry_lock:
            self._registry.pop(project_id, None)

    # For testing/reset
    @classmethod
    def reset(cls) -> None:
        with cls._lock:
            if cls._instance:
                with cls._instance._registry_lock:
                    cls._instance._registry.clear()

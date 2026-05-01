
import os
import json
import shutil
try:
    import fcntl
except ImportError:
    fcntl = None
import logging
import tempfile
from pathlib import Path
from typing import Dict, Any, Optional

logger = logging.getLogger(__name__)

class WorkspaceManager:
    """
    Manages workspace file operations with atomic writes and locking to ensure data integrity.
    Replaces unsafe file operations in legacy code.
    """
    
    def __init__(self, workspace_root: str = "workspace"):
        self.root = Path(workspace_root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def _get_project_dir(self, project_id: str) -> Path:
        return self.root / str(project_id)

    def ensure_project_dir(self, project_id: str) -> Path:
        path = self._get_project_dir(project_id)
        path.mkdir(parents=True, exist_ok=True)
        return path

    def save_state(self, project_id: str, state: Dict[str, Any]) -> None:
        """
        Atomically saves state.json with file locking.
        """
        project_dir = self.ensure_project_dir(project_id)
        state_file = project_dir / "state.json"
        
        # 1. Prepare temp file
        fd, temp_path = tempfile.mkstemp(dir=project_dir, text=True)
        try:
            with os.fdopen(fd, 'w') as f:
                json.dump(state, f, indent=2, ensure_ascii=False)
                f.flush()
                os.fsync(f.fileno()) # Ensure write to disk
                
            # 2. Acquire lock on destination and replace
            # Note: POSIX atomic rename is sufficient for atomicity, but locking prevents
            # read-modify-write races if multiple processes try to update state effectively.
            # Ideally we lock a separate lockfile.
            lock_file = project_dir / ".state.lock"
            with open(lock_file, 'w') as lock:
                if fcntl:
                    fcntl.flock(lock, fcntl.LOCK_EX) # Exclusive lock
                try:
                    shutil.move(temp_path, state_file)
                finally:
                    if fcntl:
                        fcntl.flock(lock, fcntl.LOCK_UN)
                    
            logger.info(f"Saved state for project {project_id}")
            
        except Exception as e:
            logger.error(f"Failed to save state for {project_id}: {e}")
            if os.path.exists(temp_path):
                os.remove(temp_path)
            raise e

    def load_state(self, project_id: str) -> Dict[str, Any]:
        """
        Loads state.json with read locking.
        """
        project_dir = self._get_project_dir(project_id)
        state_file = project_dir / "state.json"
        
        if not state_file.exists():
            return {}
            
        lock_file = project_dir / ".state.lock"
        # Ensure lock file exists
        if not lock_file.exists():
             self.ensure_project_dir(project_id)
             lock_file.touch()

        with open(lock_file, 'r') as lock:
            if fcntl:
                fcntl.flock(lock, fcntl.LOCK_SH) # Shared lock for reading
            try:
                with open(state_file, 'r') as f:
                    return json.load(f)
            except json.JSONDecodeError:
                logger.error(f"Corrupted state.json for {project_id}")
                return {} # Or raise
            finally:
                if fcntl:
                    fcntl.flock(lock, fcntl.LOCK_UN)

    def save_file(self, project_id: str, relative_path: str, content: str) -> None:
        """
        Atomically saves a file within the project workspace.
        """
        project_dir = self.ensure_project_dir(project_id)
        target_path = (project_dir / relative_path).resolve()
        
        if not str(target_path).startswith(str(project_dir)):
            raise ValueError(f"Invalid path traversal attempt: {relative_path}")
            
        target_path.parent.mkdir(parents=True, exist_ok=True)
        
        fd, temp_path = tempfile.mkstemp(dir=target_path.parent, text=True)
        try:
            with os.fdopen(fd, 'w') as f:
                f.write(content)
                f.flush()
                os.fsync(f.fileno())
            shutil.move(temp_path, target_path)
            logger.debug(f"Saved file {relative_path} for project {project_id}")
        except Exception as e:
            logger.error(f"Failed to save file {relative_path}: {e}")
            if os.path.exists(temp_path):
                os.remove(temp_path)
            raise e

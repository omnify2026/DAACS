"""
Chat History Persistence Module

Provides functions to save and load dual PM chat histories to/from JSON files.
Ensures conversation continuity across server restarts.
"""

import json
import logging
from pathlib import Path
from typing import List, Dict, Optional
from datetime import datetime

logger = logging.getLogger(__name__)


def get_project_dir(project_id: str) -> Path:
    """
    Get the project directory path for a given project ID.
    
    Args:
        project_id: The project identifier
        
    Returns:
        Path object pointing to the project directory
    """
    base = Path(__file__).parent.parent.parent / "workspace"
    direct = base / project_id
    legacy = base / f"project_{project_id}"
    if direct.exists() or not legacy.exists():
        return direct
    return legacy


def save_chat_history(project_id: str, pm_type: str, messages: List[Dict]) -> bool:
    """
    Save chat history to a JSON file.
    
    Args:
        project_id: The project identifier
        pm_type: 'ui' or 'tech' to distinguish PM roles
        messages: List of message dicts with 'role' and 'content' keys
        
    Returns:
        True if save was successful, False otherwise
        
    Example:
        >>> messages = [
        ...     {"role": "pm", "content": "Hello!"},
        ...     {"role": "user", "content": "Hi there"}
        ... ]
        >>> save_chat_history("12345", "ui", messages)
        True
    """
    try:
        project_dir = get_project_dir(project_id)
        project_dir.mkdir(parents=True, exist_ok=True)
        
        history_file = project_dir / f"chat_history_{pm_type}.json"
        
        data = {
            "project_id": project_id,
            "pm_type": pm_type,
            "updated_at": datetime.now().isoformat(),
            "message_count": len(messages),
            "messages": messages
        }
        
        with open(history_file, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        
        logger.info(f"[ChatHistory] Saved {len(messages)} messages for {pm_type} PM in project {project_id}")
        return True
        
    except Exception as e:
        logger.error(f"[ChatHistory] Failed to save for {pm_type} PM in project {project_id}: {e}")
        return False


def load_chat_history(project_id: str, pm_type: str) -> List[Dict]:
    """
    Load chat history from a JSON file.
    
    Args:
        project_id: The project identifier
        pm_type: 'ui' or 'tech' to distinguish PM roles
        
    Returns:
        List of message dicts, or empty list if file doesn't exist or error occurs
        
    Example:
        >>> messages = load_chat_history("12345", "ui")
        >>> len(messages)
        2
    """
    try:
        project_dir = get_project_dir(project_id)
        history_file = project_dir / f"chat_history_{pm_type}.json"
        
        if not history_file.exists():
            logger.debug(f"[ChatHistory] No history file found for {pm_type} PM in project {project_id}")
            return []
        
        with open(history_file, "r", encoding="utf-8") as f:
            data = json.load(f)
            messages = data.get("messages", [])
        
        logger.info(f"[ChatHistory] Loaded {len(messages)} messages for {pm_type} PM in project {project_id}")
        return messages
        
    except Exception as e:
        logger.error(f"[ChatHistory] Failed to load for {pm_type} PM in project {project_id}: {e}")
        return []


def clear_chat_history(project_id: str, pm_type: Optional[str] = None) -> bool:
    """
    Clear chat history for a specific PM type or all PMs.
    
    Args:
        project_id: The project identifier
        pm_type: 'ui', 'tech', or None to clear both
        
    Returns:
        True if clear was successful, False otherwise
    """
    try:
        project_dir = get_project_dir(project_id)
        
        if pm_type:
            history_file = project_dir / f"chat_history_{pm_type}.json"
            if history_file.exists():
                history_file.unlink()
                logger.info(f"[ChatHistory] Cleared history for {pm_type} PM in project {project_id}")
        else:
            # Clear both UI and Tech histories
            for role in ["ui", "tech"]:
                history_file = project_dir / f"chat_history_{role}.json"
                if history_file.exists():
                    history_file.unlink()
            logger.info(f"[ChatHistory] Cleared all histories for project {project_id}")
        
        return True
        
    except Exception as e:
        logger.error(f"[ChatHistory] Failed to clear history: {e}")
        return False


def get_chat_stats(project_id: str, pm_type: str) -> Dict:
    """
    Get statistics about chat history.
    
    Args:
        project_id: The project identifier
        pm_type: 'ui' or 'tech'
        
    Returns:
        Dict with stats like message count, last update time, etc.
    """
    try:
        project_dir = get_project_dir(project_id)
        history_file = project_dir / f"chat_history_{pm_type}.json"
        
        if not history_file.exists():
            return {
                "exists": False,
                "message_count": 0
            }
        
        with open(history_file, "r", encoding="utf-8") as f:
            data = json.load(f)
        
        return {
            "exists": True,
            "message_count": data.get("message_count", 0),
            "updated_at": data.get("updated_at"),
            "pm_type": data.get("pm_type"),
        }
        
    except Exception as e:
        logger.error(f"[ChatHistory] Failed to get stats: {e}")
        return {"exists": False, "message_count": 0, "error": str(e)}

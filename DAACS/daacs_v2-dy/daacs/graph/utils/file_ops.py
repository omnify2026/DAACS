"""
DAACS - File Operations Utilities
Common file operations with consistent encoding and error handling.
"""
import os
import json
import logging
from typing import Dict, Any, List, Optional, Tuple

logger = logging.getLogger(__name__)

# Default encoding for all file operations
DEFAULT_ENCODING = "utf-8"


def read_file_safe(filepath: str, max_bytes: int = 1024 * 1024) -> Tuple[bool, str]:
    """
    Safely read file contents with size limit.
    
    Returns:
        Tuple of (success, content_or_error)
    """
    try:
        if not os.path.exists(filepath):
            return False, f"File not found: {filepath}"
        
        if os.path.getsize(filepath) > max_bytes:
            return False, f"File too large: {os.path.getsize(filepath)} > {max_bytes}"
        
        with open(filepath, 'r', encoding=DEFAULT_ENCODING, errors='ignore') as f:
            content = f.read()
        return True, content
    except Exception as e:
        return False, str(e)


def write_file_safe(filepath: str, content: str, create_dirs: bool = True) -> Tuple[bool, str]:
    """
    Safely write file contents.
    
    Returns:
        Tuple of (success, error_message_or_empty)
    """
    try:
        if create_dirs:
            os.makedirs(os.path.dirname(filepath) or ".", exist_ok=True)
        
        with open(filepath, 'w', encoding=DEFAULT_ENCODING) as f:
            f.write(content)
        return True, ""
    except Exception as e:
        return False, str(e)


def read_json_safe(filepath: str) -> Tuple[bool, Any]:
    """
    Safely read and parse JSON file.
    
    Returns:
        Tuple of (success, parsed_json_or_error)
    """
    success, content = read_file_safe(filepath)
    if not success:
        return False, content
    
    try:
        data = json.loads(content)
        return True, data
    except json.JSONDecodeError as e:
        return False, f"JSON parse error: {e}"


def write_json_safe(filepath: str, data: Any, indent: int = 2) -> Tuple[bool, str]:
    """
    Safely write JSON file.
    
    Returns:
        Tuple of (success, error_message_or_empty)
    """
    try:
        content = json.dumps(data, indent=indent, ensure_ascii=False)
        return write_file_safe(filepath, content)
    except (TypeError, ValueError) as e:
        return False, f"JSON serialize error: {e}"


def list_files_recursive(
    directory: str,
    extensions: Optional[List[str]] = None,
    ignored_dirs: Optional[set] = None,
    max_files: int = 500
) -> List[str]:
    """
    Recursively list files in directory with filtering.
    
    Args:
        directory: Root directory to scan
        extensions: Optional list of allowed extensions (e.g., ['.py', '.js'])
        ignored_dirs: Set of directory names to skip
        max_files: Maximum number of files to return
        
    Returns:
        List of file paths relative to directory
    """
    if ignored_dirs is None:
        ignored_dirs = {
            'node_modules', '.git', '__pycache__', 'venv', '.venv',
            'env', 'dist', 'build', '.next', '.cache', '.pytest_cache'
        }
    
    files = []
    
    for root, dirs, filenames in os.walk(directory):
        # Filter out ignored directories
        dirs[:] = [d for d in dirs if d not in ignored_dirs]
        
        for name in filenames:
            if len(files) >= max_files:
                logger.warning(f"Max files limit ({max_files}) reached in {directory}")
                return files
            
            # Filter by extension if specified
            if extensions:
                ext = os.path.splitext(name)[1].lower()
                if ext not in extensions:
                    continue
            
            full_path = os.path.join(root, name)
            rel_path = os.path.relpath(full_path, directory)
            files.append(rel_path)
    
    return files


def ensure_directory(path: str) -> bool:
    """Create directory if it doesn't exist. Returns True on success."""
    try:
        os.makedirs(path, exist_ok=True)
        return True
    except Exception as e:
        logger.error(f"Failed to create directory {path}: {e}")
        return False

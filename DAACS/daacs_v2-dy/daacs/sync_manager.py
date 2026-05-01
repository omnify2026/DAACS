import os
import glob
import re
from typing import Dict, List, Any
from .utils import setup_logger

logger = setup_logger("SyncManager")

EXCLUDE_PATTERNS = ["node_modules", "__pycache__", "venv", ".venv", "dist", ".next", "build"]

class ConfigSyncer:
    def __init__(self, project_dir: str):
        self.project_dir = project_dir

    def detect_backend_config(self) -> Dict[str, str]:
        """Detect backend configuration (Port, API Prefix) from Python files."""
        config = {"port": "8000", "api_prefix": "/api"} # Defaults
        
        py_files = glob.glob(os.path.join(self.project_dir, "**/*.py"), recursive=True)
        py_files = [f for f in py_files if not any(p in f for p in EXCLUDE_PATTERNS)]
        
        for f in py_files:
            try:
                with open(f, 'r', encoding='utf-8', errors='ignore') as file:
                    content = file.read()
                    # Detect Port
                    port_match = re.search(r'(port\s*=\s*)(\d{4,5})', content)
                    if port_match:
                        config["port"] = port_match.group(2)
                    
                    # Detect Prefix
                    prefix_match = re.search(r'(API_PREFIX|BASE_URL)(\s*=\s*["\'])([^"\']*)(["\'])', content)
                    if prefix_match:
                        config["api_prefix"] = prefix_match.group(3)
                    
                    # FastAPI prefix
                    fastapi_prefix = re.search(r'prefix=["\']([^"\']+)["\']', content)
                    if fastapi_prefix:
                        config["api_prefix"] = fastapi_prefix.group(1)
            except OSError:
                pass
        return config

    def patch_frontend_config(self, backend_config: Dict[str, str], dry_run: bool = False) -> List[str]:
        """Patch Frontend files to match Backend Config."""
        patches = []
        
        js_patterns = ["**/*.js", "**/*.jsx", "**/*.ts", "**/*.tsx", "**/*.env", "**/*.env.local"]
        files = []
        for pattern in js_patterns:
            files.extend(glob.glob(os.path.join(self.project_dir, pattern), recursive=True))
            
        for f in files:
            if any(p in f for p in EXCLUDE_PATTERNS): continue
            try:
                with open(f, 'r', encoding='utf-8') as file:
                    content = file.read()
                
                new_content = content
                
                # 1. Patch localhost ports (e.g. localhost:5000 -> localhost:8000)
                def port_replacer(match):
                    current_port = match.group(2)
                    if current_port != backend_config['port']:
                        return f"{match.group(1)}{backend_config['port']}"
                    return match.group(0)
                    
                new_content = re.sub(r'(http://localhost:)(\d{4,5})', port_replacer, new_content)
                
                # 2. Patch API Prefix if simple match
                # e.g. /api/v1 -> /api/v2
                # This is tricky without knowing the exact string to replace, so we rely on the port for now as the main sync.
                # Or we can look for "BASE_URL" variable.
                
                if new_content != content:
                    if not dry_run:
                        with open(f, 'w', encoding='utf-8') as file:
                            file.write(new_content)
                    patches.append(f"Patched {os.path.basename(f)}: Synced to Port {backend_config['port']}")
                    
            except Exception as e:
                logger.warning(f"Failed to patch {f}: {e}")
                
        return patches

    def patch_backend_config(self, target_config: Dict[str, Any], dry_run: bool = False) -> List[str]:
        """Patch Backend files to match Target Config (from daacs_config.yaml)."""
        patches = []
        target_port = str(target_config.get("port", "8000"))
        
        py_files = glob.glob(os.path.join(self.project_dir, "**/*.py"), recursive=True)
        py_files = [f for f in py_files if not any(p in f for p in EXCLUDE_PATTERNS)]
        
        for f in py_files:
            try:
                with open(f, 'r', encoding='utf-8', errors='ignore') as file:
                    content = file.read()
                
                new_content = content
                
                # 1. Patch Port assignment (port=5000 -> port=8000)
                # Regex Captures:
                # 1: (port\s*=\s*)
                # 2: (["']?) - optional opening quote
                # 3: (\d+) - the number
                # 4: (["']?) - optional closing quote
                def port_replacer(match):
                    current_port = match.group(3)
                    quote_open = match.group(2)
                    quote_close = match.group(4)
                    
                    if current_port != target_port:
                        return f"{match.group(1)}{quote_open}{target_port}{quote_close}"
                    return match.group(0)
                
                new_content = re.sub(r'(port\s*=\s*)(["\']?)(\d+)(["\']?)', port_replacer, new_content)
                
                if new_content != content:
                    if not dry_run:
                        with open(f, 'w', encoding='utf-8') as file:
                            file.write(new_content)
                    patches.append(f"Patched Backend {os.path.basename(f)}: Enforced Port {target_port}")
                    
            except Exception as e:
                logger.warning(f"Failed to patch backend {f}: {e}")
                
        return patches


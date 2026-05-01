"""
DAACS v7.0 - Consistency Check Node
Frontend-backend API consistency verification.
"""
from typing import Dict, Any, List
import re
import os
import glob

from ...models.daacs_state import DAACSState
from ...utils import setup_logger
from ...graph.config_loader import DAACSConfig # 🆕

logger = setup_logger("ConsistencyCheckNode")

# Exclude patterns for file search
EXCLUDE_PATTERNS = ["node_modules", "__pycache__", "venv", ".venv", "dist", ".next", "build"]




def _extract_backend_endpoints(project_dir: str) -> List[Dict[str, Any]]:
    """Extract FastAPI/Flask routes from Python files."""
    endpoints = []
    py_files = glob.glob(os.path.join(project_dir, "**/*.py"), recursive=True)
    py_files = [f for f in py_files if not any(p in f for p in EXCLUDE_PATTERNS)]
    
    for f in py_files:
        try:
            with open(f, 'r', encoding='utf-8', errors='ignore') as file:
                content = file.read()
                # FastAPI/Flask route patterns
                matches = re.findall(r'@(?:app|router)\.(get|post|put|delete|patch)\(["\']([^"\']+)["\']', content, re.IGNORECASE)
                for method, path in matches:
                    endpoints.append({
                        "method": method.upper(),
                        "path": path,
                        "file": os.path.relpath(f, project_dir)
                    })
        except OSError:
            logger.debug("Failed to read backend file: %s", f)
    
    return endpoints


def _extract_frontend_calls(project_dir: str) -> List[Dict[str, Any]]:
    """Extract fetch/axios calls from JavaScript/TypeScript files."""
    calls = []
    js_patterns = ["**/*.js", "**/*.jsx", "**/*.ts", "**/*.tsx"]
    js_files = []
    for pattern in js_patterns:
        js_files.extend(glob.glob(os.path.join(project_dir, pattern), recursive=True))
    js_files = [f for f in js_files if not any(p in f for p in EXCLUDE_PATTERNS)]
    
    for f in js_files:
        try:
            with open(f, 'r', encoding='utf-8', errors='ignore') as file:
                content = file.read()
                
                # fetch pattern
                for url in re.findall(r'fetch\(["\']([^"\']+)["\']', content):
                    path = _normalize_url(url)
                    calls.append({"path": path, "file": os.path.relpath(f, project_dir)})
                
                # axios pattern
                for method, url in re.findall(r'axios\.(get|post|put|delete|patch)\(["\']([^"\']+)["\']', content, re.IGNORECASE):
                    path = _normalize_url(url)
                    calls.append({"method": method.upper(), "path": path, "file": os.path.relpath(f, project_dir)})
                    
        except OSError:
            logger.debug("Failed to read frontend file: %s", f)
    
    return calls


def _normalize_url(url: str) -> str:
    """Normalize URL by removing query params and handling absolute URLs."""
    path = url.split('?')[0]
    if path.startswith('http'):
        parts = path.split('/')
        if len(parts) >= 4:
            path = '/' + '/'.join(parts[3:])
    return path


def _match_paths(frontend_path: str, backend_paths: set) -> bool:
    """Check if frontend path matches any backend path."""
    normalized_call = frontend_path.rstrip('/')
    
    for bp in backend_paths:
        normalized_bp = bp.rstrip('/')
        
        # Exact match
        if normalized_call == normalized_bp:
            return True
        
        # Path parameter match: /api/items/{id} vs /api/items/123
        bp_pattern = normalized_bp.replace('{', '').replace('}', '')
        base_path = bp_pattern.rsplit('/', 1)[0] + '/'
        if normalized_call.startswith(base_path):
            return True
    
    return False


from ...sync_manager import ConfigSyncer


def _construct_api_spec_from_endpoints(endpoints: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Construct a standardized API Spec from extracted endpoints."""
    spec_endpoints = []
    for ep in endpoints:
        spec_endpoints.append({
            "method": ep["method"],
            "path": ep["path"],
            "description": f"Implemented in {ep['file']}",
            "parameters": [], # Extraction skipped for simplicity in heuristic check
            "responses": {}
        })
    return {"endpoints": spec_endpoints}


def consistency_check_node(state: DAACSState) -> Dict[str, Any]:
    """
    Consistency Check Node (Enhanced for API Alignment).
    
    Role:
    1. Extract ACTUAL implemented API from Backend.
    2. Establish it as the 'Source of Truth' (API Spec).
    3. Check Frontend compliance.
    4. If Frontend mismatches, force Rework with NEW Spec.
    """
    project_dir = state.get("project_dir", ".")
    
    logger.info("Checking API consistency & Aligning Spec...")
    
    # 1. Config Sync
    syncer = ConfigSyncer(project_dir)
    syncer.patch_frontend_config(syncer.detect_backend_config())
    
    # 2. Extract Actual API
    backend_endpoints = _extract_backend_endpoints(project_dir)
    frontend_calls = _extract_frontend_calls(project_dir)
    
    # 3. Construct Actual Spec
    actual_api_spec = _construct_api_spec_from_endpoints(backend_endpoints)
    endpoint_count = len(actual_api_spec["endpoints"])
    logger.info(f"Extracted Actual API Spec: {endpoint_count} endpoints found.")
    
    # 4. Consistency matching
    if not backend_endpoints and not frontend_calls:
        return {"consistency_passed": True, "consistency_check": {"summary": "No API found"}}
        
    issues = []
    backend_paths = {ep["path"] for ep in backend_endpoints}
    
    for call in frontend_calls:
        if not _match_paths(call["path"], backend_paths):
            issues.append({
                "type": "missing_endpoint",
                "frontend_call": call["path"], 
                "severity": "critical",
                "description": f"Frontend calls {call['path']} but Backend does not implement it."
            })
            
    consistent = len(issues) == 0
    
    result = {
        "consistent": consistent,
        "issues": issues,
        "summary": f"API Alignment: Backend has {endpoint_count} endpoints. Frontend has {len(issues)} mismatches.",
        # DATA UPDATES
        "api_spec": actual_api_spec, # 🆕 FORCE UPDATE API SPEC
        "consistency_passed": consistent
    }
    
    # 5. Determine Rework
    if not consistent:
        logger.warning(f"Consistency Failed. Updating API Spec and enforcing Frontend Rework. Issues: {len(issues)}")
        # If Frontend is calling things that don't exist, Frontend is wrong (Backend is Truth).
        # We update api_spec to matched Reality, so Frontend Agent can see what IS available.
        # But we also might need to tell Frontend "Hey, that endpoint doesn't exist, remove it or fix path".
        pass
        
    return {
        "consistency_check": result,
        "consistency_passed": consistent,
        "api_spec": actual_api_spec, # 🆕 UPDATE STATE
    }


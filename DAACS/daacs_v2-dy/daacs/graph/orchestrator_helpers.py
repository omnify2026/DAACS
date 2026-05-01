from typing import Dict, Any, Optional, List, Tuple
import json
import re
import os
import glob

from ..utils import setup_logger
from ..config import (
    SCORE_PENALTY_BUILD, SCORE_PENALTY_ASSETS, SCORE_PENALTY_SRC,
    SCORE_PENALTY_APP, SCORE_PENALTY_MAIN, SCORE_PENALTY_INDEX,
    GOAL_KEYWORD_COVERAGE_THRESHOLD, GOAL_SCAFFOLD_HITS_THRESHOLD,
    GOAL_MIN_CONTENT_LENGTH
)

logger = setup_logger("OrchestratorHelpers")

# Constants
CODE_BLOCK_PATTERNS = [
    r"```json\s*([\s\S]*?)\s*```",
    r"```\s*([\s\S]*?)\s*```",
]

SIMPLE_MARKERS = [
    "simple", "basic", "minimal", "single", "one page", "landing",
    "static", "demo", "sample", "prototype", "hello world",
    "샘플", "간단", "단순", "원페이지", "싱글페이지", "테스트", "프로토타입",
]

SCAFFOLD_INDICATORS = [
    "Edit src/App.jsx and save to test HMR",
    "Click on the Vite and React logos",
    "Learn React",
    "count is {count}",
    "Welcome to React",
    "Vite + React",
    "Create React App",
]

def _extract_json_from_response(response: str) -> Optional[Dict]:
    """LLM 응답에서 JSON 추출 (마크다운 코드블록 처리)"""
    if not response:
        return None

    if isinstance(response, dict):
        return response

    # 1. Direct JSON parsing
    try:
        return json.loads(response)
    except json.JSONDecodeError:
        pass # Continue to try extraction methods

    # 2. Extract from code blocks
    for pattern in CODE_BLOCK_PATTERNS:
        match = re.search(pattern, response)
        if match:
            try:
                return json.loads(match.group(1))
            except json.JSONDecodeError:
                logger.debug("Failed to parse JSON code block", exc_info=True)
                continue

    # 3. Extract from brace match (fallback)
    brace_match = re.search(r"\{[\s\S]*\}", response)
    if brace_match:
        try:
            return json.loads(brace_match.group(0))
        except json.JSONDecodeError:
             logger.debug("Failed to parse JSON brace match", exc_info=True)

    logger.warning("Could not extract JSON from response")
    return None


def _rank_goal_files(paths: List[str]) -> List[str]:
    """검증을 위해 파일 우선순위를 정함"""
    def score(path: str) -> Tuple[int, int]:
        normalized = path.replace("\\", "/").lower()
        base = os.path.basename(normalized)
        penalty = 0
        if "/dist/" in normalized or "/build/" in normalized:
            penalty += SCORE_PENALTY_BUILD
        if "/assets/" in normalized:
            penalty += SCORE_PENALTY_ASSETS
        if "/src/" in normalized:
            penalty += SCORE_PENALTY_SRC
        if base.startswith("app."):
            penalty += SCORE_PENALTY_APP
        if base.startswith("main."):
            penalty += SCORE_PENALTY_MAIN
        if base == "index.html":
            penalty += SCORE_PENALTY_INDEX
        return (penalty, len(path))

    return sorted(paths, key=score)


def _determine_goal_keywords(goal_lower: str) -> List[str]:
    """목표에 따른 필수 키워드 결정"""
    if "hello world" in goal_lower or ("hello" in goal_lower and "world" in goal_lower) or "안녕" in goal_lower:
        return ["hello world", "hello", "world", "welcome", "greeting", "안녕하세요", "안녕", "환영"]
    elif "계산" in goal_lower or "calculator" in goal_lower:
        return ["calculate", "계산", "+", "-", "*", "/", "result", "결과", "add", "subtract", "multiply", "divide"]
    elif "todo" in goal_lower or "할 일" in goal_lower:
        return ["todo", "task", "add", "delete", "complete", "list", "할 일", "추가", "삭제"]
    elif "게시판" in goal_lower or "board" in goal_lower:
        return ["post", "게시물", "write", "작성", "list", "목록", "delete", "삭제"]
    elif "alert" in goal_lower or "알림" in goal_lower:
        return ["alert", "알림", "button", "click", "onClick", "window.alert"]
    
    # 기본: 최소한 form, button, input 같은 인터랙션 요소가 있어야 함
    return ["form", "button", "input", "submit", "click", "onChange", "onClick"]


def _validate_goal_achievement(goal: str, files: List[str], project_dir: str, llm_client=None) -> Dict[str, Any]:
    """목표 달성 여부 검증"""
    if not files:
        return {
            "achieved": False,
            "reason": "No files generated",
            "missing_features": ["All features - no code files found"],
        }

    # 파일 내용 수집
    code_snippets = []
    for f in _rank_goal_files(files)[:5]:
        try:
            with open(f, "r", encoding="utf-8", errors="ignore") as file:
                content = file.read()[:500]
                code_snippets.append(f"=== {os.path.basename(f)} ===\n{content}")
        except OSError:
            logger.warning("Failed to read file for goal validation: %s", f)

    all_content = "\n".join(code_snippets)
    goal_lower = goal.lower()
    
    # 목표 유형 분석
    simple_goal = any(marker in goal_lower for marker in SIMPLE_MARKERS) or len(goal_lower.split()) <= 4
    goal_keywords = _determine_goal_keywords(goal_lower)

    # 키워드 매칭 확인
    found_keywords = [kw for kw in goal_keywords if kw.lower() in all_content.lower()]
    keyword_coverage = len(found_keywords) / max(len(goal_keywords), 1)

    # 스캐폴드(기본 코드) 감지
    scaffold_hits = sum(1 for indicator in SCAFFOLD_INDICATORS if indicator.lower() in all_content.lower())
    is_scaffold_only = scaffold_hits >= GOAL_SCAFFOLD_HITS_THRESHOLD or (scaffold_hits >= 1 and keyword_coverage < 0.2 and len(all_content) < GOAL_MIN_CONTENT_LENGTH)

    # 최종 판단
    if is_scaffold_only:
        return {
            "achieved": False,
            "reason": "Code appears to be default template/scaffold, not actual implementation",
            "missing_features": [f"Implementation of: {goal}"],
            "found_keywords": found_keywords,
        }

    if simple_goal and found_keywords:
        return {
            "achieved": True,
            "reason": "Simple goal detected and matching content found",
            "found_keywords": found_keywords,
        }

    if keyword_coverage < GOAL_KEYWORD_COVERAGE_THRESHOLD:
        return {
            "achieved": False,
            "reason": f"Low feature coverage ({keyword_coverage*100:.0f}%). Expected keywords not found in code.",
            "missing_features": [kw for kw in goal_keywords if kw.lower() not in all_content.lower()],
            "found_keywords": found_keywords,
        }

    return {
        "achieved": True,
        "reason": f"Code appears to implement the goal ({keyword_coverage*100:.0f}% keyword coverage)",
        "found_keywords": found_keywords,
    }


def _collect_backend_files(project_dir: str) -> List[str]:
    backend_dir = os.path.join(project_dir, "backend")
    backend_files = glob.glob(os.path.join(backend_dir, "**/*.py"), recursive=True)
    if not backend_files:
        backend_files = glob.glob(os.path.join(project_dir, "**/*.py"), recursive=True)
    return backend_files


def _collect_frontend_files(project_dir: str) -> List[str]:
    frontend_dir = os.path.join(project_dir, "frontend")
    src_dir = os.path.join(project_dir, "src")
    frontend_files: List[str] = []
    
    search_dirs = [d for d in [frontend_dir, src_dir, project_dir] if os.path.exists(d)]
    
    for search_dir in search_dirs:
        for ext in ["js", "jsx", "tsx", "ts", "html"]:
            frontend_files += glob.glob(os.path.join(search_dir, f"**/*.{ext}"), recursive=True)

    return list(set(f for f in frontend_files if "node_modules" not in f))


# ==================== API 추출 함수들 (kk에서 개선) ====================

def _extract_backend_endpoints(backend_files: List[str]) -> List[Dict[str, str]]:
    """
    Backend 코드에서 FastAPI/Flask 엔드포인트 추출 (개선 버전)
    - FastAPI: @app.get(), @router.post() 등
    - Flask: @app.route(), @blueprint.route()
    """
    endpoints: List[Dict[str, str]] = []
    
    # FastAPI/Flask 패턴들
    patterns = [
        r'@app\.(get|post|put|delete|patch)\s*\(\s*["\']([^"\']+)["\']',
        r'@router\.(get|post|put|delete|patch)\s*\(\s*["\']([^"\']+)["\']',
        r'@(?:app|blueprint)\.route\s*\(\s*["\']([^"\']+)["\'](?:.*methods\s*=\s*\[([^\]]+)\])?',
    ]
    
    for f in backend_files:
        try:
            with open(f, "r", encoding="utf-8", errors="ignore") as file:
                content = file.read()
                filename = os.path.basename(f)
                
                # Pattern 1 & 2: FastAPI decorators
                for pattern in patterns[:2]:
                    matches = re.findall(pattern, content, re.IGNORECASE)
                    for method, path in matches:
                        endpoints.append({
                            "method": method.upper(),
                            "path": path,
                            "file": filename
                        })
                
                # Pattern 3: Flask route with methods
                flask_matches = re.findall(patterns[2], content, re.IGNORECASE)
                for path, methods_str in flask_matches:
                    if methods_str:
                        methods = re.findall(r'["\'](\w+)["\']', methods_str)
                        for method in methods:
                            endpoints.append({
                                "method": method.upper(),
                                "path": path,
                                "file": filename
                            })
                    else:
                        endpoints.append({
                            "method": "GET",
                            "path": path,
                            "file": filename
                        })
                        
        except OSError:
            logger.debug("Failed to check backend file: %s", f)
    
    return endpoints


def _extract_frontend_calls(frontend_files: List[str]) -> List[Dict[str, str]]:
    """
    Frontend 코드에서 API 호출 추출 (개선 버전)
    - fetch() 직접 호출
    - axios 호출
    - 템플릿 리터럴 (백틱)
    - 래퍼 함수 (request, apiFetch, apiRequest 등)
    """
    api_calls: List[Dict[str, str]] = []
    
    # API 래퍼 함수 이름들
    wrapper_names = r'(?:request|apiFetch|apiRequest|apiCall|fetchAPI|api\.(?:get|post|put|patch|delete))'
    
    for f in frontend_files:
        try:
            with open(f, "r", encoding="utf-8", errors="ignore") as file:
                content = file.read()
                filename = os.path.basename(f)
                
                # Pattern 1: API 래퍼 함수 호출
                wrapper_pattern = wrapper_names + r'\s*\(\s*[`"\']([^`"\']+)["\'](?:\s*,\s*\{[^}]*method\s*:\s*["\'](\w+)["\'])?'
                wrapper_matches = re.findall(wrapper_pattern, content, re.IGNORECASE | re.DOTALL)
                for path, method in wrapper_matches:
                    method = method.upper() if method else 'GET'
                    normalized_path = _normalize_api_path(path)
                    api_calls.append({"method": method, "path": normalized_path, "file": filename})
                
                # Pattern 2: 템플릿 리터럴 (백틱)
                template_pattern = wrapper_names + r'\s*\(\s*`([^`]+)`(?:\s*,\s*\{[^}]*method\s*:\s*["\'](\w+)["\'])?'
                template_matches = re.findall(template_pattern, content, re.IGNORECASE | re.DOTALL)
                for path, method in template_matches:
                    method = method.upper() if method else 'GET'
                    normalized_path = _normalize_api_path(path)
                    api_calls.append({"method": method, "path": normalized_path, "file": filename})
                
                # Pattern 3: fetch() 직접 호출
                fetch_patterns = [
                    r'fetch\s*\(\s*`\$\{[^}]+\}([^`]+)`',
                    r'fetch\s*\(\s*[`"\']([^`"\']+/api[^`"\']*)["\']',
                    r'fetch\s*\(\s*[`"\']([^`"\']+)["\']',
                ]
                for pattern in fetch_patterns:
                    matches = re.findall(pattern, content, re.IGNORECASE)
                    for path in matches:
                        normalized_path = _normalize_api_path(path)
                        if normalized_path:
                            api_calls.append({"method": "GET", "path": normalized_path, "file": filename})
                
                # Pattern 4: fetch with method
                method_pattern = r'fetch\s*\([^)]*[`"\']([^`"\']+)["\'][^}]*method\s*:\s*["\'](\w+)["\']'
                method_matches = re.findall(method_pattern, content, re.IGNORECASE | re.DOTALL)
                for path, method in method_matches:
                    normalized_path = _normalize_api_path(path)
                    api_calls.append({"method": method.upper(), "path": normalized_path, "file": filename})
                
                # Pattern 5: axios 호출
                axios_pattern = r'axios\.(get|post|put|delete|patch)\s*\(\s*[`"\']([^`"\']+)'
                axios_matches = re.findall(axios_pattern, content, re.IGNORECASE)
                for method, path in axios_matches:
                    normalized_path = _normalize_api_path(path)
                    if normalized_path and normalized_path != '/':
                        api_calls.append({"method": method.upper(), "path": normalized_path, "file": filename})
                        
        except OSError:
            logger.debug("Failed to check frontend file: %s", f)
    
    # 중복 제거
    seen = set()
    unique_calls = []
    for call in api_calls:
        key = (call['method'], call['path'])
        if key not in seen:
            seen.add(key)
            unique_calls.append(call)
    
    logger.debug(f"[Frontend API Detection] Found {len(unique_calls)} unique API calls")
    return unique_calls


def _normalize_api_path(path: str) -> str:
    """API 경로 정규화"""
    if not path:
        return ""
    
    # 변수 치환: ${id}, ${var} 등 -> {id}
    path = re.sub(r'\$\{[^}]+\}/?', '{id}/', path)
    path = re.sub(r'/\{id\}/$', '/{id}', path)
    
    # URL에서 도메인 제거
    if path.startswith('http'):
        try:
            from urllib.parse import urlparse
            parsed = urlparse(path)
            path = parsed.path
        except:
            pass
    
    # 경로가 /로 시작하지 않으면 추가
    if path and not path.startswith('/'):
        path = '/' + path
    
    # 쿼리스트링 제거
    path = path.split('?')[0]
    
    return path


def _normalize_call_path(call) -> str:
    """레거시 호환용"""
    if isinstance(call, dict):
        return call.get("path", "")
    return _normalize_api_path(call)


def _analyze_endpoint_compatibility(
    backend_files: List[str],
    frontend_files: List[str],
) -> Dict[str, Any]:
    """Backend/Frontend API 호환성 분석 (개선 버전)"""
    from .utils.path_matcher import paths_match
    
    endpoint_analysis = {"backend_endpoints": [], "frontend_calls": [], "mismatches": []}
    compatibility_issues: List[str] = []

    endpoint_analysis["backend_endpoints"] = _extract_backend_endpoints(backend_files)
    endpoint_analysis["frontend_calls"] = _extract_frontend_calls(frontend_files)

    backend_paths = [(ep["method"], ep["path"]) for ep in endpoint_analysis["backend_endpoints"]]
    
    for call in endpoint_analysis["frontend_calls"]:
        call_path = call["path"] if isinstance(call, dict) else call
        call_method = call.get("method", "GET") if isinstance(call, dict) else "GET"
        
        matched = False
        for be_method, be_path in backend_paths:
            if paths_match(call_path, be_path):
                matched = True
                break
        
        if not matched:
            endpoint_analysis["mismatches"].append(call_path)
            compatibility_issues.append(f"Frontend calls {call_method} {call_path} but no matching backend endpoint")

    return {"compatibility_issues": compatibility_issues, "endpoint_analysis": endpoint_analysis}

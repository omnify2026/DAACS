"""
DAACS Graph Utils - Path Matcher
API 경로 비교 유틸리티 (동의어 매칭 지원)
"""

import re
from typing import Optional


# 동의어 매핑 (동일 엔티티로 취급)
PATH_SYNONYMS = {
    'tasks': 'todos',
    'items': 'todos',
    'task': 'todo',
    'item': 'todo',
    'posts': 'articles',
    'post': 'article',
    'users': 'accounts',
    'user': 'account',
}


def paths_match(path1: str, path2: str) -> bool:
    """
    경로 비교 (prefix 차이 및 path parameter 처리)
    
    Examples:
        /api/posts == /posts (prefix 유연 처리)
        /api/posts/{id} == /api/posts/{id}
        /api/posts/123 == /api/posts/{id}
        /api/tasks == /api/todos (동의어)
    
    Args:
        path1: 첫 번째 경로
        path2: 두 번째 경로
        
    Returns:
        두 경로가 일치하면 True
    """
    return _normalize_path(path1) == _normalize_path(path2)


def _normalize_path(path: str) -> str:
    """경로 정규화"""
    # /api prefix 제거
    if path.startswith('/api'):
        path = path.replace('/api', '', 1)
    
    # 끝의 슬래시 제거
    path = path.rstrip('/')
    
    # path parameter 정규화: /123, /:id, /{id}, /{bookmark_id} 등 → /{id}
    path = re.sub(r'/\d+', '/{id}', path)
    path = re.sub(r'/:\w+', '/{id}', path)
    path = re.sub(r'/\{[\w_]+\}', '/{id}', path)
    
    # 동의어 정규화
    for synonym, canonical in PATH_SYNONYMS.items():
        path = path.replace(f'/{synonym}', f'/{canonical}')
    
    return path


def find_unmatched_endpoints(
    backend_endpoints: list,
    frontend_calls: list
) -> dict:
    """
    Backend 엔드포인트와 Frontend API 호출 비교
    
    Args:
        backend_endpoints: Backend 엔드포인트 목록 [{"method": "GET", "path": "/api/..."}]
        frontend_calls: Frontend API 호출 목록 [{"method": "GET", "path": "/api/..."}]
        
    Returns:
        {
            "missing_in_backend": [...],  # Frontend에서 호출하지만 Backend에 없음
            "unused_in_frontend": [...],  # Backend에 있지만 Frontend에서 호출 안함
            "matched": [...]              # 일치하는 것들
        }
    """
    result = {
        "missing_in_backend": [],
        "unused_in_frontend": [],
        "matched": []
    }
    
    # Backend 경로 정규화
    backend_normalized = {
        (_normalize_path(e["path"]), e.get("method", "GET").upper()): e
        for e in backend_endpoints
    }
    
    # Frontend 호출 확인
    frontend_matched = set()
    for call in frontend_calls:
        key = (_normalize_path(call["path"]), call.get("method", "GET").upper())
        if key in backend_normalized:
            result["matched"].append(call)
            frontend_matched.add(key)
        else:
            result["missing_in_backend"].append(call)
    
    # 사용되지 않은 Backend 엔드포인트
    for key, endpoint in backend_normalized.items():
        if key not in frontend_matched:
            result["unused_in_frontend"].append(endpoint)
    
    return result

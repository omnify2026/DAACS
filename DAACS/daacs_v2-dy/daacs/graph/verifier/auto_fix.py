"""
DAACS v6.0 - Auto Fix Module
LLM이 자주 틀리는 패턴들을 자동으로 수정하여 품질 향상.
"""

import os
import re
from typing import Dict, List, Tuple, Optional

from ...utils import setup_logger

logger = setup_logger("Verifier.AutoFix")


# ============================================================================
# 1. PYDANTIC V1 → V2 자동 변환
# ============================================================================

def fix_pydantic_v1_to_v2(content: str) -> Tuple[str, List[str]]:
    """
    Pydantic v1 문법을 v2로 자동 변환.
    
    변환 패턴:
    - @validator → @field_validator
    - @root_validator → @model_validator
    - from pydantic import validator → field_validator
    
    Returns:
        (수정된 코드, 변경 사항 목록)
    """
    changes = []
    modified = content
    
    # 1. Import 변환: validator → field_validator
    if re.search(r'from\s+pydantic\s+import\s+.*\bvalidator\b', modified):
        modified = re.sub(
            r'(from\s+pydantic\s+import\s+.*)\bvalidator\b',
            r'\1field_validator',
            modified
        )
        changes.append("import: validator → field_validator")
    
    # 2. Import 변환: root_validator → model_validator
    if re.search(r'from\s+pydantic\s+import\s+.*\broot_validator\b', modified):
        modified = re.sub(
            r'(from\s+pydantic\s+import\s+.*)\broot_validator\b',
            r'\1model_validator',
            modified
        )
        changes.append("import: root_validator → model_validator")
    
    # 3. Decorator 변환: @validator → @field_validator
    if '@validator' in modified:
        # @validator('field') → @field_validator('field')
        modified = re.sub(r'@validator\s*\(', '@field_validator(', modified)
        changes.append("decorator: @validator → @field_validator")
        
        # v2에서는 mode='before' 또는 mode='after' 필요
        # 기본값으로 mode='before' 추가 (기존 v1 동작과 유사)
        if "mode=" not in modified:
            modified = re.sub(
                r"@field_validator\(([^)]+)\)",
                r"@field_validator(\1, mode='before')",
                modified
            )
            changes.append("field_validator: mode='before' 추가")
    
    # 4. Decorator 변환: @root_validator → @model_validator
    if '@root_validator' in modified:
        modified = re.sub(r'@root_validator\s*\(', '@model_validator(', modified)
        modified = re.sub(r'@root_validator\s*$', '@model_validator(mode="before")', modified, flags=re.MULTILINE)
        changes.append("decorator: @root_validator → @model_validator")
    
    # 5. cls 첫 번째 인자 → v2에서는 cls 대신 self 사용 (classmethod 아님)
    # 이 변환은 복잡하므로 경고만 추가
    if changes and re.search(r'def\s+\w+\s*\(\s*cls\s*,', modified):
        changes.append("WARNING: cls 인자를 info 객체로 변경 필요할 수 있음")
    
    return modified, changes


# ============================================================================
# 2. EMPTY __init__.py 자동 채움
# ============================================================================

def fix_empty_init_py(filepath: str) -> bool:
    """
    빈 __init__.py 파일에 docstring 삽입.
    
    Returns:
        True if fixed, False otherwise
    """
    if not filepath.endswith('__init__.py'):
        return False
    
    if not os.path.exists(filepath):
        return False
    
    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            content = f.read()
        
        # 이미 내용이 있으면 스킵
        if content.strip():
            return False
        
        # 디렉토리 이름에서 패키지명 추출
        package_name = os.path.basename(os.path.dirname(filepath))
        docstring = f'"""{package_name} package."""\n'
        
        with open(filepath, 'w', encoding='utf-8') as f:
            f.write(docstring)
        
        logger.info("Fixed empty __init__.py: %s", filepath)
        return True
        
    except Exception as e:
        logger.warning("Failed to fix __init__.py %s: %s", filepath, e)
        return False


# ============================================================================
# 3. CORS 미들웨어 자동 추가
# ============================================================================

CORS_IMPORT = "from fastapi.middleware.cors import CORSMiddleware"

CORS_MIDDLEWARE_SNIPPET = '''
# CORS Middleware (auto-added by DAACS)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
'''

def fix_missing_cors(content: str) -> Tuple[str, bool]:
    """
    FastAPI 앱에 CORS 미들웨어 자동 추가.
    
    Returns:
        (수정된 코드, 수정 여부)
    """
    # 이미 CORS가 있으면 스킵
    if 'CORSMiddleware' in content:
        return content, False
    
    # FastAPI 앱이 없으면 스킵
    if 'FastAPI()' not in content and 'FastAPI(' not in content:
        return content, False
    
    modified = content
    
    # 1. Import 추가
    if CORS_IMPORT not in modified:
        # FastAPI import 찾아서 그 다음 줄에 추가
        if 'from fastapi import' in modified:
            modified = re.sub(
                r'(from fastapi import[^\n]+)',
                f'\\1\n{CORS_IMPORT}',
                modified,
                count=1
            )
        elif 'import fastapi' in modified:
            modified = re.sub(
                r'(import fastapi[^\n]*)',
                f'\\1\n{CORS_IMPORT}',
                modified,
                count=1
            )
        else:
            # 파일 시작에 추가
            modified = f'{CORS_IMPORT}\n\n{modified}'
    
    # 2. Middleware 추가 (app = FastAPI() 다음에)
    # app = FastAPI(...) 패턴 찾기
    app_pattern = r'(app\s*=\s*FastAPI\s*\([^)]*\))'
    match = re.search(app_pattern, modified)
    
    if match:
        insert_pos = match.end()
        modified = modified[:insert_pos] + CORS_MIDDLEWARE_SNIPPET + modified[insert_pos:]
        logger.info("Added CORS middleware to FastAPI app")
        return modified, True
    
    return content, False


# ============================================================================
# 4. UVICORN ENTRYPOINT 자동 추가
# ============================================================================

UVICORN_ENTRYPOINT = '''
if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
'''

def fix_missing_uvicorn_entrypoint(content: str, filename: str = "main.py") -> Tuple[str, bool]:
    """
    main.py 파일에 uvicorn entrypoint 자동 추가.
    
    Returns:
        (수정된 코드, 수정 여부)
    """
    # main.py가 아니면 스킵
    if not filename.endswith('main.py'):
        return content, False
    
    # 이미 entrypoint가 있으면 스킵
    if 'if __name__' in content:
        return content, False
    
    # FastAPI 앱이 있는지 확인
    if 'app' not in content or ('FastAPI' not in content and 'fastapi' not in content.lower()):
        return content, False
    
    # 파일 끝에 entrypoint 추가
    modified = content.rstrip() + '\n' + UVICORN_ENTRYPOINT
    logger.info("Added uvicorn entrypoint to %s", filename)
    
    return modified, True


# ============================================================================
# 5. 통합 함수: 모든 수정 적용
# ============================================================================

def apply_backend_fixes(files: Dict[str, str], project_dir: str) -> Dict[str, str]:
    """
    백엔드 파일들에 모든 자동 수정 적용.
    
    Args:
        files: {파일명: 내용}
        project_dir: 프로젝트 디렉토리
    
    Returns:
        수정된 {파일명: 내용}
    """
    fixed_files = {}
    total_fixes = 0
    
    for filename, content in files.items():
        fixed_content = content
        fixes_applied = []
        
        # Python 파일만 처리
        if not filename.endswith('.py'):
            fixed_files[filename] = content
            continue
        
        # 1. Pydantic v1 → v2 변환
        if 'pydantic' in content.lower() or '@validator' in content or '@root_validator' in content:
            fixed_content, pydantic_changes = fix_pydantic_v1_to_v2(fixed_content)
            fixes_applied.extend(pydantic_changes)
        
        # 2. CORS 미들웨어 추가 (main.py 또는 app이 있는 파일)
        if 'main' in filename.lower() or 'app' in filename.lower():
            fixed_content, cors_fixed = fix_missing_cors(fixed_content)
            if cors_fixed:
                fixes_applied.append("CORS middleware 추가")
        
        # 3. Uvicorn entrypoint 추가
        fixed_content, uvicorn_fixed = fix_missing_uvicorn_entrypoint(fixed_content, filename)
        if uvicorn_fixed:
            fixes_applied.append("uvicorn entrypoint 추가")
        
        if fixes_applied:
            logger.info("Auto-fixes for %s: %s", filename, ", ".join(fixes_applied))
            total_fixes += len(fixes_applied)
        
        fixed_files[filename] = fixed_content
    
    # 4. 빈 __init__.py 수정 (저장 후 처리)
    # 이 부분은 save_parsed_files에서 별도 처리
    
    if total_fixes > 0:
        logger.info("Total auto-fixes applied: %d", total_fixes)
    
    return fixed_files


def fix_init_files_in_directory(directory: str) -> int:
    """
    디렉토리 내 모든 빈 __init__.py 파일 수정.
    
    Returns:
        수정된 파일 수
    """
    fixed_count = 0
    
    for root, dirs, files in os.walk(directory):
        # 제외할 디렉토리
        dirs[:] = [d for d in dirs if d not in {'node_modules', '__pycache__', '.git', 'venv', '.venv'}]
        
        if '__init__.py' in files:
            filepath = os.path.join(root, '__init__.py')
            if fix_empty_init_py(filepath):
                fixed_count += 1
    
    if fixed_count > 0:
        logger.info("Fixed %d empty __init__.py files in %s", fixed_count, directory)
    
    return fixed_count

"""
DAACS v6.0 - File Parsing Utilities
CLI 응답에서 파일 추출
"""

import re
import os
from typing import Dict, List, Tuple
from ..utils import setup_logger

logger = setup_logger("FileParser")


def strip_markdown_fences(content: str, file_extension: str = "") -> str:
    """
    파일 내용에서 마크다운 코드 펜스 제거
    
    LLM(특히 Gemini)이 코드 파일에 ```python, ```json 등의 
    마크다운 펜스를 포함시키는 문제를 해결
    
    Args:
        content: 원본 파일 내용
        file_extension: 파일 확장자 (예: '.py', '.json')
        
    Returns:
        마크다운 펜스가 제거된 내용
    """
    if not content:
        return content
    
    lines = content.strip().split('\n')
    
    # 첫 번째 줄이 마크다운 펜스인지 확인
    # 패턴: ```python, ```json, ```typescript, ``` 등
    fence_pattern = r'^```\w*\s*$'
    
    if lines and re.match(fence_pattern, lines[0].strip()):
        # 마지막 줄이 닫는 펜스인지 확인
        if len(lines) > 1 and lines[-1].strip() == '```':
            # 첫 줄과 마지막 줄 제거
            lines = lines[1:-1]
            logger.info(f"Stripped markdown fences from file content")
        elif len(lines) > 1:
            # 첫 줄만 펜스인 경우 (닫는 펜스 없음)
            lines = lines[1:]
            logger.warning(f"Stripped opening fence but no closing fence found")
    
    # 내용 중간에 펜스가 있는 경우도 처리 (시작 펜스만 제거)
    result = '\n'.join(lines)
    
    # 추가 정리: 파일 시작/끝의 빈 줄 정리
    return result.strip()

def parse_files_from_response(response: str) -> Dict[str, str]:
    """
    CLI 응답에서 파일 내용 추출
    
    지원 패턴:
    1. FILE: path/to/file.py
       ```python
       content
       ```
    
    2. === path/to/file.py ===
       content
       === END ===
    
    3. 마크다운 코드블록 (파일명 추론)
    
    Returns:
        Dict[파일명, 내용]
    """
    files = {}
    
    # 패턴 0: --- path/to/file.ext ---
    pattern0 = r'---\s*([^\n]+?\.\w+)\s*---\n([\s\S]*?)(?=^---\s*[^\n]+?\.\w+\s*---|\Z)'
    for match in re.finditer(pattern0, response, flags=re.MULTILINE):
        filename = match.group(1).strip()
        content = match.group(2).strip()
        files[filename] = content

    # 패턴 1: FILE: path/to/file.ext
    pattern1 = r'FILE:\s*([^\n]+)\s*\n\s*```(?:\w+)?\n([\s\S]*?)```'
    for match in re.finditer(pattern1, response):
        filename = match.group(1).strip()
        content = match.group(2).strip()
        files[filename] = content
    
    # 패턴 2: === filename ===
    pattern2 = r'===\s*([^\n=]+)\s*===\n([\s\S]*?)=== END ==='
    for match in re.finditer(pattern2, response):
        filename = match.group(1).strip()
        content = match.group(2).strip()
        files[filename] = content
    
    # 패턴 3: ```python:filename.py 형식
    pattern3 = r'```(\w+):([^\n]+)\n([\s\S]*?)```'
    for match in re.finditer(pattern3, response):
        filename = match.group(2).strip()
        content = match.group(3).strip()
        files[filename] = content
    
    # 패턴 4: # filename.py 헤더 + 코드블록
    pattern4 = r'#+\s+(\S+\.\w+)\s*\n+```(?:\w+)?\n([\s\S]*?)```'
    for match in re.finditer(pattern4, response):
        filename = match.group(1).strip()
        content = match.group(2).strip()
        if filename not in files:  # 중복 방지
            files[filename] = content
    
    # 패턴 5: **filename.py** 볼드 헤더 + 코드블록
    pattern5 = r'\*\*(\S+\.\w+)\*\*\s*\n+```(?:\w+)?\n([\s\S]*?)```'
    for match in re.finditer(pattern5, response):
        filename = match.group(1).strip()
        content = match.group(2).strip()
        if filename not in files:
            files[filename] = content
    
    # 패턴 6: `filename.py` 백틱 헤더 + 코드블록
    pattern6 = r'`(\S+\.\w+)`\s*[:\n]+```(?:\w+)?\n([\s\S]*?)```'
    for match in re.finditer(pattern6, response):
        filename = match.group(1).strip()
        content = match.group(2).strip()
        if filename not in files:
            files[filename] = content
    
    # 패턴 7: // filepath 주석 형식 (C/JS 스타일)
    pattern7 = r'//\s*(\S+\.\w+)\s*\n([\s\S]*?)(?=\n//\s*\S+\.\w+|\Z)'
    for match in re.finditer(pattern7, response):
        filename = match.group(1).strip()
        content = match.group(2).strip()
        # 코드블록 안에 있는 경우 펜스 제거
        content = strip_markdown_fences(content, os.path.splitext(filename)[1])
        if filename not in files and len(content) > 10:  # 최소 길이 확인
            files[filename] = content
    
    # 패턴 8: FILE: 없이 바로 파일명: 형식 (예: "main.py:")
    pattern8 = r'^(\w[\w/\-\.]+\.\w+):\s*$\n```(?:\w+)?\n([\s\S]*?)```'
    for match in re.finditer(pattern8, response, flags=re.MULTILINE):
        filename = match.group(1).strip()
        content = match.group(2).strip()
        if filename not in files:
            files[filename] = content
    
    # 패턴 9: Path: path/to/file 형식
    pattern9 = r'(?:Path|File|Filename):\s*([^\n]+\.\w+)\s*\n```(?:\w+)?\n([\s\S]*?)```'
    for match in re.finditer(pattern9, response, flags=re.IGNORECASE):
        filename = match.group(1).strip()
        content = match.group(2).strip()
        if filename not in files:
            files[filename] = content
    
    # 🆕 로깅: 파싱 결과 상세 정보
    if files:
        logger.info(f"Parsed {len(files)} files: {list(files.keys())}")
    else:
        # 디버깅용: 응답 시작 부분 로깅
        preview = response[:300].replace('\n', '\\n') if response else "(empty)"
        logger.warning(f"No files parsed. Response preview: {preview}...")
    
    return files


def save_parsed_files(files: Dict[str, str], base_dir: str) -> List[str]:
    """
    파싱된 파일들을 디스크에 저장
    
    Args:
        files: {파일명: 내용}
        base_dir: 저장할 기본 디렉토리
        
    Returns:
        저장된 파일 경로 목록
        
    Security:
        - 절대 경로는 상대 경로(파일명만)로 변환
        - base_dir 외부에 파일을 쓰려는 시도 차단
    """
    saved = []
    abs_base = os.path.abspath(base_dir)
    
    for filename, content in files.items():
        # 보안: 절대경로는 파일명만 추출하여 상대경로로 변환
        if os.path.isabs(filename):
            original = filename
            filename = os.path.basename(filename)
            logger.warning(f"Converted absolute path '{original}' to relative '{filename}'")
        
        # 🆕 마크다운 펜스 자동 제거 (Gemini LLM 출력 문제 해결)
        file_ext = os.path.splitext(filename)[1]
        content = strip_markdown_fences(content, file_ext)
        
        if os.path.basename(filename) == "__init__.py" and not content.strip():
            content = '"""Package initialization."""\n'
            logger.info(f"Auto-filled empty __init__.py: {filename}")

        # 경로 조합
        filepath = os.path.join(base_dir, filename)
        abs_filepath = os.path.abspath(filepath)
        
        # 보안: base_dir 외부 쓰기 차단 (path traversal 방지)
        if not abs_filepath.startswith(abs_base + os.sep) and abs_filepath != abs_base:
            logger.error(f"Path traversal blocked - '{filename}' resolves outside base_dir")
            continue

        # 보안: Critical Platform Code 보호 (재발 방지)
        # Use the project root (parent of base_dir typically) for protection
        # If base_dir is workspace/1, we protect paths relative to repo root
        project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # daacs/../ = repo root
        protected_paths = [
            os.path.join(project_root, "frontend", "client", "src"),
            os.path.join(project_root, "frontend", "client", "public"),
            os.path.join(project_root, "frontend", "client", "vite.config.ts"),
            os.path.join(project_root, "daacs"),  # 백엔드 코어도 보호
        ]
        
        is_protected = False
        for protected in protected_paths:
            if os.path.exists(protected) and abs_filepath.startswith(os.path.abspath(protected)):
                is_protected = True
                break
        
        if is_protected:
             logger.error(f"Write to PROTECTED platform path blocked - '{filepath}'")
             continue
        
        # 디렉토리 생성
        os.makedirs(os.path.dirname(filepath) if os.path.dirname(filepath) else base_dir, exist_ok=True)
        
        try:
            with open(filepath, 'w', encoding='utf-8') as f:
                f.write(content)
            saved.append(filepath)
            logger.info(f"Saved: {filepath}")
        except Exception as e:
            logger.error(f"Failed to save {filepath}: {e}")
    
    return saved


def extract_code_blocks(response: str) -> List[Tuple[str, str]]:
    """
    응답에서 모든 코드블록 추출 (언어, 내용)
    """
    pattern = r'```(\w*)\n([\s\S]*?)```'
    blocks = []
    
    for match in re.finditer(pattern, response):
        language = match.group(1) or "text"
        content = match.group(2).strip()
        blocks.append((language, content))
    
    return blocks


# 사용 예시
if __name__ == "__main__":
    sample_response = '''
Here's the implementation:

FILE: main.py
```python
from fastapi import FastAPI

app = FastAPI()

@app.get("/health")
def health():
    return {"status": "ok"}
```

FILE: requirements.txt
```
fastapi
uvicorn
```
'''
    
    files = parse_files_from_response(sample_response)
    logger.info("Parsed %s files:", len(files))
    for name, content in files.items():
        logger.info("  - %s: %s chars", name, len(content))

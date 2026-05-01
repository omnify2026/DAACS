import os
import py_compile
from typing import Dict, List, Any

from ...utils import setup_logger

logger = setup_logger("Verifier.SyntaxChecks")

def python_syntax_valid(files: List[str]) -> Dict[str, Any]:
    """Python 구문 검사 (py_compile)"""
    syntax_errors = []
    for file in files:
        if file.endswith('.py') and os.path.exists(file):
            try:
                py_compile.compile(file, doraise=True)
            except py_compile.PyCompileError as e:
                syntax_errors.append(f"{file}: {str(e)}")
            except Exception as e:
                syntax_errors.append(f"{file}: {str(e)}")
    
    return {
        "ok": len(syntax_errors) == 0,
        "reason": f"Python syntax errors: {syntax_errors}" if syntax_errors else "All Python files have valid syntax",
        "template": "python_syntax_valid",
        "details": "\n".join(syntax_errors[:5]) if syntax_errors else ""
    }

def javascript_syntax_valid(files: List[str]) -> Dict[str, Any]:
    """JavaScript 기본 구문 검사 (괄호/중괄호 매칭)"""
    syntax_errors = []
    
    for file in files:
        if (file.endswith('.js') or file.endswith('.jsx') or file.endswith('.ts') or file.endswith('.tsx')) and os.path.exists(file):
            try:
                with open(file, 'r', encoding='utf-8', errors='ignore') as f:
                    content = f.read()
                
                # 기본 괄호 매칭 검사
                brackets = {'(': ')', '{': '}', '[': ']'}
                stack = []
                in_string = False
                string_char = None
                
                for i, char in enumerate(content):
                    # 문자열 내부 스킵
                    if char in ('"', "'", '`') and (i == 0 or content[i-1] != '\\'):
                        if not in_string:
                            in_string = True
                            string_char = char
                        elif char == string_char:
                            in_string = False
                        continue
                    
                    if in_string: continue
                    
                    if char in brackets:
                        stack.append(char)
                    elif char in brackets.values():
                        if not stack:
                            syntax_errors.append(f"{file}: Unmatched closing bracket '{char}'")
                            break
                        if brackets[stack.pop()] != char:
                            syntax_errors.append(f"{file}: Mismatched brackets")
                            break
                
                if stack and file not in [e.split(':')[0] for e in syntax_errors]:
                    syntax_errors.append(f"{file}: Unclosed brackets: {stack}")
                    
            except Exception as e:
                syntax_errors.append(f"{file}: {str(e)}")

    return {
        "ok": len(syntax_errors) == 0,
        "reason": f"JavaScript syntax errors found in {len(syntax_errors)} files" if syntax_errors else "Basic JS syntax check passed",
        "template": "javascript_syntax_valid",
        "details": "\n".join(syntax_errors[:5]) if syntax_errors else ""
    }

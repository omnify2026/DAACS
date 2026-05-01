"""
DAACS - Python File Analyzer
Extracted from project_analysis.py for modularity.
"""
import ast
import os
from typing import List, Optional
from .models import FunctionInfo, ClassInfo, ImportInfo


def analyze_python_file(filepath: str) -> dict:
    """
    Analyze a Python file and return its structure.
    
    Returns:
        dict with 'functions', 'classes', 'imports', 'total_lines'
    """
    result = {
        'functions': [],
        'classes': [],
        'imports': [],
        'total_lines': 0
    }
    
    try:
        with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
            content = f.read()
        
        result['total_lines'] = len(content.splitlines())
        tree = ast.parse(content)
        rel_path = os.path.basename(filepath)
        
        for node in ast.walk(tree):
            # Function analysis
            if isinstance(node, ast.FunctionDef):
                result['functions'].append(FunctionInfo(
                    name=node.name,
                    file=rel_path,
                    line_start=node.lineno,
                    line_end=node.end_lineno or node.lineno,
                    params=[arg.arg for arg in node.args.args],
                    complexity=_calculate_complexity(node),
                    lines_of_code=(node.end_lineno or node.lineno) - node.lineno + 1,
                    docstring=ast.get_docstring(node),
                    decorators=[_get_decorator_name(d) for d in node.decorator_list]
                ))
            
            # Class analysis
            elif isinstance(node, ast.ClassDef):
                methods = [n.name for n in node.body if isinstance(n, ast.FunctionDef)]
                result['classes'].append(ClassInfo(
                    name=node.name,
                    file=rel_path,
                    line_start=node.lineno,
                    line_end=node.end_lineno or node.lineno,
                    methods=methods,
                    base_classes=[_get_base_name(b) for b in node.bases],
                    lines_of_code=(node.end_lineno or node.lineno) - node.lineno + 1,
                    docstring=ast.get_docstring(node)
                ))
            
            # Import analysis
            elif isinstance(node, ast.Import):
                for alias in node.names:
                    result['imports'].append(ImportInfo(
                        module=alias.name,
                        names=[alias.asname or alias.name],
                        file=rel_path,
                        line=node.lineno
                    ))
            
            elif isinstance(node, ast.ImportFrom):
                result['imports'].append(ImportInfo(
                    module=node.module or '',
                    names=[a.name for a in node.names],
                    file=rel_path,
                    line=node.lineno,
                    is_relative=node.level > 0
                ))
    
    except SyntaxError:
        pass
    except OSError:
        pass
    
    return result


def _calculate_complexity(node: ast.AST) -> int:
    """Calculate cyclomatic complexity for a node."""
    complexity = 1
    for child in ast.walk(node):
        if isinstance(child, (ast.If, ast.While, ast.For, ast.ExceptHandler,
                            ast.With, ast.Assert, ast.comprehension)):
            complexity += 1
        elif isinstance(child, ast.BoolOp):
            complexity += len(child.values) - 1
    return complexity


def _get_decorator_name(decorator: ast.expr) -> str:
    """Extract decorator name."""
    if isinstance(decorator, ast.Name):
        return decorator.id
    elif isinstance(decorator, ast.Call):
        return _get_decorator_name(decorator.func)
    elif isinstance(decorator, ast.Attribute):
        return decorator.attr
    return str(decorator)


def _get_base_name(base: ast.expr) -> str:
    """Extract base class name."""
    if isinstance(base, ast.Name):
        return base.id
    elif isinstance(base, ast.Attribute):
        return f"{_get_base_name(base.value)}.{base.attr}"
    return str(base)

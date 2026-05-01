"""
DAACS Project Analysis - Phase 8.1 프로젝트 분석 API
기존 프로젝트의 심층 분석 및 개선점 제안

기능:
1. AST 기반 구조 분석 (Python/JavaScript)
2. 코드 복잡도/중복도 메트릭
3. 의존성 분석 및 업데이트 제안
4. 개선점 자동 제안
5. 패치 기반 점진적 수정
"""

import os
import re
import ast
import json
import hashlib
from typing import Dict, Any, List, Optional, Tuple
from dataclasses import dataclass, field, asdict
from pathlib import Path
from collections import defaultdict
from .utils import setup_logger

logger = setup_logger("ProjectAnalysis")


@dataclass
class FunctionInfo:
    """함수/메서드 정보"""
    name: str
    file: str
    line_start: int
    line_end: int
    params: List[str]
    complexity: int  # Cyclomatic complexity
    lines_of_code: int
    docstring: Optional[str] = None
    decorators: List[str] = field(default_factory=list)


@dataclass
class ClassInfo:
    """클래스 정보"""
    name: str
    file: str
    line_start: int
    line_end: int
    methods: List[str]
    base_classes: List[str]
    lines_of_code: int
    docstring: Optional[str] = None


@dataclass
class ImportInfo:
    """Import 정보"""
    module: str
    names: List[str]
    file: str
    line: int
    is_relative: bool = False


@dataclass
class DependencyInfo:
    """의존성 정보"""
    name: str
    version: str
    current_version: Optional[str] = None
    latest_version: Optional[str] = None
    is_outdated: bool = False
    is_dev: bool = False


@dataclass
class CodeIssue:
    """코드 이슈"""
    category: str  # complexity, duplication, security, style, performance
    severity: str  # critical, warning, info
    file: str
    line: Optional[int]
    description: str
    suggestion: str


@dataclass
class ProjectAnalysis:
    """프로젝트 분석 결과"""
    project_type: str  # python, node, hybrid
    total_files: int = 0
    total_lines: int = 0
    
    # 구조
    functions: List[FunctionInfo] = field(default_factory=list)
    classes: List[ClassInfo] = field(default_factory=list)
    imports: List[ImportInfo] = field(default_factory=list)
    
    # 메트릭
    metrics: Dict[str, Any] = field(default_factory=dict)
    
    # 의존성
    dependencies: List[DependencyInfo] = field(default_factory=list)
    
    # 이슈
    issues: List[CodeIssue] = field(default_factory=list)
    
    # 요약
    summary: str = ""
    entry_points: List[str] = field(default_factory=list)
    tech_stack: Dict[str, Any] = field(default_factory=dict)


class ProjectAnalyzer:
    """
    프로젝트 분석기
    
    기능:
    - 코드 구조 분석
    - 복잡도 계산
    - 중복 감지
    - 이슈 탐지
    """
    
    IGNORED_DIRS = {
        'node_modules', '.git', '__pycache__', 'venv', '.venv',
        'env', 'dist', 'build', '.next', '.cache', '.pytest_cache'
    }
    
    def __init__(self, project_dir: str):
        self.project_dir = project_dir
        self.analysis = ProjectAnalysis(project_type="unknown")
    
    def analyze(self) -> ProjectAnalysis:
        """전체 분석 실행"""
        # 프로젝트 타입 감지
        self.analysis.project_type = self._detect_project_type()
        
        # 파일 수집
        files = self._collect_files()
        self.analysis.total_files = len(files)
        
        # Python 분석
        py_files = [f for f in files if f.endswith('.py')]
        for f in py_files:
            self._analyze_python_file(f)
        
        # JavaScript/TypeScript 분석
        js_files = [f for f in files if f.endswith(('.js', '.jsx', '.ts', '.tsx'))]
        for f in js_files:
            self._analyze_js_file(f)
        
        # 의존성 분석
        self._analyze_dependencies()
        
        # 메트릭 계산
        self._calculate_metrics()
        
        # 이슈 탐지
        self._detect_issues()
        
        # 진입점 탐지
        self.analysis.entry_points = self._detect_entry_points()
        
        # 요약 생성
        self.analysis.summary = self._generate_summary()
        
        return self.analysis
    
    def _detect_project_type(self) -> str:
        """프로젝트 타입 감지"""
        has_python = os.path.exists(os.path.join(self.project_dir, "requirements.txt")) or \
                     os.path.exists(os.path.join(self.project_dir, "pyproject.toml"))
        has_node = os.path.exists(os.path.join(self.project_dir, "package.json"))
        
        if has_python and has_node:
            return "hybrid"
        elif has_python:
            return "python"
        elif has_node:
            return "node"
        return "unknown"
    
    def _collect_files(self) -> List[str]:
        """분석할 파일 수집"""
        files = []
        
        for root, dirs, filenames in os.walk(self.project_dir):
            dirs[:] = [d for d in dirs if d not in self.IGNORED_DIRS]
            
            for name in filenames:
                if name.endswith(('.py', '.js', '.jsx', '.ts', '.tsx', '.json', '.html', '.css')):
                    files.append(os.path.join(root, name))
        
        return files
    
    def _analyze_python_file(self, filepath: str):
        """Python 파일 분석"""
        try:
            with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
                content = f.read()
            
            self.analysis.total_lines += len(content.split('\n'))
            
            # AST 파싱
            try:
                tree = ast.parse(content)
            except SyntaxError:
                return
            
            rel_path = os.path.relpath(filepath, self.project_dir)
            
            for node in ast.walk(tree):
                # 함수 분석
                if isinstance(node, ast.FunctionDef) or isinstance(node, ast.AsyncFunctionDef):
                    self.analysis.functions.append(FunctionInfo(
                        name=node.name,
                        file=rel_path,
                        line_start=node.lineno,
                        line_end=node.end_lineno or node.lineno,
                        params=[arg.arg for arg in node.args.args],
                        complexity=self._calculate_complexity(node),
                        lines_of_code=(node.end_lineno or node.lineno) - node.lineno + 1,
                        docstring=ast.get_docstring(node),
                        decorators=[self._get_decorator_name(d) for d in node.decorator_list]
                    ))
                
                # 클래스 분석
                elif isinstance(node, ast.ClassDef):
                    methods = [n.name for n in node.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))]
                    self.analysis.classes.append(ClassInfo(
                        name=node.name,
                        file=rel_path,
                        line_start=node.lineno,
                        line_end=node.end_lineno or node.lineno,
                        methods=methods,
                        base_classes=[self._get_base_name(b) for b in node.bases],
                        lines_of_code=(node.end_lineno or node.lineno) - node.lineno + 1,
                        docstring=ast.get_docstring(node)
                    ))
                
                # Import 분석
                elif isinstance(node, ast.Import):
                    for alias in node.names:
                        self.analysis.imports.append(ImportInfo(
                            module=alias.name,
                            names=[alias.asname or alias.name],
                            file=rel_path,
                            line=node.lineno
                        ))
                
                elif isinstance(node, ast.ImportFrom):
                    if node.module:
                        self.analysis.imports.append(ImportInfo(
                            module=node.module,
                            names=[alias.name for alias in node.names],
                            file=rel_path,
                            line=node.lineno,
                            is_relative=node.level > 0
                        ))
                        
        except (OSError, UnicodeDecodeError) as e:
            logger.error(f"Error analyzing {filepath}: {e}")
    
    def _analyze_js_file(self, filepath: str):
        """JavaScript/TypeScript 파일 분석 (정규식 기반 + 복잡도 추정)"""
        try:
            with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
                content = f.read()
            
            lines = content.split('\n')
            self.analysis.total_lines += len(lines)
            rel_path = os.path.relpath(filepath, self.project_dir)
            
            # 함수 감지 (간단한 패턴)
            function_patterns = [
                r'function\s+(\w+)\s*\(([^)]*)\)',  # function name(params)
                r'const\s+(\w+)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>',  # const name = (params) =>
                r'(\w+)\s*:\s*(?:async\s*)?function\s*\(([^)]*)\)',  # name: function(params)
            ]
            
            for pattern in function_patterns:
                for match in re.finditer(pattern, content):
                    name = match.group(1)
                    params = [p.strip() for p in match.group(2).split(',') if p.strip()]
                    start_pos = match.start()
                    line_start = content[:start_pos].count('\n') + 1
                    
                    # Estimate function end and lines of code
                    func_body = self._extract_js_function_body(content, match.end())
                    line_end = line_start + func_body.count('\n')
                    loc = max(1, line_end - line_start)
                    
                    # Estimate complexity from function body
                    complexity = self._estimate_js_complexity(func_body)
                    
                    self.analysis.functions.append(FunctionInfo(
                        name=name,
                        file=rel_path,
                        line_start=line_start,
                        line_end=line_end,
                        params=params,
                        complexity=complexity,
                        lines_of_code=loc
                    ))
            
            # 클래스 감지
            class_pattern = r'class\s+(\w+)(?:\s+extends\s+(\w+))?'
            for match in re.finditer(class_pattern, content):
                name = match.group(1)
                base = match.group(2)
                start_pos = match.start()
                line_start = content[:start_pos].count('\n') + 1
                
                # Estimate class end
                class_body = self._extract_js_function_body(content, match.end())
                line_end = line_start + class_body.count('\n')
                loc = max(1, line_end - line_start)
                
                self.analysis.classes.append(ClassInfo(
                    name=name,
                    file=rel_path,
                    line_start=line_start,
                    line_end=line_end,
                    methods=[],
                    base_classes=[base] if base else [],
                    lines_of_code=loc
                ))
            
            # Import 감지
            import_patterns = [
                r"import\s+\{([^}]+)\}\s+from\s+['\"]([^'\"]+)['\"]",  # import { x } from 'y'
                r"import\s+(\w+)\s+from\s+['\"]([^'\"]+)['\"]",  # import x from 'y'
                r"const\s+(\w+)\s*=\s*require\(['\"]([^'\"]+)['\"]\)",  # const x = require('y')
            ]
            
            for pattern in import_patterns:
                for match in re.finditer(pattern, content):
                    names = match.group(1).split(',') if ',' in match.group(1) else [match.group(1)]
                    names = [n.strip() for n in names]
                    module = match.group(2)
                    line_num = content[:match.start()].count('\n') + 1
                    
                    self.analysis.imports.append(ImportInfo(
                        module=module,
                        names=names,
                        file=rel_path,
                        line=line_num,
                        is_relative=module.startswith('.')
                    ))
                    
        except (OSError, UnicodeDecodeError) as e:
            logger.error(f"Error analyzing {filepath}: {e}")
    
    def _extract_js_function_body(self, content: str, start_idx: int) -> str:
        """Extract JS function/class body by counting braces."""
        # Find opening brace
        brace_start = content.find('{', start_idx)
        if brace_start == -1:
            return ""
        
        depth = 1
        idx = brace_start + 1
        while idx < len(content) and depth > 0:
            if content[idx] == '{':
                depth += 1
            elif content[idx] == '}':
                depth -= 1
            idx += 1
        
        return content[brace_start:idx]
    
    def _estimate_js_complexity(self, code: str) -> int:
        """Estimate cyclomatic complexity for JS code."""
        complexity = 1
        # Count decision points
        patterns = [
            r'\bif\s*\(',
            r'\belse\s+if\s*\(',
            r'\bfor\s*\(',
            r'\bwhile\s*\(',
            r'\bswitch\s*\(',
            r'\bcase\s+',
            r'\bcatch\s*\(',
            r'\?\s*',  # ternary
            r'\b&&\b',
            r'\b\|\|\b',
        ]
        for pattern in patterns:
            complexity += len(re.findall(pattern, code))
        return complexity
    
    def _calculate_complexity(self, node: ast.AST) -> int:
        """Cyclomatic complexity 계산"""
        complexity = 1
        
        for child in ast.walk(node):
            if isinstance(child, (ast.If, ast.While, ast.For, ast.ExceptHandler)):
                complexity += 1
            elif isinstance(child, ast.BoolOp):
                complexity += len(child.values) - 1
        
        return complexity
    
    def _get_decorator_name(self, decorator: ast.expr) -> str:
        """데코레이터 이름 추출"""
        if isinstance(decorator, ast.Name):
            return decorator.id
        elif isinstance(decorator, ast.Attribute):
            return f"{self._get_decorator_name(decorator.value)}.{decorator.attr}"
        elif isinstance(decorator, ast.Call):
            return self._get_decorator_name(decorator.func)
        return str(decorator)
    
    def _get_base_name(self, base: ast.expr) -> str:
        """기본 클래스 이름 추출"""
        if isinstance(base, ast.Name):
            return base.id
        elif isinstance(base, ast.Attribute):
            return f"{self._get_base_name(base.value)}.{base.attr}"
        return str(base)
    
    def _analyze_dependencies(self):
        """의존성 분석"""
        # Python dependencies
        requirements_txt = os.path.join(self.project_dir, "requirements.txt")
        if os.path.exists(requirements_txt):
            try:
                with open(requirements_txt, 'r', encoding='utf-8') as f:
                    for line in f:
                        line = line.strip()
                        if line and not line.startswith('#'):
                            # package==version or package\u003e=version
                            match = re.match(r'^([a-zA-Z0-9_-]+)(?:[=\u003e\u003c!~]+([0-9.]+))?', line)
                            if match:
                                self.analysis.dependencies.append(DependencyInfo(
                                    name=match.group(1),
                                    version=match.group(2) or "latest"
                                ))
            except (OSError, UnicodeDecodeError):
                logger.debug("Failed to parse requirements.txt", exc_info=True)
        
        # Node dependencies
        package_json = os.path.join(self.project_dir, "package.json")
        if os.path.exists(package_json):
            try:
                with open(package_json, 'r', encoding='utf-8') as f:
                    pkg = json.load(f)
                
                for name, version in pkg.get("dependencies", {}).items():
                    self.analysis.dependencies.append(DependencyInfo(
                        name=name,
                        version=version.lstrip('^~'),
                        is_dev=False
                    ))
                
                for name, version in pkg.get("devDependencies", {}).items():
                    self.analysis.dependencies.append(DependencyInfo(
                        name=name,
                        version=version.lstrip('^~'),
                        is_dev=True
                    ))
            except (json.JSONDecodeError, OSError):
                logger.debug("Failed to parse package.json dependencies", exc_info=True)
    
    def _calculate_metrics(self):
        """메트릭 계산"""
        metrics = {}
        
        # 기본 메트릭
        metrics["total_functions"] = len(self.analysis.functions)
        metrics["total_classes"] = len(self.analysis.classes)
        metrics["total_imports"] = len(self.analysis.imports)
        metrics["total_dependencies"] = len(self.analysis.dependencies)
        
        # 복잡도 메트릭
        if self.analysis.functions:
            complexities = [f.complexity for f in self.analysis.functions]
            metrics["avg_complexity"] = round(sum(complexities) / len(complexities), 2)
            metrics["max_complexity"] = max(complexities)
            metrics["high_complexity_functions"] = len([c for c in complexities if c > 10])
        
        # 라인 수 메트릭
        metrics["total_lines"] = self.analysis.total_lines
        metrics["avg_lines_per_file"] = round(self.analysis.total_lines / max(self.analysis.total_files, 1), 2)
        
        # 중복 탐지 (간단한 해시 기반)
        metrics["duplicate_functions"] = self._detect_duplicates()
        
        self.analysis.metrics = metrics
    
    def _detect_duplicates(self) -> int:
        """중복 함수 감지 (간단한 이름 기반)"""
        function_names = [f.name for f in self.analysis.functions]
        duplicates = len(function_names) - len(set(function_names))
        return duplicates
    
    def _detect_issues(self):
        """코드 이슈 탐지"""
        issues = []
        
        # 1. 복잡도가 높은 함수
        for f in self.analysis.functions:
            if f.complexity > 15:
                issues.append(CodeIssue(
                    category="complexity",
                    severity="critical",
                    file=f.file,
                    line=f.line_start,
                    description=f"Function '{f.name}' has high complexity ({f.complexity})",
                    suggestion="Consider breaking down into smaller functions"
                ))
            elif f.complexity > 10:
                issues.append(CodeIssue(
                    category="complexity",
                    severity="warning",
                    file=f.file,
                    line=f.line_start,
                    description=f"Function '{f.name}' has moderate complexity ({f.complexity})",
                    suggestion="Consider simplifying the logic"
                ))
        
        # 2. 긴 함수
        for f in self.analysis.functions:
            if f.lines_of_code > 100:
                issues.append(CodeIssue(
                    category="style",
                    severity="warning",
                    file=f.file,
                    line=f.line_start,
                    description=f"Function '{f.name}' is too long ({f.lines_of_code} lines)",
                    suggestion="Break down into smaller functions"
                ))
        
        # 3. 문서화 누락
        for f in self.analysis.functions:
            if f.name.startswith('_'):
                continue  # private 함수는 스킵
            if not f.docstring and f.lines_of_code > 10:
                issues.append(CodeIssue(
                    category="style",
                    severity="info",
                    file=f.file,
                    line=f.line_start,
                    description=f"Function '{f.name}' lacks documentation",
                    suggestion="Add docstring explaining purpose and parameters"
                ))
        
        # 4. 미사용 import 감지 (간단한 휴리스틱)
        # 실제로는 더 정교한 분석 필요
        
        self.analysis.issues = issues
    
    def _detect_entry_points(self) -> List[str]:
        """진입점 탐지"""
        entry_points = []
        
        candidates = [
            "main.py", "app.py", "server.py", "index.py", "run.py",
            "src/main.py", "src/app.py", "src/index.py",
            "src/main.tsx", "src/index.tsx", "src/App.tsx",
            "index.html", "public/index.html"
        ]
        
        for candidate in candidates:
            path = os.path.join(self.project_dir, candidate)
            if os.path.exists(path):
                entry_points.append(candidate)
        
        # Python에서 if __name__ == "__main__" 패턴 찾기
        for f in self.analysis.functions:
            if f.name == "main":
                if f.file not in entry_points:
                    entry_points.append(f.file)
        
        return entry_points
    
    def _generate_summary(self) -> str:
        """분석 요약 생성"""
        parts = []
        
        parts.append(f"Project Type: {self.analysis.project_type}")
        parts.append(f"Total Files: {self.analysis.total_files}")
        parts.append(f"Total Lines: {self.analysis.total_lines}")
        parts.append(f"Functions: {len(self.analysis.functions)}")
        parts.append(f"Classes: {len(self.analysis.classes)}")
        parts.append(f"Dependencies: {len(self.analysis.dependencies)}")
        
        if self.analysis.issues:
            critical = len([i for i in self.analysis.issues if i.severity == "critical"])
            warnings = len([i for i in self.analysis.issues if i.severity == "warning"])
            parts.append(f"Issues: {critical} critical, {warnings} warnings")
        
        return " | ".join(parts)
    
    def suggest_improvements(self) -> List[Dict[str, Any]]:
        """개선점 제안"""
        suggestions = []
        
        # 1. 복잡도 기반 제안
        high_complexity = [f for f in self.analysis.functions if f.complexity > 10]
        if high_complexity:
            suggestions.append({
                "category": "refactoring",
                "priority": "high",
                "title": "Reduce Function Complexity",
                "description": f"{len(high_complexity)} functions have high cyclomatic complexity",
                "affected_files": list(set(f.file for f in high_complexity)),
                "action": "Break down complex functions into smaller, focused units"
            })
        
        # 2. 테스트 커버리지
        has_tests = any(f.file.startswith("test") or "test_" in f.file for f in self.analysis.functions)
        if not has_tests:
            suggestions.append({
                "category": "testing",
                "priority": "high",
                "title": "Add Unit Tests",
                "description": "No test files detected in the project",
                "action": "Create tests/ directory and add unit tests"
            })
        
        # 3. 문서화
        undocumented = [f for f in self.analysis.functions if not f.docstring and not f.name.startswith('_')]
        if len(undocumented) > 5:
            suggestions.append({
                "category": "documentation",
                "priority": "medium",
                "title": "Improve Documentation",
                "description": f"{len(undocumented)} public functions lack documentation",
                "action": "Add docstrings to public functions"
            })
        
        # 4. 의존성 정리
        dev_deps = [d for d in self.analysis.dependencies if d.is_dev]
        if len(self.analysis.dependencies) > 50:
            suggestions.append({
                "category": "dependencies",
                "priority": "medium",
                "title": "Review Dependencies",
                "description": f"Project has {len(self.analysis.dependencies)} dependencies",
                "action": "Review and remove unused dependencies"
            })
        
        # 5. 코드 구조
        if not self.analysis.entry_points:
            suggestions.append({
                "category": "structure",
                "priority": "medium",
                "title": "Define Entry Points",
                "description": "No clear entry point detected",
                "action": "Create main.py or app.py with if __name__ == '__main__' block"
            })
        
        return suggestions
    
    def to_dict(self) -> Dict[str, Any]:
        """분석 결과를 딕셔너리로 변환"""
        return {
            "project_type": self.analysis.project_type,
            "total_files": self.analysis.total_files,
            "total_lines": self.analysis.total_lines,
            "summary": self.analysis.summary,
            "entry_points": self.analysis.entry_points,
            "metrics": self.analysis.metrics,
            "functions": [asdict(f) for f in self.analysis.functions[:50]],  # 최대 50개
            "classes": [asdict(c) for c in self.analysis.classes[:50]],
            "imports": [asdict(i) for i in self.analysis.imports[:100]],
            "dependencies": [asdict(d) for d in self.analysis.dependencies],
            "issues": [asdict(i) for i in self.analysis.issues],
            "tech_stack": self.analysis.tech_stack
        }


# ==================== Patch Generation ====================

@dataclass
class CodePatch:
    """코드 패치"""
    file: str
    line_start: int
    line_end: int
    original: str
    replacement: str
    description: str


def generate_patch(
    file_path: str,
    line_start: int,
    line_end: int,
    replacement: str,
    description: str
) -> CodePatch:
    """코드 패치 생성"""
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            lines = f.readlines()
        
        original = ''.join(lines[line_start-1:line_end])
        
        return CodePatch(
            file=file_path,
            line_start=line_start,
            line_end=line_end,
            original=original,
            replacement=replacement,
            description=description
        )
    except Exception as e:
        return CodePatch(
            file=file_path,
            line_start=line_start,
            line_end=line_end,
            original="",
            replacement=replacement,
            description=f"Error: {e}"
        )


def apply_patch(patch: CodePatch) -> bool:
    """패치 적용"""
    try:
        with open(patch.file, 'r', encoding='utf-8') as f:
            lines = f.readlines()
        
        # 패치 적용
        new_lines = lines[:patch.line_start-1] + [patch.replacement] + lines[patch.line_end:]
        
        with open(patch.file, 'w', encoding='utf-8') as f:
            f.writelines(new_lines)
        
        return True
    except Exception as e:
        logger.error(f"Failed to apply patch: {e}")
        return False

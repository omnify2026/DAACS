"""
DAACS Project Analysis - Data Models
Extracted from project_analysis.py for modularity.
"""
from typing import Dict, Any, List, Optional
from dataclasses import dataclass, field


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


@dataclass
class CodePatch:
    """코드 패치"""
    file: str
    line_start: int
    line_end: int
    original: str
    replacement: str
    description: str

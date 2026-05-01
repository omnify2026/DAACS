"""
DAACS Constraints Generator - Assumptions에서 Non-negotiable Constraints 생성

핵심 원칙:
- Assumptions의 각 선택은 명확한 제약으로 변환됨
- 예: primary_focus="design" → "디자인 품질이 속도보다 우선"

v7.2.0: KK에서 이식 (환경별 제약, performance/testing 옵션, 프롬프트 포맷터 추가)
"""

from typing import List
from .types import Assumptions


def generate_constraints(assumptions: Assumptions) -> List[str]:
    """
    Assumptions에서 Non-negotiable Constraints 생성
    
    이 제약조건들은 LLM이 계획 수립 시 반드시 준수해야 합니다.
    """
    constraints = []
    
    # === Environment 기반 제약 ===
    if assumptions.environment == "web":
        constraints.append("웹 브라우저에서 실행 가능해야 함")
        constraints.append("반응형 디자인 적용 필수")
    elif assumptions.environment == "desktop":
        constraints.append("데스크톱 앱으로 패키징 가능해야 함 (Electron/Tauri)")
    elif assumptions.environment == "mobile":
        constraints.append("모바일 기기에서 네이티브 수준 성능 필요")
        constraints.append("터치 인터페이스 최적화 필수")
    
    # === Primary Focus 기반 제약 ===
    if assumptions.primary_focus == "mvp":
        constraints.append("최소 기능으로 빠른 구현 우선")
        constraints.append("복잡한 아키텍처 지양")
    elif assumptions.primary_focus == "design":
        constraints.append("디자인 품질이 개발 속도보다 우선")
        constraints.append("컴포넌트 구조 설계를 먼저 확립")
        constraints.append("일관된 디자인 시스템 적용 필수")
    elif assumptions.primary_focus == "maintainability":
        constraints.append("코드 가독성과 유지보수성 최우선")
        constraints.append("명확한 폴더 구조와 모듈화 필수")
        constraints.append("주석과 문서화 포함")
    elif assumptions.primary_focus == "performance":
        constraints.append("성능 최적화 필수")
        constraints.append("불필요한 리렌더링 방지")
        constraints.append("번들 크기 최소화")
    elif assumptions.primary_focus == "stability":
        constraints.append("CONSTRAINT: Prioritize error handling and test coverage")
        constraints.append("CONSTRAINT: Add input validation and edge case handling")
    
    # === Options 기반 제약 ===
    options = assumptions.options
    
    if options.get("maintainability"):
        constraints.append("코드 리뷰 통과 가능한 품질 수준 유지")
    
    if options.get("ci_cd"):
        constraints.append("CI/CD 파이프라인 설정 파일 포함")
        constraints.append("자동화된 테스트 스크립트 포함")
    
    if options.get("scalability"):
        constraints.append("수평 확장 가능한 아키텍처 설계")
        constraints.append("상태 관리 외부화 고려")
    
    if options.get("testing"):
        constraints.append("단위 테스트 코드 필수 포함")
        constraints.append("테스트 커버리지 80% 이상 목표")
    
    return constraints


def format_constraints_for_prompt(constraints: List[str]) -> str:
    """제약조건을 프롬프트 형식으로 변환"""
    if not constraints:
        return ""
    
    lines = ["## ⚠️ 필수 제약조건 (Non-negotiable)"]
    lines.append("다음 제약조건들은 반드시 준수해야 합니다:\n")
    
    for i, constraint in enumerate(constraints, 1):
        lines.append(f"{i}. {constraint}")
    
    return "\n".join(lines)

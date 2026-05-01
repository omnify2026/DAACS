import pytest
from daacs.context import Assumptions, AssumptionDelta

class MockOrchestrator:
    """테스트용 Mock Orchestrator - DAACSOrchestrator 상속 없이 필요한 메서드만 구현"""
    def __init__(self):
        # 직접 assumptions 속성 설정 (property 없이)
        self._assumptions = Assumptions()
        self.tech_context = None
        self.last_rfi_result = None
        self.tech_context_provider = MockProvider()
        self.event_log = []

    @property
    def assumptions(self):
        return self._assumptions
    
    @assumptions.setter
    def assumptions(self, value):
        self._assumptions = value

    def _emit_event(self, event_type, data):
        self.event_log.append((event_type, data))
    
    def apply_assumption_delta(self, delta: AssumptionDelta):
        """AssumptionDelta 적용"""
        # Modified 처리
        for old_val, new_val in delta.modified:
            if old_val.startswith("environment:") and new_val.startswith("environment:"):
                self._assumptions.environment = new_val.split(":")[1]
            elif old_val.startswith("primary_focus:") and new_val.startswith("primary_focus:"):
                self._assumptions.primary_focus = new_val.split(":")[1]
        
        # Added 처리
        for item in delta.added:
            if item.startswith("option:"):
                option_name = item.split(":")[1]
                self._assumptions.options[option_name] = True
        
        # Removed 처리
        for item in delta.removed:
            if item.startswith("option:"):
                option_name = item.split(":")[1]
                self._assumptions.options[option_name] = False
        
        return {"success": True}

class MockProvider:
    def fetch(self, rfi, assumptions):
        from daacs.context import TechContext
        return TechContext(facts=[], sources=[], constraints=[])

def test_assumption_delta_apply():
    """Assumption Delta 적용 테스트"""
    orch = MockOrchestrator()
    
    # 1. 초기 상태 확인
    assert orch.assumptions.environment == "web"
    assert orch.assumptions.primary_focus == "mvp"
    
    # 2. Delta 생성 (Web -> Desktop, MVP -> Design)
    delta = AssumptionDelta(
        removed=[],
        added=["option:ci_cd"],
        modified=[
            ("environment:web", "environment:desktop"),
            ("primary_focus:mvp", "primary_focus:design")
        ]
    )
    
    # 3. 적용
    result = orch.apply_assumption_delta(delta)
    
    # 4. 검증
    assert orch.assumptions.environment == "desktop"
    assert orch.assumptions.primary_focus == "design"
    assert orch.assumptions.options.get("ci_cd") is True
    
    # 이벤트 발생 확인 (ASSUMPTION_APPLIED 등)
    # Note: apply_assumption_delta emits ASSUMPTION_APPLIED only if last_rfi_result exists
    # If we want to test event emission, we need to set last_rfi_result
    
def test_assumption_delta_options():
    """Option 추가/삭제 테스트"""
    orch = MockOrchestrator()
    
    # Add option
    delta1 = AssumptionDelta(
        removed=[],
        added=["option:maintainability"],
        modified=[]
    )
    orch.apply_assumption_delta(delta1)
    assert orch.assumptions.options["maintainability"] is True
    
    # Remove option
    delta2 = AssumptionDelta(
        removed=["option:maintainability"],
        added=[],
        modified=[]
    )
    orch.apply_assumption_delta(delta2)
    assert orch.assumptions.options["maintainability"] is False

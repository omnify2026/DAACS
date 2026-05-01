import pytest
from daacs.context import (
    StaticTechContextProvider, 
    RFIResult, 
    Assumptions, 
    Environment, 
    PrimaryFocus
)

def test_static_provider_fetch_basic():
    """기본 RFI 결과에 대한 Fact 인출 테스트"""
    provider = StaticTechContextProvider()
    
    # CASE 1: Web + MVP
    rfi = RFIResult(
        language="python",
        platform="web",
        ui_required=True,
        constraints=["빠른 MVP"]
    )
    assumptions = Assumptions(
        environment="web",
        primary_focus="mvp",
        options={}
    )
    
    ctx = provider.fetch(rfi, assumptions)
    
    assert ctx.facts  # Facts가 비어있지 않음
    assert any("React" in f or "Vite" in f for f in ctx.facts)  # frontend_web_small 내용 확인
    assert any("FastAPI" in f for f in ctx.facts)  # backend_api_small 내용 (혹은 fallback)

def test_static_provider_environment_override():
    """Assumption 변경 시 Fact 변경 확인 (Web -> Desktop)"""
    provider = StaticTechContextProvider()
    
    # CASE: RFI는 Web이라도 Assumption이 Desktop이면 Desktop 팩트 반환
    rfi = RFIResult(
        language="python",
        platform="web",  # RFI says web
        ui_required=True,
        constraints=[]
    )
    assumptions = Assumptions(
        environment="desktop",  # User override says desktop
        primary_focus="mvp",
        options={}
    )
    
    ctx = provider.fetch(rfi, assumptions)
    
    # Desktop 관련 팩트가 있어야 함
    desktop_facts = [f for f in ctx.facts if "Desktop" in f or "App" in f or "Electron" in f or "Tauri" in f]
    # Note: fallback might return different things if json files are missing, 
    # but let's assume at least fallback logic works.
    
    # If JSON files are missing, fallback logic handles desktop specific facts
    # "경량 데스크톱 앱에서는 Electron보다 Tauri 사용 비중이 증가하는 추세"
    assert any("Tauri" in f or "Electron" in f for f in ctx.facts)

def test_static_provider_constraints():
    """Assumption 기반 제약조건 생성 확인"""
    provider = StaticTechContextProvider()
    
    rfi = RFIResult(language="python", platform="web", ui_required=True, constraints=[])
    assumptions = Assumptions(
        environment="web",
        primary_focus="stability", # Stability focus
        options={"ci_cd": True}
    )
    
    ctx = provider.fetch(rfi, assumptions)
    
    # Stability 관련 제약조건 확인
    assert any("test coverage" in c.lower() for c in ctx.constraints) or \
           any("테스트" in c for c in ctx.constraints) or \
           any("stability" in c.lower() for c in ctx.constraints)

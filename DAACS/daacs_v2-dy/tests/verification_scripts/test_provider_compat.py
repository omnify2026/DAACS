from daacs.context.web_provider import WebTechContextProvider
from daacs.context.static_provider import StaticTechContextProvider
from daacs.context.types import RFIResult, Assumptions

def test_interface_compatibility():
    print("Testing Provider Interfaces...")
    
    # 1. Setup Mock Data
    rfi = RFIResult(language="python", platform="web", ui_required=True)
    assumptions = Assumptions(primary_focus="design")
    
    # 2. Test Web Provider
    try:
        web_provider = WebTechContextProvider()
        print("Calling WebTechContextProvider.fetch(rfi, assumptions)...")
        # this would crash if signature didn't match
        ctx_web = web_provider.fetch(rfi, assumptions) 
        print(f"✅ Web Provider Success. Constraints: {ctx_web.constraints}")
    except TypeError as e:
        print(f"❌ Web Provider Failed: {e}")
        
    # 3. Test Static Provider
    try:
        static_provider = StaticTechContextProvider()
        print("Calling StaticTechContextProvider.fetch(rfi, assumptions)...")
        ctx_static = static_provider.fetch(rfi, assumptions)
        print(f"✅ Static Provider Success. Constraints: {ctx_static.constraints}")
    except TypeError as e:
        print(f"❌ Static Provider Failed: {e}")

if __name__ == "__main__":
    test_interface_compatibility()

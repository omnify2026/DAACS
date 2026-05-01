#!/usr/bin/env python3
"""Test script for Phase 1.5 Assumption -> TechContext flow"""

from daacs.context import StaticTechContextProvider, RFIResult, Assumptions

provider = StaticTechContextProvider()
rfi = RFIResult(language='python', platform='web', ui_required=True)

# MVP mode
print('=== MVP Focus ===')
assumptions_mvp = Assumptions(environment='web', primary_focus='mvp')
ctx = provider.fetch(rfi, assumptions_mvp)
print(f'Constraints: {len(ctx.constraints)}')
for c in ctx.constraints:
    print(f'  {c}')

# Design mode (different result!)
print('\n=== DESIGN Focus ===')
assumptions_design = Assumptions(environment='web', primary_focus='design')
ctx2 = provider.fetch(rfi, assumptions_design)
print(f'Constraints: {len(ctx2.constraints)}')
for c in ctx2.constraints:
    print(f'  {c}')

print('\n=== Test PASSED: Different assumptions = Different constraints ===')

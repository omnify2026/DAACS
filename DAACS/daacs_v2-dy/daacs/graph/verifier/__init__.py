"""
DAACS Verifier Module

v7.2.0: QualityScorer, VisualVerifier 추가 (KK에서 이식)
"""

from .auto_fix import *
from .backend_checks import *
from .frontend_checks import *
from .static_checks import *
from .syntax_checks import *
from .result_parsers import *

# KK에서 이식된 모듈
try:
    from .quality_scorer import QualityScore, QualityScorer, score_project
except ImportError:
    pass

try:
    from .visual_verifier import VisualVerificationResult, VisualVerifier, verify_frontend
except ImportError:
    pass

"""
DAACS RFI - URL Analyzer
참고 URL에서 디자인 요소 추출 (색상, 폰트, 레이아웃)
"""

import logging
import re
from typing import Dict, List, Optional
from urllib.request import Request, urlopen
from urllib.error import URLError

logger = logging.getLogger(__name__)


def analyze_reference_url(url: str, timeout: int = 10) -> str:
    """
    참고 URL 분석 (디자인 요소 추출)
    
    - 색상 팔레트 추출 (HEX, RGB)
    - 폰트 패밀리 추출
    - 레이아웃 구조 감지
    - meta 태그 분석
    
    Args:
        url: 분석할 URL
        timeout: 요청 타임아웃 (초)
        
    Returns:
        분석 결과 문자열
    """
    logger.info(f"[URLAnalyzer] Analyzing: {url}")
    
    try:
        html = _fetch_html(url, timeout)
        if not html:
            return ""
        
        result = _extract_design_elements(html)
        return _format_analysis_result(result)
        
    except Exception as e:
        logger.error(f"[URLAnalyzer] Error: {e}")
        return ""


def _fetch_html(url: str, timeout: int) -> Optional[str]:
    """HTML 콘텐츠 가져오기"""
    try:
        req = Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        with urlopen(req, timeout=timeout) as response:
            return response.read().decode('utf-8', errors='ignore')
    except URLError as e:
        logger.warning(f"[URLAnalyzer] URL fetch failed: {e}")
        return None


def _extract_design_elements(html: str) -> Dict[str, List[str]]:
    """HTML에서 디자인 요소 추출"""
    result = {
        "hex_colors": [],
        "rgb_colors": [],
        "font_families": [],
        "google_fonts": [],
        "theme_color": None,
        "layout_hints": []
    }
    
    # 1. 색상 추출
    result["hex_colors"] = list(set(re.findall(r'#[0-9A-Fa-f]{3,6}', html)))[:10]
    result["rgb_colors"] = list(set(re.findall(r'rgb\([^)]+\)', html)))[:5]
    
    # 2. 폰트 패밀리 추출
    result["font_families"] = list(set(re.findall(r'font-family:\s*([^;}"\' ]+)', html)))[:5]
    result["google_fonts"] = list(set(re.findall(r'fonts\.googleapis\.com/css[^"\']*family=([^&"\']+)', html)))[:3]
    
    # 3. meta theme-color 추출
    theme_match = re.search(r'<meta[^>]*name=["\']theme-color["\'][^>]*content=["\']([^"\']+)["\']', html)
    if theme_match:
        result["theme_color"] = theme_match.group(1)
    
    # 4. 레이아웃 구조 감지
    layout_patterns = [
        (r'class=["\'][^"\']*sidebar[^"\']*["\']', "사이드바"),
        (r'class=["\'][^"\']*header[^"\']*["\']|<header', "헤더"),
        (r'class=["\'][^"\']*footer[^"\']*["\']|<footer', "푸터"),
        (r'class=["\'][^"\']*nav[^"\']*["\']|<nav', "네비게이션"),
        (r'class=["\'][^"\']*modal[^"\']*["\']', "모달"),
        (r'class=["\'][^"\']*card[^"\']*["\']', "카드 UI"),
        (r'class=["\'][^"\']*grid[^"\']*["\']', "그리드 레이아웃"),
        (r'class=["\'][^"\']*dark[^"\']*["\']', "다크모드 지원"),
    ]
    
    for pattern, hint in layout_patterns:
        if re.search(pattern, html, re.I):
            result["layout_hints"].append(hint)
    
    return result


def _format_analysis_result(result: Dict[str, List[str]]) -> str:
    """분석 결과 포맷팅"""
    lines = []
    
    if result["hex_colors"]:
        lines.append(f"- 색상 팔레트: {', '.join(result['hex_colors'][:6])}")
    
    if result["theme_color"]:
        lines.append(f"- 테마 색상: {result['theme_color']}")
    
    fonts = result["google_fonts"] or result["font_families"]
    if fonts:
        lines.append(f"- 폰트: {', '.join(fonts[:3])}")
    
    if result["layout_hints"]:
        lines.append(f"- 레이아웃: {', '.join(result['layout_hints'])}")
    
    return "\n".join(lines) if lines else ""

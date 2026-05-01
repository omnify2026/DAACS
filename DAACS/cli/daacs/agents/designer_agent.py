"""
DAACS DesignerAgent
UI/UX 품질을 담당하는 에이전트.

역할:
- 디자인 시스템 선정 (Tailwind, Shadcn UI 등)
- 색상 팔레트 및 타이포그래피 정의
- 스크린샷 기반 시각적 검토 (추후 멀티모달 확장)
"""

import json
from typing import Dict, Any, Optional
import logging

logger = logging.getLogger("DesignerAgent")


class DesignerAgent:
    """
    UI/UX 디자인 품질을 담당하는 에이전트
    """
    
    # 디자인 시스템 템플릿
    DESIGN_SYSTEMS = {
        "tailwind": {
            "name": "Tailwind CSS",
            "install": "npm install tailwindcss postcss autoprefixer",
            "config_file": "tailwind.config.js"
        },
        "shadcn": {
            "name": "Shadcn UI",
            "install": "npx shadcn-ui@latest init",
            "config_file": "components.json"
        },
        "mui": {
            "name": "Material UI",
            "install": "npm install @mui/material @emotion/react @emotion/styled",
            "config_file": None
        }
    }
    
    # 색상 팔레트 프리셋 (🆕 Anti-AI-Look: 절제된 전문가 스타일)
    COLOR_PALETTES = {
        "minimal_light": {
            # Linear.app / Notion 스타일 - 깔끔한 라이트 모드
            "primary": "#18181b",       # Zinc 900 (거의 검정)
            "secondary": "#71717a",     # Zinc 500 (중간 회색)
            "background": "#ffffff",    # 순백
            "surface": "#fafafa",       # Zinc 50 (매우 밝은 회색)
            "text": "#27272a",          # Zinc 800
            "accent": "#3b82f6"         # Blue 500 (포인트 1개만)
        },
        "minimal_dark": {
            # Linear.app 다크 모드 스타일
            "primary": "#fafafa",       # 밝은 텍스트
            "secondary": "#a1a1aa",     # Zinc 400
            "background": "#18181b",    # Zinc 900
            "surface": "#27272a",       # Zinc 800
            "text": "#fafafa",          # Zinc 50
            "accent": "#3b82f6"         # Blue 500
        },
        "professional": {
            # Stripe 스타일 - 비즈니스
            "primary": "#0f172a",       # Slate 900
            "secondary": "#64748b",     # Slate 500
            "background": "#ffffff",
            "surface": "#f8fafc",       # Slate 50
            "text": "#1e293b",          # Slate 800
            "accent": "#6366f1"         # Indigo (단일 포인트)
        }
    }

    
    def __init__(self, llm_client: Any = None):
        self.llm_client = llm_client
        self.project_dir = None  # 🆕 v3.0: 프로젝트 디렉터리 경로
        logger.info("[DesignerAgent] Initialized")
    
    # ==================== 🆕 v3.0: Task Plan Integration ====================
    
    def run(self, task: Dict, state: Dict = None) -> Dict:
        """
        🆕 v3.0: Task Plan에서 호출되는 메인 실행 메서드
        
        Args:
            task: Task Plan에서 할당된 작업 (id, name, description, assigned_to 등)
            state: DAACSState (optional)
        
        Returns:
            Dict: {success: bool, artifacts: Dict, files: List, error: str}
        """
        task_name = task.get("name", "").lower()
        task_desc = task.get("description", "")
        
        logger.info(f"[DesignerAgent] 🎨 Running task: {task.get('name')}")
        
        try:
            # Task 이름에 따라 적절한 작업 수행
            if "wireframe" in task_name:
                result = self._create_wireframe(task, state)
            elif "mockup" in task_name:
                result = self._create_mockup(task, state)
            elif "design system" in task_name or "디자인 시스템" in task_name:
                result = self._create_design_system_task(task, state)
            else:
                # 일반 디자인 작업 - 디자인 토큰 생성
                result = self._general_design_task(task, state)
            
            return result
            
        except Exception as e:
            logger.error(f"[DesignerAgent] Task failed: {e}")
            return {
                "success": False,
                "error": str(e),
                "artifacts": {},
                "files": []
            }
    
    def _create_wireframe(self, task: Dict, state: Dict = None) -> Dict:
        """UI 와이어프레임 생성"""
        project_goal = state.get("original_goal", "") if state else ""
        
        wireframe_content = f"""# UI Wireframe

## Project Goal
{project_goal}

## Screen Layout

### Main Page
```
+------------------------------------------+
|  [Logo]       [Nav: Home | About | ...]  |
+------------------------------------------+
|                                          |
|            Hero Section                  |
|       [Title]  [Subtitle]                |
|            [CTA Button]                  |
|                                          |
+------------------------------------------+
|           Main Content Area              |
|                                          |
|   [Card 1]    [Card 2]    [Card 3]      |
|                                          |
+------------------------------------------+
|              Footer                      |
+------------------------------------------+
```

## Component Hierarchy
1. Layout
   - Header
   - Main
   - Footer
2. Components
   - Navigation
   - Hero
   - Cards
   - Buttons

## Notes
- Mobile-first responsive design
- Dark mode support recommended
"""
        
        return {
            "success": True,
            "artifacts": {
                "wireframe": wireframe_content
            },
            "files": ["design/wireframe.md"]
        }
    
    def _create_mockup(self, task: Dict, state: Dict = None) -> Dict:
        """고화질 목업 생성 (CSS 스타일 가이드)"""
        project_goal = state.get("original_goal", "") if state else ""
        design_tokens = state.get("design_tokens", {}) if state else {}
        
        mockup_css = self._generate_mockup_css(design_tokens)
        
        return {
            "success": True,
            "artifacts": {
                "mockup_styles": mockup_css
            },
            "files": ["design/mockup.css"]
        }
    
        # 디자인 토큰 생성
        tokens = self.generate_design_tokens(project_goal, project_type)
        
        # 실제 파일 내용 생성
        design_files = self._generate_design_files(tokens)
        
        # 와이어프레임도 함께 생성
        wireframe_result = self._create_wireframe(task, state)
        
        artifacts = {
            "design_tokens": tokens,
            **design_files,
            **wireframe_result.get("artifacts", {})
        }
        
        return {
            "success": True,
            "artifacts": artifacts,
            "files": list(artifacts.keys())
        }
    
    def _generate_design_files(self, tokens: Dict) -> Dict[str, str]:
        """디자인 토큰을 기반으로 실제 설정 파일 내용 생성"""
        files = {}
        system_name = tokens.get("design_system", {}).get("name", "Tailwind CSS").lower()
        
        if "tailwind" in system_name:
            # 1. tailwind.config.js
            colors = tokens.get("colors", {})
            font_family = tokens.get("typography", {}).get("font_family", "sans-serif")
            
            config_content = f"""/** @type {{import('tailwindcss').Config}} */
module.exports = {{
  content: [
    "./index.html",
    "./src/**/*.{{js,ts,jsx,tsx}}",
  ],
  theme: {{
    extend: {{
      colors: {{
        primary: "{colors.get('primary', '#000')}",
        secondary: "{colors.get('secondary', '#666')}",
        background: "{colors.get('background', '#fff')}",
        surface: "{colors.get('surface', '#f5f5f5')}",
        text: "{colors.get('text', '#333')}",
        accent: "{colors.get('accent', '#00f')}",
      }},
      fontFamily: {{
        sans: ["{font_family}", "sans-serif"],
      }},
    }},
  }},
  plugins: [],
}}"""
            files["tailwind.config.js"] = config_content
            
            # 2. src/index.css (Tailwind directives)
            css_content = """@tailwind base;
@tailwind components;
@tailwind utilities;

:root {
  font-family: Inter, system-ui, Avenir, Helvetica, Arial, sans-serif;
}
"""
            files["src/index.css"] = css_content
            
        return files

    def _create_design_system_task(self, task: Dict, state: Dict = None) -> Dict:
        """디자인 시스템 생성 (v3.0 Task용)"""
        project_goal = state.get("original_goal", "") if state else ""
        project_type = state.get("project_type", "default") if state else "default"
        
        tokens = self.generate_design_tokens(project_goal, project_type)
        design_files = self._generate_design_files(tokens)
        
        artifacts = {
            "design_tokens": tokens,
            "design_system": tokens.get("design_system", {}),
            **design_files
        }
        
        return {
            "success": True,
            "artifacts": artifacts,
            "files": list(artifacts.keys())
        }

    def _general_design_task(self, task: Dict, state: Dict = None) -> Dict:
        """일반 디자인 작업 (Fallback) - 디자인 시스템 생성과 동일하게 처리"""
        logger.info("[DesignerAgent] Executing general design task (generating tokens/system)")
        return self._create_design_system_task(task, state)
    
    def _generate_mockup_css(self, tokens: Dict) -> str:
        """디자인 토큰을 CSS 변수로 변환"""
        colors = tokens.get("colors", {})
        typography = tokens.get("typography", {})
        
        return f"""/* Auto-generated Mockup Styles */
:root {{
  /* Colors */
  --color-primary: {colors.get('primary', '#18181b')};
  --color-secondary: {colors.get('secondary', '#71717a')};
  --color-background: {colors.get('background', '#ffffff')};
  --color-surface: {colors.get('surface', '#fafafa')};
  --color-text: {colors.get('text', '#27272a')};
  --color-accent: {colors.get('accent', '#3b82f6')};
  
  /* Typography */
  --font-family: {typography.get('font_family', "'Inter', sans-serif")};
  --font-heading: {typography.get('heading_font', "'Inter', sans-serif")};
  --font-size-base: {typography.get('base_size', '16px')};
  
  /* Spacing */
  --spacing-unit: 0.25rem;
  
  /* Border Radius */
  --radius-default: 0.25rem;
  --radius-lg: 0.5rem;
  --radius-full: 9999px;
}}

/* Base Styles */
body {{
  font-family: var(--font-family);
  font-size: var(--font-size-base);
  color: var(--color-text);
  background-color: var(--color-background);
}}

h1, h2, h3, h4, h5, h6 {{
  font-family: var(--font-heading);
}}

/* Button Styles */
.btn-primary {{
  background-color: var(--color-accent);
  color: white;
  border-radius: var(--radius-default);
  padding: calc(var(--spacing-unit) * 2) calc(var(--spacing-unit) * 4);
}}

/* Card Styles */
.card {{
  background-color: var(--color-surface);
  border-radius: var(--radius-lg);
  padding: calc(var(--spacing-unit) * 4);
}}
"""
    
    def select_design_system(self, project_type: str) -> Dict:
        """
        프로젝트 유형에 맞는 디자인 시스템 선택
        
        Args:
            project_type: "dashboard", "ecommerce", "landing", "admin", etc.
        """
        recommendations = {
            "dashboard": "shadcn",
            "admin": "shadcn",
            "ecommerce": "tailwind",
            "landing": "tailwind",
            "blog": "tailwind",
            "default": "tailwind"
        }
        
        system_key = recommendations.get(project_type.lower(), "tailwind")
        system = self.DESIGN_SYSTEMS[system_key]
        
        logger.info(f"[DesignerAgent] Selected {system['name']} for {project_type}")
        
        return {
            "design_system": system_key,
            **system
        }
    
    def select_color_palette(self, theme: str = "modern_dark") -> Dict:
        """
        색상 팔레트 선택
        
        Args:
            theme: "modern_dark", "clean_light", "professional"
        """
        palette = self.COLOR_PALETTES.get(theme, self.COLOR_PALETTES["modern_dark"])
        
        logger.info(f"[DesignerAgent] Selected {theme} color palette")
        
        return {
            "theme": theme,
            "colors": palette
        }
    
    def generate_design_tokens(self, project_goal: str, project_type: str = "default") -> Dict:
        """
        LLM을 사용하여 프로젝트 목표에 맞는 동적 디자인 시스템 생성
        """
        logger.info(f"[DesignerAgent] 🎨 Generating dynamic design for: {project_goal[:50]}...")
        
        prompt = f"""당신은 세계적인 UI/UX 디자이너입니다.
프로젝트 목표를 분석하고 가장 적합한 디자인 시스템, 색상 팔레트, 타이포그래피를 정의하세요.

=== 프로젝트 목표 ===
{project_goal}

=== 프로젝트 유형 ===
{project_type}

=== 출력 형식 (JSON) ===
{{
    "design_system": {{
        "name": "Tailwind CSS | Shadcn UI | Material UI | Chakra UI",
        "reasoning": "선택 이유 (한 줄)"
    }},
    "color_palette": {{
        "theme_name": "테마 이름 (예: Cyberpunk Neon, Corporate Clean)",
        "primary": "#HEX",
        "secondary": "#HEX",
        "background": "#HEX",
        "surface": "#HEX",
        "text": "#HEX",
        "accent": "#HEX",
        "mood_description": "색상 분위기 설명"
    }},
    "typography": {{
        "font_family": "메인 폰트 (예: Inter, Roboto)",
        "heading_font": "헤딩 폰트 (예: Outfit, Montserrat)",
        "base_size": "16px",
        "scale": 1.25
    }},
    "border_radius": {{
        "default": "0.25rem | 0.5rem | 1rem (분위기에 맞게)"
    }}
}}

규칙:
- 프로젝트의 성격(진지함, 발랄함, 미래지향적 등)에 맞는 색상과 폰트를 선택하세요.
- JSON만 출력하세요.
"""
        
        try:
            # LLM 호출 (invoke_structured 가정)
            if hasattr(self.llm_client, "invoke_structured"):
                response = self.llm_client.invoke_structured(prompt)
            else:
                # Fallback for simple clients
                response = self.llm_client.generate_content(prompt)
            
            # JSON 파싱
            if isinstance(response, str):
                import re
                json_match = re.search(r'```json\s*([\s\S]*?)\s*```', response)
                if json_match:
                    response = json_match.group(1)
                response = json.loads(response)
                
            logger.info(f"[DesignerAgent] Generated theme: {response.get('color_palette', {}).get('theme_name', 'Custom')}")
            
            # 토큰 구조화
            tokens = {
                "design_system": response.get("design_system", {"name": "Tailwind CSS"}),
                "colors": response.get("color_palette", {}),
                "typography": response.get("typography", {
                    "font_family": "Inter, sans-serif",
                    "heading_font": "Inter, sans-serif",
                    "base_size": "16px",
                    "scale": 1.25
                }),
                "spacing": {
                    "unit": "0.25rem",
                    "scale": [0, 1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24, 32, 40, 48, 64]
                },
                "border_radius": {
                    "none": "0",
                    "sm": "0.125rem",
                    "default": response.get("border_radius", {}).get("default", "0.25rem"),
                    "md": "0.375rem",
                    "lg": "0.5rem",
                    "xl": "0.75rem",
                    "2xl": "1rem",
                    "full": "9999px"
                }
            }
            return tokens
            
        except Exception as e:
            logger.error(f"[DesignerAgent] Error generating design: {e}")
            # Fallback to static generation
            return self._generate_static_tokens(project_type)

    def _generate_static_tokens(self, project_type: str) -> Dict:
        """기존 정적 생성 로직 (Fallback)"""
        design_system = self.select_design_system(project_type)
        palette = self.select_color_palette("modern_dark")
        
        return {
            "design_system": design_system,
            "colors": palette["colors"],
            "typography": {
                "font_family": "'Inter', sans-serif",
                "heading_font": "'Outfit', sans-serif",
                "base_size": "16px",
                "scale": 1.25
            },
            "spacing": {
                "unit": "0.25rem",
                "scale": [0, 1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24, 32, 40, 48, 64]
            },
            "border_radius": {
                "none": "0",
                "sm": "0.125rem",
                "default": "0.25rem",
                "md": "0.375rem",
                "lg": "0.5rem",
                "xl": "0.75rem",
                "2xl": "1rem",
                "full": "9999px"
            }
        }
    
    def review_ui_quality(self, component_code: str) -> Dict:
        """
        UI 코드 품질 검토 (기본 규칙 기반)
        
        추후 멀티모달 LLM으로 스크린샷 분석 확장 예정
        """
        issues = []
        suggestions = []
        
        # 기본 검사 규칙
        if "style=" in component_code:
            issues.append("Inline styles detected - consider using CSS classes")
        
        if "px" in component_code and "rem" not in component_code:
            suggestions.append("Consider using rem units for better accessibility")
        
        if "color:" in component_code.lower() and "#" in component_code:
            suggestions.append("Consider using design tokens instead of hardcoded colors")
        
        if "arial" in component_code.lower() or "helvetica" in component_code.lower():
            suggestions.append("Consider using modern fonts like Inter or Outfit")
        
        score = 10 - len(issues) * 2 - len(suggestions) * 0.5
        score = max(0, min(10, score))
        
        return {
            "score": score,
            "issues": issues,
            "suggestions": suggestions,
            "verdict": "pass" if score >= 7 else "needs_improvement"
        }


# Convenience function
def create_designer_agent(llm_client: Any = None) -> DesignerAgent:
    """DesignerAgent 인스턴스 생성"""
    return DesignerAgent(llm_client)

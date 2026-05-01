//! 디자인 노드 - Skills 기반 디자인 시스템 생성
//!
//! ui-ux-pro-max, frontend-design Skills를 활용하여
//! 프로젝트에 맞는 디자인 시스템을 생성합니다.

use anyhow::Result;
use crate::agents::designer::DesignerAgent;
use crate::graph::state::CLIState;
use crate::graph::workflow::{Node, NodeResult};

pub struct DesignNode;

#[async_trait::async_trait]
impl Node for DesignNode {
    async fn execute(&self, state: &mut CLIState) -> Result<NodeResult> {
        crate::logger::phase_start("디자인 시스템 생성");
        
        let config = crate::config::settings::get();
        let model = config.get_designer_model(); // Designer 모델 사용
        
        // 1. 바이브/스타일 정보 추출
        let vibe = state.interview_context
            .get("vibe")
            .cloned()
            .unwrap_or_else(|| "modern, clean".to_string());
        
        let project_type = detect_project_type(&state.daacs_content);
        
        crate::logger::status_update(&format!(
            "프로젝트 유형: {}, 바이브: {}", project_type, vibe
        ));
        
        // 2. DesignerAgent로 디자인 토큰 생성
        let designer = DesignerAgent::new(model, state.project_path.clone());
        
        let design_prompt = format!(
            "{}\n\n프로젝트 바이브: {}\n프로젝트 유형: {}",
            state.goal, vibe, project_type
        );
        
        match designer.generate_design_tokens(&design_prompt).await {
            Ok(tokens) => {
                // 3. design_system.json 저장
                let design_dir = state.project_path.join(".daacs");
                tokio::fs::create_dir_all(&design_dir).await?;
                
                let json = serde_json::to_string_pretty(&tokens)?;
                let design_path = design_dir.join("design_system.json");
                tokio::fs::write(&design_path, &json).await?;
                
                crate::logger::status_update(&format!(
                    "디자인 시스템: {} ({})",
                    tokens.design_system.name,
                    tokens.color_palette.theme_name
                ));
                
                // 4. DESIGN.md도 생성 (사람이 읽기 쉬운 버전)
                let design_md = generate_design_md(&tokens);
                let design_md_path = state.project_path.join("DESIGN.md");
                tokio::fs::write(&design_md_path, design_md).await?;
                
                crate::logger::task_complete("디자인 시스템 생성 완료");
            }
            Err(e) => {
                crate::logger::log_warning(&format!(
                    "디자인 시스템 생성 실패: {}. 기본값 사용.", e
                ));
                // 실패해도 진행 (디자인은 필수가 아님)
            }
        }
        
        Ok(NodeResult::Success)
    }
    
    fn name(&self) -> &str {
        "DesignNode"
    }
}

/// 프로젝트 유형 감지
fn detect_project_type(daacs_content: &Option<String>) -> String {
    if let Some(content) = daacs_content {
        let lower = content.to_lowercase();
        
        if lower.contains("dashboard") || lower.contains("대시보드") || lower.contains("admin") {
            return "Dashboard/Admin".to_string();
        }
        if lower.contains("e-commerce") || lower.contains("쇼핑몰") || lower.contains("ecommerce") {
            return "E-commerce".to_string();
        }
        if lower.contains("landing") || lower.contains("랜딩") {
            return "Landing Page".to_string();
        }
        if lower.contains("saas") || lower.contains("subscription") {
            return "SaaS".to_string();
        }
        if lower.contains("portfolio") || lower.contains("포트폴리오") {
            return "Portfolio".to_string();
        }
        if lower.contains("blog") || lower.contains("블로그") {
            return "Blog".to_string();
        }
        if lower.contains("mobile") || lower.contains("앱") || lower.contains("app") {
            return "Mobile App".to_string();
        }
    }
    
    "Web Application".to_string()
}

/// 디자인 토큰을 DESIGN.md로 변환
fn generate_design_md(tokens: &crate::agents::designer::DesignTokens) -> String {
    format!(
        r#"# Design System

## 1. 개요

- **디자인 시스템**: {}
- **선택 이유**: {}

## 2. 색상 팔레트

| 역할 | 색상 | 설명 |
|------|------|------|
| Primary | `{}` | 주요 액션, CTA |
| Secondary | `{}` | 보조 요소 |
| Background | `{}` | 배경 |
| Surface | `{}` | 카드, 패널 |
| Text | `{}` | 본문 텍스트 |
| Accent | `{}` | 강조 |

**테마**: {} - {}

## 3. 타이포그래피

- **본문 폰트**: {}
- **헤딩 폰트**: {}
- **기본 크기**: {}
- **스케일 비율**: {}

## 4. 간격 및 모서리

- **Border Radius**: {}

## 5. 적용 가이드

이 디자인 시스템을 프론트엔드 개발 시 참조하세요.
색상은 CSS 변수 또는 Tailwind 설정으로 적용 권장합니다.
"#,
        tokens.design_system.name,
        tokens.design_system.reasoning,
        tokens.color_palette.primary,
        tokens.color_palette.secondary,
        tokens.color_palette.background,
        tokens.color_palette.surface,
        tokens.color_palette.text,
        tokens.color_palette.accent,
        tokens.color_palette.theme_name,
        tokens.color_palette.mood_description,
        tokens.typography.font_family,
        tokens.typography.heading_font,
        tokens.typography.base_size,
        tokens.typography.scale,
        tokens.border_radius,
    )
}

//! 아키텍트 에이전트: DAACS.md와 plan.md를 생성합니다.

use anyhow::{Context, Result};
use std::collections::HashMap;
use tokio::fs;

use crate::clients::cli_client::{ModelProvider, SessionBasedCLIClient};
use crate::document::plan_md;
use crate::graph::state::{AgentType, Task, TaskStatus};

/// Architect agent.
pub struct ArchitectAgent {
    client: SessionBasedCLIClient,
}

impl ArchitectAgent {
    /// 사전 구성된 클라이언트로 생성
    pub fn with_client(client: SessionBasedCLIClient) -> Self {
        Self { client }
    }

    /// 새 아키텍트 생성
    pub fn new(model: ModelProvider, working_dir: std::path::PathBuf) -> Self {
        let client = SessionBasedCLIClient::new(model, working_dir);
        Self { client }
    }

    /// DAACS.md 생성
    pub async fn generate_daacs_md(
        &self,
        goal: &str,
        interview_context: &HashMap<String, String>,
        tech_stack: &HashMap<String, String>,
        features: &[String],
    ) -> Result<String> {
        let prompt = self.build_daacs_prompt(goal, interview_context, tech_stack, features);

        crate::logger::status_update("Architect: DAACS.md 생성 중...");
        crate::logger::status_update(&format!("  model: {:?}", self.client.provider));

        let response = self
            .client
            .execute(&prompt)
            .await
            .context("Architect agent failed")?;

        // 에이전트가 DAACS.md를 직접 작성했을 수 있음
        let daacs_path = self.client.working_dir.join("DAACS.md");
        let daacs_content = match fs::read_to_string(&daacs_path).await {
            Ok(content) => content,
            Err(_) => self.parse_daacs_response(&response, goal),
        };

        Ok(daacs_content)
    }

    /// plan.md 생성
    pub async fn generate_plan_md(
        &self,
        daacs_content: &str,
        _tech_stack: &HashMap<String, String>,
    ) -> Result<Vec<Task>> {
        let prompt = self.build_plan_prompt(daacs_content);
        crate::logger::status_update("Architect: plan.md 생성 중...");

        let response = self
            .client
            .execute(&prompt)
            .await
            .context("plan.md generation failed")?;

        let plan_path = self.client.working_dir.join("plan.md");
        let mut tasks = match plan_md::parse_file(&plan_path).await {
            Ok(parsed) => parsed,
            Err(_) => Vec::new(),
        };

        if tasks.is_empty() {
            tasks = self.parse_plan_response(&response);
        }

        Ok(tasks)
    }

    fn build_daacs_prompt(
        &self,
        goal: &str,
        interview_context: &HashMap<String, String>,
        tech_stack: &HashMap<String, String>,
        features: &[String],
    ) -> String {
        format!(
            r#"당신은 소프트웨어 아키텍트입니다. 인터뷰 결과를 바탕으로 **상세하고 실행 가능한** DAACS.md 명세서를 작성하세요.

[프로젝트 목표]
{goal}

[인터뷰 수집 정보]
{context}

[기술 스택]
{stack}

[핵심 기능]
{features}

[작성 지침]

## 필수 섹션과 작성 방법:

### 1. 개요 (## 개요)
- 프로젝트의 핵심 목적을 2-3문장으로 설명
- 대상 사용자 및 플랫폼 명시
- 인터뷰의 'design_style', 'platform' 정보 활용

### 2. 기술 스택 (## 기술 스택)
- 백엔드: 언어/프레임워크, 이유
- 프론트엔드: 프레임워크, 이유
- 데이터베이스: 종류, 이유
- 인증: 방식 (JWT/세션/OAuth 등) - 인터뷰의 'auth' 정보 활용
- 배포: 환경 (로컬/클라우드/컨테이너) - 인터뷰의 'deployment' 정보 활용

예시:
```
- 백엔드: FastAPI (Python 3.11+)
  - 빠른 개발 속도와 자동 API 문서 생성
- 프론트엔드: React 18 + TypeScript
  - 컴포넌트 재사용성과 타입 안정성
- 데이터베이스: SQLite
  - 경량 로컬 개발에 적합
- 인증: JWT 토큰 기반
- 배포: Docker 컨테이너
```

### 3. 핵심 기능 (## 기능)
- 각 기능을 세부 요구사항과 함께 나열
- 우선순위 표시 (필수/선택)
- 인터뷰의 'file_upload' 등 추가 기능 정보 활용

### 4. 아키텍처 (## 아키텍처)
- 시스템 구성도를 텍스트로 설명
- 계층 구조 (Presentation → Business Logic → Data Access)
- 주요 컴포넌트 간 상호작용
- 디렉터리 구조 포함

예시:
```
- 기본 구성
  - React 기반 UI: 컴포넌트, 라우팅, 상태 관리
  - FastAPI 백엔드: REST API, 비즈니스 로직, 데이터 검증
  - SQLite DB: 데이터 영속성

- 흐름
  1) 사용자가 UI에서 요청
  2) 프론트엔드에서 기본 검증
  3) API 호출 (fetch/axios)
  4) 백엔드에서 비즈니스 로직 처리 및 DB 저장
  5) 응답을 UI에 반영
```

### 5. API 명세 (## API)
**중요: RESTful API를 명확히 정의하세요**

각 엔드포인트마다:
- HTTP 메서드와 경로
- 요청 파라미터/바디 스키마
- 응답 스키마
- 상태 코드

예시:
```
- 사용자 인증
  - `POST /api/auth/login`
    - 요청: `{{ "email": "string", "password": "string" }}`
    - 응답: `{{ "token": "string", "user": {{ "id": "string", "email": "string" }} }}`
    - 상태: 200 (성공), 401 (인증 실패)

- 데이터 조회
  - `GET /api/items?page=1&limit=10`
    - 쿼리: page (int), limit (int)
    - 응답: `{{ "items": [], "total": 0, "page": 1 }}`
```

### 6. 데이터 모델 (## 데이터 모델)
**중요: 각 엔티티의 필드를 구체적으로 정의하세요**

각 모델마다:
- 필드명, 타입, 제약조건
- 관계 (1:N, N:M 등)
- 인덱스

예시:
```
- User
  - `id`: UUID, Primary Key
  - `email`: String(255), Unique, Not Null
  - `password_hash`: String(255), Not Null
  - `created_at`: DateTime, Default Now
  - 관계: 1:N with Items

- Item
  - `id`: UUID, Primary Key
  - `user_id`: UUID, Foreign Key → User
  - `name`: String(100), Not Null
  - `description`: Text, Nullable
  - `created_at`: DateTime, Default Now
  - 인덱스: user_id, created_at
```

### 7. UI/UX (## UI/UX)
- 주요 화면 목록과 구성
- 디자인 스타일 - 인터뷰의 'design_style', 'color_theme' 활용
- 반응형 여부
- 접근성 고려사항

예시:
```
- 디자인 스타일: 미니멀, 다크모드 지원
- 색상 테마: 주요 파란색(#2196F3), 배경 흰색/검정
- 주요 화면:
  1) 로그인 화면: 이메일/비밀번호 입력, 로그인 버튼
  2) 대시보드: 최근 항목 목록, 추가 버튼
  3) 상세 화면: 항목 정보, 수정/삭제 버튼
- 반응형: 모바일(375px~), 태블릿(768px~), 데스크톱(1024px~)
```

### 8. 개발 가이드 (## 개발 가이드)
- 최소 요구사항 (언어 버전, 도구)
- 프로젝트 구조 (디렉터리)
- 설치 및 실행 방법
- 환경 변수
- 테스트 방법

예시:
```
- 최소 요구사항
  - Python 3.11+, Node.js 18+
  - Docker (배포 시)

- 프로젝트 구조
  - `backend/` (FastAPI)
    - `app/main.py` - 진입점
    - `app/models/` - 데이터 모델
    - `app/routers/` - API 라우터
  - `frontend/` (React)
    - `src/components/` - UI 컴포넌트
    - `src/pages/` - 페이지
    - `src/api/` - API 클라이언트

- 실행
  - 백엔드: `cd backend && uvicorn app.main:app --reload`
  - 프론트엔드: `cd frontend && npm install && npm run dev`

- 환경 변수
  - `DATABASE_URL` - DB 연결 문자열
  - `JWT_SECRET` - JWT 시크릿 키
```

[중요 원칙]
1. **구체성**: "인증 구현" ❌ → "JWT 토큰 기반 인증, /api/auth/login 엔드포인트 구현" ✅
2. **실행 가능성**: 개발자가 이 명세만 보고 코딩을 시작할 수 있어야 함
3. **일관성**: 기술 스택, API, 데이터 모델이 서로 일치해야 함
4. **인터뷰 활용**: 수집한 모든 정보(디자인, 인증, 배포, 파일처리 등)를 반영
5. **한국어 우선**: 사용자에게 보이는 모든 텍스트/메시지는 한국어

[출력 형식]
- 유효한 Markdown
- 코드 블록은 언어 지정 (```python, ```typescript 등)
- 섹션 제목은 ##로 시작
"#,
            goal = goal,
            context = format_interview_context(interview_context),
            stack = format_tech_stack(tech_stack),
            features = format_features(features)
        )
    }

    fn build_plan_prompt(&self, daacs_content: &str) -> String {
        format!(
            r#"당신은 프로젝트 플래너입니다. DAACS.md 명세서를 바탕으로 **구체적이고 실행 가능한** plan.md를 작성하세요.

[DAACS.md 명세]
{spec}

[작성 지침]

## 구조
Markdown 테이블을 사용하여 단계(Phase)별로 작업을 정리:

```markdown
## 단계 1: 프로젝트 기반 구조 생성

| ID | 작업 | 담당 | 상태 |
|----|------|------|------|
| 1-1 | 백엔드 프로젝트 초기화 및 의존성 설치 | 백엔드 | TODO |
| 1-2 | 데이터베이스 스키마 생성 및 마이그레이션 | 백엔드 | TODO |
| 1-3 | 프론트엔드 프로젝트 초기화 | 프론트엔드 | TODO |
```

## 단계 정의

### 단계 1: 프로젝트 기반 구조 생성
**목표**: 개발 환경 구축 및 기본 프로젝트 구조 생성

**백엔드 작업**:
- 프로젝트 초기화 (venv/npm init/cargo init)
- 의존성 설치 (프레임워크, ORM, 검증 라이브러리)
- 디렉터리 구조 생성 (models, routers, services)
- 데이터베이스 연결 설정
- 기본 설정 파일 (.env, config)

**프론트엔드 작업** (웹인 경우):
- 프로젝트 초기화 (create-react-app/vite/next)
- 라우팅 설정
- API 클라이언트 설정 (axios/fetch)
- 기본 레이아웃 컴포넌트

**작업 크기**: 각 작업은 1-3시간 내 완료 가능해야 함

### 단계 2: 백엔드 API 구현
**목표**: DAACS.md의 API 명세를 모두 구현

**작업 분류**:
- 데이터 모델 구현 (각 엔티티별 1개 작업)
- API 엔드포인트 구현 (리소스별 CRUD)
- 인증/권한 구현 (필요한 경우)
- 비즈니스 로직 구현
- 유효성 검증 (입력 검증, 에러 핸들링)

**예시**:
- `2-1`: User 모델 구현 (스키마, CRUD)
- `2-2`: Item 모델 구현 (스키마, CRUD)
- `2-3`: 인증 API 구현 (로그인/로그아웃/토큰 검증)
- `2-4`: User-Item 관계 및 비즈니스 로직

### 단계 3: 프론트엔드 UI 구현
**목표**: 사용자 인터페이스와 API 연동

**작업 분류**:
- 주요 페이지 구현 (각 화면별 1개 작업)
- 컴포넌트 구현 (재사용 가능한 UI 요소)
- API 연동 (각 리소스별)
- 상태 관리 (Context/Redux/Zustand)
- 폼 처리 및 검증

**예시**:
- `3-1`: 로그인/회원가입 페이지
- `3-2`: 대시보드 페이지 (목록 표시)
- `3-3`: 상세/편집 페이지
- `3-4`: API 연동 및 에러 처리

### 단계 4: 테스트 및 통합
**목표**: 품질 검증 및 배포 준비

**DevOps 작업**:
- 단위 테스트 작성 및 실행
- 통합 테스트
- 빌드 스크립트 작성
- Docker 컨테이너화 (필요한 경우)
- 환경 변수 설정

**리뷰어 작업**:
- 코드 리뷰
- DAACS.md 명세 준수 검증
- 보안 취약점 점검



## 작성 원칙

1. **구체성**:
   - ❌ "백엔드 구현"
   - ✅ "User 모델 생성 (email, password_hash 필드) 및 CRUD API 구현"

2. **순차성**:
   - 백엔드 → 프론트엔드 → DevOps → 리뷰어 순서
   - 의존성 고려 (DB 모델 → API → UI)

3. **균형**:
   - 너무 큰 작업은 쪼개기 (1개 작업 = 1-3시간)
   - 너무 작은 작업은 합치기

4. **기술 스택 반영**:
   - FastAPI → Pydantic 모델, SQLAlchemy ORM
   - Django → Django ORM, Class-based views
   - React → 컴포넌트 기반, hooks
   - Vue → 컴포지션 API

5. **담당 에이전트**:
   - 백엔드: 서버 코드, API, DB
   - 프론트엔드: UI, 컴포넌트, 클라이언트 로직
   - DevOps: 테스트, 빌드, 배포
   - 리뷰어: 코드 리뷰, 품질 검증
   - 디자이너: UI/UX 폴리싱, 반응형, 애니메이션

6. **상태 컬럼**:
   - 모든 작업은 초기에 `TODO`

## 예시 출력 (가계부 앱)

```markdown
## 단계 1: 프로젝트 기반 구조 생성

| ID | 작업 | 담당 | 상태 |
|----|------|------|------|
| 1-1 | FastAPI 프로젝트 초기화 및 의존성 설치 (fastapi, uvicorn, sqlalchemy, pydantic) | 백엔드 | TODO |
| 1-2 | SQLite 데이터베이스 연결 및 Base 모델 설정 | 백엔드 | TODO |
| 1-3 | React + TypeScript 프로젝트 초기화 (Vite) | 프론트엔드 | TODO |
| 1-4 | React Router 및 Axios 설정 | 프론트엔드 | TODO |

## 단계 2: 백엔드 API 구현

| ID | 작업 | 담당 | 상태 |
|----|------|------|------|
| 2-1 | Category 모델 및 CRUD API 구현 (GET/POST/PUT /api/categories) | 백엔드 | TODO |
| 2-2 | Transaction 모델 구현 (date, amount, category_id) | 백엔드 | TODO |
| 2-3 | Transaction CRUD API 구현 (GET/POST/PUT /api/transactions) | 백엔드 | TODO |
| 2-4 | 거래 필터링 로직 (날짜 범위, 카테고리) | 백엔드 | TODO |
| 2-5 | 입력 검증 및 에러 핸들링 | 백엔드 | TODO |

## 단계 3: 프론트엔드 UI 구현

| ID | 작업 | 담당 | 상태 |
|----|------|------|------|
| 3-1 | 거래 입력 폼 컴포넌트 (날짜, 금액, 카테고리) | 프론트엔드 | TODO |
| 3-2 | 거래 목록 페이지 및 필터 UI | 프론트엔드 | TODO |
| 3-3 | 카테고리 관리 페이지 (추가/수정) | 프론트엔드 | TODO |
| 3-4 | API 연동 및 상태 관리 | 프론트엔드 | TODO |

## 단계 4: 테스트 및 빌드

| ID | 작업 | 담당 | 상태 |
|----|------|------|------|
| 4-1 | 백엔드 단위 테스트 작성 (pytest) | DevOps | TODO |
| 4-2 | 프론트엔드 빌드 및 번들링 | DevOps | TODO |
| 4-3 | 전체 코드 리뷰 및 명세 준수 확인 | 리뷰어 | TODO |

## 단계 5: 자동화 QA 및 테스트
| ID | 작업 | 담당 | 상태 |
|----|------|------|------|
| 5-1 | E2E 브라우저 테스트 (Playwright) | QA | TODO |
| 5-2 | 시스템 디버깅 및 버그 헌팅 | QA | TODO |

## 단계 6: 디자인 폴리싱
| ID | 작업 | 담당 | 상태 |
|----|------|------|------|
| 6-1 | 공통 UI 컴포넌트 스타일링 | 디자이너 | TODO |

```

[중요]
- 최소 10개 이상의 구체적인 작업 생성
- DAACS.md의 모든 API와 데이터 모델을 작업으로 반영
- 각 작업은 실행 가능하고 측정 가능해야 함
- 작업명은 한국어로, 구체적인 기술 용어 포함
"#,
            spec = daacs_content
        )
    }

    fn parse_daacs_response(&self, response: &str, goal: &str) -> String {
        let content = extract_markdown_content(response);
        if !content.starts_with('#') {
            format!("# {}\n\n{}", goal, content)
        } else {
            content
        }
    }

    fn parse_plan_response(&self, response: &str) -> Vec<Task> {
        let mut tasks = Vec::new();
        let mut current_phase = 1u32;
        let content = extract_markdown_content(response);

        for line in content.lines() {
            if line.starts_with("## Phase") || line.starts_with("##Phase") || line.starts_with("## 단계") {
                if let Some(phase_num) = extract_phase_number(line) {
                    current_phase = phase_num;
                }
            }

            if line.trim_start().starts_with("- Task") || line.trim_start().starts_with("- 작업") {
                if let Some(task) = parse_task_line(line, current_phase) {
                    tasks.push(task);
                }
            }
        }

        if tasks.is_empty() {
            crate::logger::log_warning("plan.md 파싱 실패; 기본 작업으로 대체합니다.");
            tasks = create_default_tasks();
        }

        // Hardcoded QA Tasks (Phase 5)
        tasks.push(Task {
            id: "5-1".to_string(),
            name: "QA: Automated Regression Testing".to_string(),
            description: "Apply test-driven-development and e2e-testing-patterns".to_string(),
            agent: AgentType::QA,
            status: TaskStatus::Pending,
            phase_num: 5,
            output: None,
            dependencies: Vec::new(),
        });
        tasks.push(Task {
            id: "5-2".to_string(),
            name: "QA: Deep Bug Hunting".to_string(),
            description: "Apply systematic-debugging and test-fixing".to_string(),
            agent: AgentType::QA,
            status: TaskStatus::Pending,
            phase_num: 5,
            output: None,
            dependencies: Vec::new(),
        });

        // Hardcoded Design Polish Tasks (Phase 6)
        tasks.push(Task {
            id: "6-1".to_string(),
            name: "Visual Aesthetics & Color Palette".to_string(),
            description: "Apply ui-ux-pro-max skill principles".to_string(),
            agent: AgentType::Designer,
            status: TaskStatus::Pending,
            phase_num: 6,
            output: None,
            dependencies: Vec::new(),
        });
        tasks.push(Task {
            id: "6-2".to_string(),
            name: "Component Structure & Best Practices".to_string(),
            description: "Apply frontend-design skill principles".to_string(),
            agent: AgentType::Designer,
            status: TaskStatus::Pending,
            phase_num: 6,
            output: None,
            dependencies: Vec::new(),
        });
        tasks.push(Task {
            id: "6-3".to_string(),
            name: "Shadcn UI Integration & Final Polish".to_string(),
            description: "Apply web-artifacts-builder skill principles".to_string(),
            agent: AgentType::Designer,
            status: TaskStatus::Pending,
            phase_num: 6,
            output: None,
            dependencies: Vec::new(),
        });

        tasks
    }
}

fn extract_markdown_content(text: &str) -> String {
    if let Some(start) = text.find("```markdown") {
        if let Some(end_pos) = text[start..].find("```") {
            let block_start = start + "```markdown\n".len();
            let block_end = start + end_pos;
            if block_start < block_end {
                return text[block_start..block_end].trim().to_string();
            }
        }
    }

    if let Some(start) = text.find("```") {
        let block_start = start + 3;
        if let Some(newline) = text[block_start..].find('\n') {
            let content_start = block_start + newline + 1;
            if let Some(end_pos) = text[content_start..].find("```") {
                return text[content_start..content_start + end_pos].trim().to_string();
            }
        }
    }

    text.trim().to_string()
}

fn format_interview_context(context: &HashMap<String, String>) -> String {
    if context.is_empty() {
        return "- (컨텍스트 없음)\n".to_string();
    }
    let mut formatted = String::new();
    for (key, value) in context {
        formatted.push_str(&format!("- {}: {}\n", key, value));
    }
    formatted
}

fn format_tech_stack(tech_stack: &HashMap<String, String>) -> String {
    if tech_stack.is_empty() {
        return "- 백엔드: FastAPI (Python)\n- 프론트엔드: React (TypeScript)\n".to_string();
    }
    let mut formatted = String::new();
    for (key, value) in tech_stack {
        formatted.push_str(&format!("- {}: {}\n", key, value));
    }
    formatted
}

fn format_features(features: &[String]) -> String {
    if features.is_empty() {
        return "- (기능 없음)\n".to_string();
    }
    features.iter().map(|f| format!("- {}\n", f)).collect()
}

fn extract_phase_number(line: &str) -> Option<u32> {
    let parts: Vec<&str> = line.split_whitespace().collect();
    for (i, part) in parts.iter().enumerate() {
        let lowered = part.to_lowercase();
        if (lowered == "phase" || *part == "단계") && i + 1 < parts.len() {
            return parts[i + 1].trim_end_matches(':').parse::<u32>().ok();
        }
    }
    None
}

fn parse_task_line(line: &str, phase_num: u32) -> Option<Task> {
    let trimmed = line.trim_start_matches('-').trim();
    if !(trimmed.starts_with("Task") || trimmed.starts_with("작업")) {
        return None;
    }

    let after_task = if trimmed.starts_with("Task") {
        trimmed.strip_prefix("Task")?.trim()
    } else {
        trimmed.strip_prefix("작업")?.trim()
    };

    let parts: Vec<&str> = after_task.splitn(2, ':').collect();
    if parts.len() != 2 {
        return None;
    }

    let id = parts[0].trim().to_string();
    let description_part = parts[1].trim();

    let (agent, description) = if description_part.starts_with('[') {
        if let Some(close_bracket) = description_part.find(']') {
            let agent_str = &description_part[1..close_bracket];
            let desc = description_part[close_bracket + 1..].trim();
            (parse_agent_type(agent_str), desc.to_string())
        } else {
            (AgentType::BackendDeveloper, description_part.to_string())
        }
    } else {
        (AgentType::BackendDeveloper, description_part.to_string())
    };

    Some(Task {
        id: id.clone(),
        name: description.clone(),
        description: description.clone(),
        agent,
        status: TaskStatus::Pending,
        phase_num,
        output: None,
        dependencies: Vec::new(),
    })
}

fn parse_agent_type(agent_str: &str) -> AgentType {
    match agent_str.to_lowercase().trim() {
        "backend" | "백엔드" | "백엔드개발자" => AgentType::BackendDeveloper,
        "frontend" | "프론트" | "프론트엔드" | "프론트엔드개발자" => AgentType::FrontendDeveloper,
        "devops" | "데브옵스" => AgentType::DevOps,
        "reviewer" | "리뷰어" | "검토" => AgentType::Reviewer,
        "qa" | "품질" | "테스트" => AgentType::QA,
        "architect" | "아키텍트" => AgentType::Architect,
        "designer" | "디자이너" | "디자인" => AgentType::Designer,
        _ => AgentType::BackendDeveloper,
    }
}

pub fn create_default_tasks() -> Vec<Task> {
    vec![
        Task {
            id: "1-1".to_string(),
            name: "프로젝트 구조 생성".to_string(),
            description: "백엔드/프론트엔드 기본 구조를 생성합니다.".to_string(),
            agent: AgentType::BackendDeveloper,
            status: TaskStatus::Pending,
            phase_num: 1,
            output: None,
            dependencies: Vec::new(),
        },
        Task {
            id: "2-1".to_string(),
            name: "백엔드 핵심 구현".to_string(),
            description: "API 엔드포인트와 핵심 로직을 구현합니다.".to_string(),
            agent: AgentType::BackendDeveloper,
            status: TaskStatus::Pending,
            phase_num: 2,
            output: None,
            dependencies: Vec::new(),
        },
        Task {
            id: "3-1".to_string(),
            name: "프론트엔드 UI 구현".to_string(),
            description: "UI 컴포넌트와 API 연동을 구현합니다.".to_string(),
            agent: AgentType::FrontendDeveloper,
            status: TaskStatus::Pending,
            phase_num: 3,
            output: None,
            dependencies: Vec::new(),
        },
        Task {
            id: "4-1".to_string(),
            name: "테스트 및 빌드".to_string(),
            description: "테스트를 실행하고 빌드를 준비합니다.".to_string(),
            agent: AgentType::DevOps,
            status: TaskStatus::Pending,
            phase_num: 4,
            output: None,
            dependencies: Vec::new(),
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_phase_number() {
        assert_eq!(extract_phase_number("## Phase 1: Setup"), Some(1));
        assert_eq!(extract_phase_number("## 단계 12: Final"), Some(12));
        assert_eq!(extract_phase_number("## Introduction"), None);
    }

    #[test]
    fn test_parse_agent_type() {
        assert!(matches!(
            parse_agent_type("Backend"),
            AgentType::BackendDeveloper
        ));
        assert!(matches!(
            parse_agent_type("프론트엔드"),
            AgentType::FrontendDeveloper
        ));
        assert!(matches!(parse_agent_type("DevOps"), AgentType::DevOps));
    }

    #[test]
    fn test_parse_task_line() {
        let task = parse_task_line("- Task 1-1: [Backend] Create project structure", 1);
        assert!(task.is_some());
        let task = task.unwrap();
        assert_eq!(task.id, "1-1");
        assert_eq!(task.phase_num, 1);
        assert!(matches!(task.agent, AgentType::BackendDeveloper));
    }
}

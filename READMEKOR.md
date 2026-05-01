# DAACS OS

<div align="center">

**AI가 운영하는 회사를 위한 운영체제.**

DAACS OS는 자연어 목표를 AI 에이전트들의 실제 업무로 바꾸는 데스크톱 운영 환경입니다.  
사람은 방향을 정하고 중요한 결정을 내립니다. 에이전트는 계획하고, 실행하고, 보고하고, 승인 요청을 올리고, 서로 업무를 넘깁니다.

[English](README.md) | [한국어](READMEKOR.md)

[![Rust](https://img.shields.io/badge/Rust-2021-000000?logo=rust)](https://www.rust-lang.org/)
[![Tauri](https://img.shields.io/badge/Tauri-2.x-24C8DB?logo=tauri&logoColor=white)](https://tauri.app/)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Vite](https://img.shields.io/badge/Vite-7.x-646CFF?logo=vite&logoColor=white)](https://vite.dev/)
[![Desktop](https://img.shields.io/badge/Desktop-Windows%20first-111827)](#로컬-실행)

**로컬 실행** | **에이전트 생성** | **회사 워크플로우 시작**

![DAACS OS office](DAACS_OS/docs/assets/readme/hero-office.png)

<sub>DAACS 오피스 화면: 에이전트, provider 제어, 팀 액션, 작업공간 상태를 하나의 운영 화면에서 확인합니다.</sub>

</div>

---

## Quick Start

```powershell
# 터미널 1: backend
cargo run -p daacs-auth-api

# 터미널 2: desktop
cd DAACS_OS/apps/desktop
npm install
npm run dev
```

DAACS OS를 열고 provider 연결 확인을 실행합니다.

다음 목표로 테스트할 수 있습니다.

```text
작은 SaaS 제품을 위한 랜딩 페이지, 백엔드 API endpoint, 리뷰 체크리스트, 릴리즈 보고서를 만들어줘.
```

PM 에이전트가 목표를 분석하고, 작업을 나누고, 사용 가능한 에이전트에게 업무를 배정합니다.

---

## DAACS란?

DAACS OS는 AI 에이전트들이 회사의 업무 단위가 되는 데스크톱 중심 운영체제입니다.

처음에는 개발 업무에서 시작합니다. 기획, 코드 작성, 리뷰, 검증, 로그, 승인, 산출물 관리가 핵심입니다. 하지만 DAACS가 향하는 방향은 단순한 개발 도구가 아닙니다. 배포, 사후 관리, 재무, 마케팅, 리서치, 운영, 고객 대응까지 회사 업무 전체를 에이전트가 수행하는 구조로 확장하는 것이 목표입니다.

DAACS가 바라보는 최종 형태는 네트워크로 연결된 AI 작업자들이 운영하는 회사입니다.

```text
사람이 방향을 제시
        |
        v
DAACS PM 에이전트가 목표를 업무로 분해
        |
        v
전문 에이전트들이 실행, 리뷰, 보고
        |
        v
중요한 결정은 사람이 승인
        |
        v
코드, 문서, 로그, 계획, 다음 액션 생성
```

장기적으로는 하나의 컴퓨터가 하나의 에이전트를 실행하고, 여러 컴퓨터가 네트워크로 협업해 AI가 운영하는 조직을 만드는 것이 목표입니다.

---

## 왜 DAACS인가?

대부분의 AI 도구는 채팅창입니다. DAACS는 운영 환경입니다.

| 일반 AI 채팅 도구 | DAACS OS |
| --- | --- |
| 하나의 대화창 중심 | 역할, 프롬프트, 스킬, 상태, 작업공간을 가진 여러 에이전트 |
| 사용자가 모든 조율을 직접 수행 | PM 에이전트가 목표를 분해하고 업무를 배정 |
| 결과가 주로 텍스트 | 코드, 로그, 산출물, 결정, 핸드오프를 생성 |
| 실행 과정이 보이지 않음 | 오피스 화면에서 누가 일하고, 기다리고, 넘기는지 확인 |
| 사람이 모든 단계를 직접 진행 | 사람은 목표, 승인, 판단에 집중 |

DAACS는 더 좋은 프롬프트 입력창을 만들려는 프로젝트가 아닙니다. AI가 실제로 회사를 운영하기 위한 제어면을 만드는 프로젝트입니다.

---

## 설계 원칙

| 원칙 | 의미 |
| --- | --- |
| 사람은 결정하고, 에이전트는 실행 | 사람은 방향과 중요한 결정을 맡고, 에이전트는 운영 업무를 수행합니다. |
| 에이전트는 캐릭터가 아니라 작업자 | 에이전트는 역할, 프롬프트, 스킬, 도구, 상태, 메모리, 작업 이력이 필요합니다. |
| 로컬 우선 실행 | DAACS는 사용자의 PC와 로컬 CLI provider에서 시작해 분산 노드로 확장합니다. |
| 되돌릴 수 없는 작업 전 승인 | 위험하거나 영향이 큰 작업은 명시적인 의사결정 큐를 거쳐야 합니다. |
| 업무 과정은 보여야 함 | 계획, 핸드오프, 로그, 산출물, 에이전트 상태를 확인할 수 있어야 합니다. |

---

## 사용 사례

| 사용자 | DAACS가 돕는 일 |
| --- | --- |
| 창업자 또는 운영자 | 모든 단계를 직접 프롬프트하지 않고, 비즈니스 목표를 에이전트 업무로 전환합니다. |
| 제품팀 | 요구사항에서 계획, 구현, 리뷰, 검증, 릴리즈 노트까지 하나의 흐름으로 진행합니다. |
| 엔지니어링팀 | Builder, Reviewer, Verifier, Research 에이전트를 하나의 작업공간에서 조율합니다. |
| AI 자동화 빌더 | 프롬프트, 스킬, 메타데이터, 오피스 존재감을 가진 커스텀 에이전트를 만듭니다. |
| 로컬 우선 AI 사용자 | 프로젝트 상태를 사용자 PC에 두고 로컬 CLI provider로 워크플로우를 실행합니다. |

---

## 지금 가능한 것

| 기능 | 현재 상태 |
| --- | --- |
| 공유 목표 워크플로우 | 목표를 입력하면 PM 에이전트가 작업을 계획합니다. |
| 동적 시퀀서 | PM이 에이전트에게 명령을 분배하는 command cascade를 실행합니다. |
| 로컬 CLI 실행 | Codex, Gemini, Claude 또는 설정된 로컬 provider로 에이전트 작업을 실행합니다. |
| 에이전트 오피스 | 에이전트의 위치, 작업 상태, 협업 이동을 시각화합니다. |
| 의사결정 큐 | 위험하거나 중요한 작업은 사람의 승인 흐름으로 올립니다. |
| 커스텀 에이전트 생성 | 프롬프트, 스킬, 메타데이터, 오피스 존재감을 가진 에이전트를 생성합니다. |
| 로그와 산출물 확인 | CLI 출력, 핸드오프, 작업 로그, 실행 결과를 확인합니다. |
| 오피스 커스터마이징 | 방, 에이전트 위치, 가구, 템플릿을 조정합니다. |

현재 브랜치는 pre-release 상태입니다. 지금 가장 강한 영역은 로컬 데스크톱 기반 에이전트 워크플로우입니다. 여러 컴퓨터가 협업하는 분산 에이전트 구조는 현재 구현 완료 상태가 아니라 제품이 향하는 방향입니다.

---

## 동작 방식

```text
사용자 목표
   |
   v
PM 에이전트
   - 부족한 정보를 확인
   - 작업 계획 생성
   - 에이전트에게 업무 배정
   |
   v
에이전트 실행
   - Builder 에이전트가 파일 생성 또는 수정
   - Research 에이전트가 맥락 조사와 요약
   - Reviewer, Verifier가 결과 검토
   |
   v
의사결정 큐
   - 승인
   - 보류
   - 반려
   |
   v
결과
   - 코드
   - 보고서
   - 로그
   - 다음 액션
```

핵심 런타임 흐름:

```text
Tauri 데스크톱 앱
   -> React 오피스 UI
   -> Rust 백엔드 API
   -> Tauri command bridge
   -> 로컬 AI CLI provider
   -> 에이전트 메타데이터, 프롬프트, 스킬, 런타임 로그
```

---

## 로컬 실행

### 요구사항

| 도구 | 용도 |
| --- | --- |
| Node.js 20+ | Web UI와 Tauri frontend tooling |
| npm | JavaScript 의존성과 스크립트 |
| Rust stable | 백엔드와 Tauri desktop 빌드 |
| Cargo | Rust workspace 명령 |
| Codex CLI, Gemini CLI, Claude CLI 중 하나 | 에이전트 실행 provider |

현재는 Windows를 주 개발 타깃으로 둡니다.

### 1. Clone

```powershell
git clone <your-daacs-repo-url>
cd DAACS
```

### 2. 환경 설정

```powershell
cd DAACS_OS
copy .env.example .env
```

로컬 실행과 provider에 필요한 값을 설정합니다.

| 변수 | 용도 |
| --- | --- |
| `DAACS_JWT_SECRET` | 인증 토큰 서명에 필요합니다. 32자 이상의 강한 값을 사용합니다. |
| `VITE_API_BASE_URL` | 보통 `http://127.0.0.1:8001` 입니다. |
| `DAACS_CLI_ONLY_PROVIDER` | `codex`, `gemini`, `claude` 중 하나를 지정합니다. |
| `DAACS_CODEX_MODEL` | 데스크톱 실행 경로에서 사용할 Codex 모델명입니다. |
| `OPENAI_API_KEY` | OpenAI 기반 Codex 흐름에서 필요할 수 있습니다. |
| `GOOGLE_API_KEY` | Gemini 기반 흐름에서 필요할 수 있습니다. |
| `ANTHROPIC_API_KEY` | Claude 기반 흐름에서 필요할 수 있습니다. |

`.env`와 API 키는 커밋하지 않습니다.

### 3. 의존성 설치

```powershell
cd DAACS_OS/apps/web
npm install

cd ../desktop
npm install
```

### 4. 백엔드 실행

레포 루트에서 실행합니다.

```powershell
cargo run -p daacs-auth-api
```

Health check:

```powershell
curl http://127.0.0.1:8001/health
```

정상 응답:

```json
{"status":"ok","service":"daacs-os"}
```

### 5. 데스크톱 실행

다른 터미널에서 실행합니다.

```powershell
cd DAACS_OS/apps/desktop
npm run dev
```

데스크톱 앱은 web dev server를 자동으로 실행합니다. Web UI는 아래 주소에서 동작합니다.

```text
http://localhost:3001
```

### Web-only 모드

```powershell
cd DAACS_OS/apps/web
npm run dev
```

### 빌드

```powershell
cd DAACS_OS/apps/web
npm run build

cd ../desktop
npm run build

cd ../../..
cargo check --workspace
```

---

## DAACS 사용 방법

### 1. 프로젝트 열기

프로젝트를 생성하거나 선택합니다. 프로젝트는 에이전트, 목표, 로그, 산출물, 작업공간 상태의 기준 단위입니다.

### 2. Provider 연결

CLI provider를 선택하고 연결 확인을 실행합니다. DAACS는 하나 이상의 실행 provider가 필요합니다.

| Provider | 용도 |
| --- | --- |
| Codex | OpenAI 기반 코딩 및 워크플로우 실행 |
| Gemini | Gemini CLI 실행 |
| Claude | Claude CLI 실행 |
| Local LLM | 로컬 모델 경로나 로컬 runtime 설정 시 사용 |

### 3. 공유 목표 입력

회사가 수행해야 할 목표를 자연어로 입력합니다.

```text
작은 SaaS 제품을 위한 랜딩 페이지, 백엔드 API, 릴리즈 체크리스트를 만들어줘.
```

PM 에이전트가 목표를 분석합니다. 정보가 부족하면 계획 전에 추가 질문을 합니다.

### 4. 라운드 시작

워크플로우 라운드를 시작하면 DAACS가 목표를 에이전트 업무로 바꿉니다.

```text
목표 -> PM 계획 -> 에이전트 명령 -> 실행 -> 리뷰 -> 승인 -> 결과
```

### 5. 오피스 확인

오피스 화면에서 에이전트들이 운영 팀처럼 보입니다. 에이전트는 일하고, 기다리고, 업무를 넘기고, 대화하고, 자기 자리로 돌아갑니다.

### 6. 의사결정 검토

완전 자율로 처리하면 안 되는 작업은 의사결정 큐에서 승인, 보류, 반려할 수 있습니다.

### 7. 결과 확인

Runtime 패널에서 다음을 확인합니다.

- CLI 로그
- 에이전트 메시지
- 핸드오프
- 작업 산출물
- 파일 변경
- 승인 이력

### 8. 커스텀 에이전트 생성

Agent Factory에서 역할, 프롬프트, 스킬 번들, 운영 프로필, 오피스 존재감을 가진 전문 에이전트를 만들 수 있습니다.

현재 데스크톱 커스텀 에이전트는 로컬 메타데이터 기반 에이전트입니다. 생성된 모든 커스텀 에이전트를 완전한 runtime 실행 주체로 승격하는 것은 roadmap에 포함되어 있습니다.

---

## 프로젝트 구조

```text
DAACS/
  Cargo.toml
  Cargo.lock
  crates/
    infra-error/
    infra-logger/
    ai-core/
  DAACS_OS/
    apps/
      desktop/       Tauri 데스크톱 셸
      web/           React + Vite 오피스 UI
    backend/         Rust auth/runtime API
    docs/            제품, 아키텍처, 런타임, 계획 문서
    infra/           Docker 및 배포 설정
    services/        지원 서비스와 legacy 실험
```

주요 문서:

| 문서 | 내용 |
| --- | --- |
| [Agent Factory](DAACS_OS/docs/agent-factory/agent-factory.md) | 커스텀 에이전트 생성 모델 |
| [Agent Metadata Registry](DAACS_OS/docs/agent-metadata-registry/agent-metadata-registry.md) | 메타데이터 기반 에이전트 로딩 |
| [Collaboration Choreography](DAACS_OS/docs/collaboration-choreography/collaboration-choreography.md) | 협업 시각화 모델 |
| [Execution Intents](DAACS_OS/docs/execution-intents/execution-intents.md) | 승인과 실행 의도 모델 |
| [J-Link](DAACS_OS/docs/j-link/README.md) | 에이전트 협업 언어 방향 |
| [Local CLI Execution](DAACS_OS/docs/local-cli-execution/local-cli-execution.md) | 로컬 AI CLI 실행 경로 |

---

## 문제 해결

### Windows가 Rust build script를 막는 경우

Windows Smart App Control 또는 enterprise Code Integrity 정책이 Rust build script를 막을 수 있습니다. `os error 4551`이 보이면 Windows Security 또는 조직 정책을 확인해야 합니다.

### 데스크톱 창이 뜨지 않는 경우

아래 두 주소가 응답하는지 확인합니다.

```text
http://127.0.0.1:3001
http://127.0.0.1:8001/health
```

dev build가 완료됐는데 창이 뜨지 않으면 `target/debug/daacs_desktop.exe`에서 생성된 debug binary를 직접 실행할 수 있습니다.

### CLI provider 출력이 비어 있는 경우

선택한 provider, 모델명, API key, CLI 로그인 상태, 로컬 CLI 로그를 확인합니다. Codex, Gemini, Claude CLI는 이 레포 밖에 자체 상태를 유지할 수 있습니다.

### 포트가 이미 사용 중인 경우

DAACS는 기본적으로 아래 포트를 사용합니다.

| 포트 | 서비스 |
| --- | --- |
| `3001` | Web UI |
| `8001` | Backend API |

새 세션을 시작하기 전 기존 DAACS 프로세스를 종료합니다.

---

## Roadmap

| 단계 | 목표 |
| --- | --- |
| Local desktop OS | 로컬 에이전트 오피스, 워크플로우 실행, 승인, 로그, 커스텀 에이전트 안정화 |
| Real tool connectors | 배포, 문서, 마케팅, 재무, 고객지원, 운영 도구 연결 |
| Runtime custom agents | 모든 커스텀 에이전트를 1급 실행 주체로 승격 |
| Distributed nodes | 하나의 컴퓨터가 하나 이상의 에이전트를 실행하고 네트워크로 협업 |
| AI-operated company | 사람은 방향을 정하고 DAACS 에이전트가 일상 업무를 수행 |

---

## 보안

- API 키는 환경변수 또는 안전한 로컬 저장소에 둡니다.
- `.env`, 로컬 DB, CLI 상태, 생성된 secret은 커밋하지 않습니다.
- 되돌릴 수 없거나 영향이 큰 작업은 승인 흐름을 유지합니다.
- 생성된 코드와 운영 변경은 배포 전에 검토합니다.

---

## 상태

DAACS OS는 active development 단계의 pre-release 소프트웨어입니다. 제품 방향은 명확하지만 workflow 실행, runtime agent 등록, 분산 실행, connector 지원은 빠르게 변하고 있습니다.

이 레포에는 아직 license 정보가 확정되어 있지 않습니다. 공개 배포 전 `LICENSE` 파일을 추가해야 합니다.

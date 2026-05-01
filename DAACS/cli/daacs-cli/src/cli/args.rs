//! CLI 인자 정의 (clap)

use clap::{Parser, Subcommand};

/// DAACS CLI - 자동 코딩 도구
#[derive(Parser, Debug)]
#[command(name = "daacs")]
#[command(author = "DAACS Team")]
#[command(version = "2.0.0")]
#[command(about = "DAACS CLI - Rust-based Vibe Coder Tool", long_about = None)]
pub struct Args {
    /// 프로젝트 목표 (즉시 실행)
    #[arg(short, long)]
    pub goal: Option<String>,

    /// 기존 DAACS.md 경로
    #[arg(short, long)]
    pub spec: Option<String>,

    /// 기존 plan.md 경로
    #[arg(short, long)]
    pub plan: Option<String>,

    /// 프로젝트 루트 경로
    #[arg(short, long, default_value = ".")]
    pub dir: String,

    /// 디버그 로그 출력
    #[arg(short, long)]
    pub verbose: bool,

    /// 서브커맨드
    #[command(subcommand)]
    pub command: Option<Commands>,
}

#[derive(Subcommand, Debug)]
pub enum Commands {
    /// 새 프로젝트 생성
    New {
        /// 프로젝트명
        name: String,
    },
    /// 세션 복원
    Resume {
        /// 세션 ID (미지정 시 최신)
        session_id: Option<String>,
    },
    /// 설정 조회/변경
    Config {
        /// 키
        key: Option<String>,
        /// 값
        value: Option<String>,
    },
    /// 세션 관리
    Sessions {
        #[command(subcommand)]
        action: Option<SessionAction>,
    },
}

#[derive(Subcommand, Debug)]
pub enum SessionAction {
    /// 세션 목록
    List,
    /// 세션 삭제
    Delete {
        /// 세션 ID
        session_id: String,
    },
    /// 오래된 세션 정리 (기본 30일)
    Cleanup {
        /// 보존 일수 (일)
        #[arg(short, long, default_value = "30")]
        days: u64,
    },
}

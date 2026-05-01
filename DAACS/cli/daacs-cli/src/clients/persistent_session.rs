//! Continue Mode Session Client - Python 패턴 기반 토큰 절약 세션 관리
//!
//! Claude CLI의 `-c` (--continue) 플래그를 활용하여 세션 컨텍스트를 유지합니다.
//! 첫 호출 시 시스템 컨텍스트를 전송하고, 후속 호출은 `-c` 플래그로 이전 대화를 이어갑니다.
//! 
//! 참고: Python transformers7-project의 SessionBasedCLIClient 패턴

use std::path::PathBuf;
use std::process::Stdio;
use tokio::process::Command;
use tokio::io::AsyncWriteExt;
use anyhow::{Result, Context};

use crate::clients::cli_client::ModelProvider;

/// Continue Mode 세션 클라이언트
/// 
/// 특징:
/// - CLI의 `-c` (continue) 플래그로 세션 복원
/// - stdin으로 프롬프트 전달 (`-p -`)
/// - 첫 호출 후 자동으로 continue 모드 활성화
pub struct ContinueSessionClient {
    provider: ModelProvider,
    working_dir: PathBuf,
    first_run: bool,
    call_count: u32,
}

impl ContinueSessionClient {
    /// 새 클라이언트 생성
    pub fn new(provider: ModelProvider, working_dir: PathBuf) -> Self {
        Self {
            provider,
            working_dir,
            first_run: true,
            call_count: 0,
        }
    }

    /// 세션 시작 (시스템 컨텍스트 전송)
    pub async fn start(&mut self, system_context: &str) -> Result<String> {
        if !self.first_run {
            return Ok("이미 시작됨".to_string());
        }

        crate::logger::status_update("🚀 Session 시작 (Continue Mode)...");
        
        // 첫 번째 호출 - 시스템 컨텍스트 포함
        let response = self.execute_internal(system_context).await?;
        
        crate::logger::status_update("✅ Session 초기화 완료 (후속 호출은 -c 모드)");
        
        Ok(response)
    }

    /// 작업 프롬프트 전송 (세션 컨텍스트 유지)
    pub async fn send(&mut self, task_prompt: &str) -> Result<String> {
        self.execute_internal(task_prompt).await
    }

    /// 내부 실행 로직
    async fn execute_internal(&mut self, prompt: &str) -> Result<String> {
        self.call_count += 1;
        let use_continue = !self.first_run;
        
        let (cmd, args) = self.build_command(use_continue);
        
        crate::logger::log_debug(&format!(
            "Execute #{} (continue={}): {} {:?}", 
            self.call_count, use_continue, cmd, args
        ));
        
        // 프로세스 시작
        let mut child = Command::new(&cmd)
            .args(&args)
            .current_dir(&self.working_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env("PYTHONUTF8", "1")
            .env("PYTHONIOENCODING", "utf-8")
            .spawn()
            .context(format!("Failed to spawn {}", cmd))?;

        // stdin으로 프롬프트 전달
        if let Some(mut stdin) = child.stdin.take() {
            stdin.write_all(prompt.as_bytes()).await?;
            stdin.flush().await?;
            // stdin 닫기 (EOF 전송)
            drop(stdin);
        }

        // 결과 대기
        let output = child.wait_with_output().await
            .context("Failed to wait for CLI output")?;

        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        
        // [DEBUG] Explicitly log what happened
        crate::logger::log_debug(&format!(
            "[PersistentSession] Exit: {:?}, Stdout Len: {}, Stderr Len: {}", 
            output.status.code(), stdout.len(), stderr.len()
        ));

        if stdout.len() < 10 {
            crate::logger::log_debug(&format!("[PersistentSession] Raw Stdout: {:?}", output.stdout));
        }

        if !stderr.is_empty() && !stderr.contains("warning") {
            crate::logger::log_debug(&format!("STDERR: {}", &stderr[..stderr.len().min(500)]));
        }
        
        if !output.status.success() {
            // 실패 시에도 first_run은 유지 (재시도 가능)
            anyhow::bail!("Command failed: {}", stderr);
        }

        // 첫 실행 완료 후 플래그 업데이트
        if self.first_run {
            self.first_run = false;
            crate::logger::status_update("  → 다음 호출부터 -c (continue) 모드 사용");
        }

        Ok(stdout)
    }

    /// CLI 명령어 빌드
    fn build_command(&self, use_continue: bool) -> (String, Vec<String>) {
        match &self.provider {
            ModelProvider::Claude => {
                let cmd = find_command(&["claude.exe", "claude.cmd", "claude.ps1", "claude"])
                    .unwrap_or_else(|| "claude".to_string());
                
                let mut args = Vec::new();
                
                // Continue 모드 (첫 실행 이후)
                if use_continue {
                    args.push("-c".to_string());
                }
                
                args.push("--dangerously-skip-permissions".to_string());
                args.push("-p".to_string());
                args.push("-".to_string()); // stdin에서 읽기
                
                // .ps1인 경우 PowerShell로 래핑
                if cmd.to_lowercase().ends_with(".ps1") {
                    let mut ps_args = vec![
                        "-NoProfile".to_string(),
                        "-ExecutionPolicy".to_string(),
                        "Bypass".to_string(),
                        "-File".to_string(),
                        cmd,
                    ];
                    ps_args.extend(args);
                    return ("powershell".to_string(), ps_args);
                }
                
                (cmd, args)
            }
            ModelProvider::Codex => {
                let cmd = find_command(&["codex.exe", "codex.cmd", "codex.ps1", "codex"])
                    .unwrap_or_else(|| "codex".to_string());
                
                let args = vec![
                    "exec".to_string(),
                    "--skip-git-repo-check".to_string(),
                    "--dangerously-bypass-approvals-and-sandbox".to_string(),
                    "-".to_string(), // stdin에서 읽기
                ];
                
                // .ps1인 경우 PowerShell로 래핑
                if cmd.to_lowercase().ends_with(".ps1") {
                    let mut ps_args = vec![
                        "-NoProfile".to_string(),
                        "-ExecutionPolicy".to_string(),
                        "Bypass".to_string(),
                        "-File".to_string(),
                        cmd,
                    ];
                    ps_args.extend(args);
                    return ("powershell".to_string(), ps_args);
                }
                
                (cmd, args)
            }
            ModelProvider::Gemini => {
                let cmd = find_command(&["gemini.exe", "gemini.cmd", "gemini.ps1", "gemini"])
                    .unwrap_or_else(|| "gemini".to_string());
                
                let mut args = Vec::new();
                
                // Gemini resume 모드
                if use_continue {
                    args.push("--resume".to_string());
                    args.push("latest".to_string());
                }
                
                args.push("-y".to_string()); // YOLO mode
                
                // .ps1인 경우 PowerShell로 래핑
                if cmd.to_lowercase().ends_with(".ps1") {
                    let mut ps_args = vec![
                        "-NoProfile".to_string(),
                        "-ExecutionPolicy".to_string(),
                        "Bypass".to_string(),
                        "-File".to_string(),
                        cmd,
                    ];
                    ps_args.extend(args);
                    return ("powershell".to_string(), ps_args);
                }
                
                (cmd, args)
            }
            _ => {
                panic!("API 기반 모델은 ContinueSessionClient를 사용하지 않습니다");
            }
        }
    }

    /// 세션 활성 상태 확인
    pub fn is_active(&self) -> bool {
        !self.first_run
    }

    /// 세션 리셋 (새로운 대화 시작)
    pub fn reset(&mut self) {
        self.first_run = true;
        self.call_count = 0;
        crate::logger::status_update("Session 리셋됨");
    }

    /// 호출 횟수 반환
    pub fn call_count(&self) -> u32 {
        self.call_count
    }

    /// 세션 종료 (리소스 정리)
    pub async fn stop(&mut self) -> Result<()> {
        crate::logger::status_update(&format!("Session 종료 (총 {} 호출)", self.call_count));
        Ok(())
    }
}

/// PATH에서 명령어 찾기
fn find_command(names: &[&str]) -> Option<String> {
    if let Ok(path_var) = std::env::var("PATH") {
        let separator = if cfg!(windows) { ';' } else { ':' };
        for dir in path_var.split(separator) {
            for name in names {
                let full_path = std::path::Path::new(dir).join(name);
                if full_path.exists() {
                    return Some(full_path.to_string_lossy().to_string());
                }
            }
        }
    }
    None
}

// ============================================================================
// Legacy Alias (하위 호환성)
// ============================================================================

/// PersistentSessionClient는 ContinueSessionClient의 별칭
pub type PersistentSessionClient = ContinueSessionClient;

#[cfg(test)]
mod tests {
    use super::*;
    
    #[tokio::test]
    #[ignore] // 실제 CLI가 필요하므로 기본적으로 스킵
    async fn test_continue_session() {
        let mut client = ContinueSessionClient::new(
            ModelProvider::Claude,
            std::path::PathBuf::from("."),
        );
        
        // 시작
        let response = client.start("당신은 도움이 되는 AI입니다.").await.unwrap();
        assert!(!response.is_empty());
        assert!(client.is_active());
        
        // 후속 작업
        let response2 = client.send("안녕하세요").await.unwrap();
        assert!(!response2.is_empty());
        
        // 종료
        client.stop().await.unwrap();
    }
}

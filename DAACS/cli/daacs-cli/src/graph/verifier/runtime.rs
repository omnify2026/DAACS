//! Runtime verification helpers - 실제 빌드 및 실행 검증

use anyhow::Result;
use std::path::Path;
use tokio::process::Command;

use crate::graph::verifier::{VerificationResult, VerificationStatus};

/// 백엔드 런타임 검증 (Rust/Python)
pub async fn verify_backend(project_path: &Path) -> Result<VerificationResult> {
    // Rust 프로젝트 검증
    if project_path.join("Cargo.toml").exists() {
        return verify_rust_project(project_path).await;
    }
    
    // Python 프로젝트 검증
    if project_path.join("pyproject.toml").exists() || project_path.join("requirements.txt").exists() {
        return verify_python_project(project_path).await;
    }
    
    // Node.js 백엔드 검증
    if project_path.join("package.json").exists() {
        let pkg_content = std::fs::read_to_string(project_path.join("package.json")).unwrap_or_default();
        if pkg_content.contains("express") || pkg_content.contains("fastify") || pkg_content.contains("nest") {
            return verify_node_project(project_path).await;
        }
    }
    
    Ok(VerificationResult::conditional("백엔드 프로젝트 타입을 감지하지 못했습니다."))
}

/// 프론트엔드 런타임 검증 (npm/yarn)
pub async fn verify_frontend(project_path: &Path) -> Result<VerificationResult> {
    let package_json = project_path.join("package.json");
    if !package_json.exists() {
        return Ok(VerificationResult::conditional("package.json이 없습니다."));
    }
    
    verify_node_project(project_path).await
}

/// Rust 프로젝트 빌드 검증
async fn verify_rust_project(project_path: &Path) -> Result<VerificationResult> {
    crate::logger::status_update("Rust 프로젝트 빌드 검증 중...");
    
    // cargo check 실행
    let output = Command::new("cargo")
        .arg("check")
        .arg("--message-format=json")
        .current_dir(project_path)
        .output()
        .await;
    
    match output {
        Ok(out) => {
            if out.status.success() {
                // cargo test 실행
                let test_output = Command::new("cargo")
                    .arg("test")
                    .arg("--no-run")
                    .current_dir(project_path)
                    .output()
                    .await;
                
                match test_output {
                    Ok(test_out) if test_out.status.success() => {
                        Ok(VerificationResult::ok("Rust 빌드 및 테스트 컴파일 성공"))
                    }
                    Ok(_) => {
                        Ok(VerificationResult::conditional("Rust 빌드는 성공했으나 테스트 컴파일 실패"))
                    }
                    Err(e) => {
                        Ok(VerificationResult::conditional(format!("테스트 실행 불가: {}", e)))
                    }
                }
            } else {
                let stderr = String::from_utf8_lossy(&out.stderr);
                let error_lines: Vec<_> = stderr.lines()
                    .filter(|l| l.contains("error"))
                    .take(5)
                    .collect();
                
                Ok(VerificationResult {
                    status: VerificationStatus::Fail,
                    message: format!("Rust 빌드 실패: {}", error_lines.join("; ")),
                    details: None,
                })
            }
        }
        Err(e) => {
            Ok(VerificationResult::fail(format!("cargo 실행 실패: {}", e)))
        }
    }
}

/// Python 프로젝트 검증
async fn verify_python_project(project_path: &Path) -> Result<VerificationResult> {
    crate::logger::status_update("Python 프로젝트 검증 중...");
    
    // Python 문법 검사 (py_compile 사용)
    let py_files: Vec<_> = walkdir::WalkDir::new(project_path)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().map(|ext| ext == "py").unwrap_or(false))
        .filter(|e| !e.path().to_string_lossy().contains("__pycache__"))
        .filter(|e| !e.path().to_string_lossy().contains(".venv"))
        .take(50)
        .collect();
    
    if py_files.is_empty() {
        return Ok(VerificationResult::conditional("Python 파일이 없습니다."));
    }
    
    let mut errors = Vec::new();
    for entry in &py_files {
        let output = Command::new("python")
            .arg("-m")
            .arg("py_compile")
            .arg(entry.path())
            .output()
            .await;
        
        if let Ok(out) = output {
            if !out.status.success() {
                let stderr = String::from_utf8_lossy(&out.stderr);
                errors.push(format!("{}: {}", entry.path().display(), stderr.lines().next().unwrap_or("")));
            }
        }
    }
    
    if errors.is_empty() {
        Ok(VerificationResult::ok(format!("{} Python 파일 문법 검증 통과", py_files.len())))
    } else {
        Ok(VerificationResult::fail(format!("{} 파일 문법 오류: {}", errors.len(), errors.join("; "))))
    }
}

/// Node.js 프로젝트 검증
async fn verify_node_project(project_path: &Path) -> Result<VerificationResult> {
    crate::logger::status_update("Node.js 프로젝트 검증 중...");
    
    // node_modules 확인
    if !project_path.join("node_modules").exists() {
        // npm install 실행
        let install = Command::new("npm")
            .arg("install")
            .arg("--ignore-scripts")
            .current_dir(project_path)
            .output()
            .await;
        
        if let Ok(out) = install {
            if !out.status.success() {
                return Ok(VerificationResult::fail("npm install 실패"));
            }
        }
    }
    
    // TypeScript 프로젝트면 tsc 검사
    if project_path.join("tsconfig.json").exists() {
        let tsc = Command::new("npx")
            .arg("tsc")
            .arg("--noEmit")
            .current_dir(project_path)
            .output()
            .await;
        
        if let Ok(out) = tsc {
            if !out.status.success() {
                let stderr = String::from_utf8_lossy(&out.stderr);
                let stdout = String::from_utf8_lossy(&out.stdout);
                let errors: Vec<_> = stdout.lines()
                    .chain(stderr.lines())
                    .filter(|l| l.contains("error"))
                    .take(5)
                    .collect();
                
                return Ok(VerificationResult::fail(format!("TypeScript 컴파일 실패: {}", errors.join("; "))));
            }
        }
    }
    
    // 빌드 스크립트 실행
    let pkg_content = std::fs::read_to_string(project_path.join("package.json")).unwrap_or_default();
    if pkg_content.contains("\"build\"") {
        let build = Command::new("npm")
            .arg("run")
            .arg("build")
            .current_dir(project_path)
            .output()
            .await;
        
        if let Ok(out) = build {
            if !out.status.success() {
                return Ok(VerificationResult::fail("npm run build 실패"));
            }
        }
    }
    
    Ok(VerificationResult::ok("Node.js 프로젝트 빌드 성공"))
}

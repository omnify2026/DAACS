use omni_ai_core::{fallback_rfi_outcome, parse_rfi_outcome, rfi_system_prompt, RfiStatus};
use std::io::Write;
use std::process::{Command, Stdio};

#[test]
fn test_real_codex_rfi_call() {
    let user_msg = r#"원격 팀의 주간 회의 일정을 추천해주는 웹사이트 만들어줘
여러 시간대에 있는 팀원들의 근무 시간, 필수 참석 여부, 역할 우선순위, 선호 시간대를 감안해서
가장 무리 없는 회의 시간을 찾아주는 웹사이트
고려해야할것.
시간대 차이
필수 참석자 겹침
직군별 우선순위
회의 길이
반복 일정 여부
개인 선호 시간대
(예를 들어 서울, 런던, 샌프란시스코에 있는 팀이 주 2회 회의를 잡아야 할 때
현지 업무 시간 안에서 가능한 겹치는 시간을 찾고,
모든 회의를 같은 지역에만 불리하게 몰아주지 않도록 균형을 맞추는 규칙이 필요합니다.)"#;

    let system_prompt = rfi_system_prompt();
    let full_prompt = format!("System:\n{}\n\nUser:\n{}", system_prompt, user_msg);

    println!("Sending prompt to codex...");

    let mut child = Command::new("/opt/homebrew/bin/codex")
        .args([
            "exec",
            "--ephemeral",
            "--skip-git-repo-check",
            "-m",
            "gpt-4o", // fallback or any
            "-",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("failed to spawn codex");

    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(full_prompt.as_bytes()).unwrap();
        stdin.flush().unwrap();
    }

    let out = child.wait_with_output().expect("failed to wait");
    let stdout_str = String::from_utf8_lossy(&out.stdout).to_string();
    let stderr_str = String::from_utf8_lossy(&out.stderr).to_string();
    let combined = if stdout_str.trim().is_empty() {
        stderr_str.clone()
    } else if stderr_str.trim().is_empty() {
        stdout_str.clone()
    } else {
        format!("{}\n{}", stdout_str, stderr_str)
    };

    println!("Codex Output:\n{}", stdout_str);
    if !stderr_str.is_empty() {
        println!("Codex Stderr:\n{}", stderr_str);
    }

    if out.status.success() && !stdout_str.trim().is_empty() {
        let parsed = parse_rfi_outcome(&stdout_str);
        println!("Parsed Result: {:#?}", parsed);
        assert!(parsed.is_ok(), "Failed to parse successful codex output");
        return;
    }

    let fallback = fallback_rfi_outcome(user_msg, &combined, "live_codex_unavailable_or_invalid");
    println!("Fallback Result: {:#?}", fallback);

    assert_eq!(fallback.status, RfiStatus::NeedsClarification);
    assert!(!fallback.ready_to_plan);
    assert!(!fallback.questions.is_empty());
    assert!(
        fallback
            .summary
            .contains("live_codex_unavailable_or_invalid")
            || fallback.summary.contains("Raw preview"),
        "Fallback summary should preserve the live failure context",
    );
}

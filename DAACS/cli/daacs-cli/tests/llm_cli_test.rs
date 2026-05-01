//! LLM CLI 호출 테스트
//!
//! 각 모델의 CLI가 정상적으로 호출되는지 테스트합니다.
//! 실행: cargo test --test llm_cli_test -- --nocapture

mod cli_test;

#[test]
fn test_all_llm_cli_providers() {
    cli_test::run_all_tests();
}

#[test]
fn test_claude_availability() {
    let (ok, msg) = cli_test::test_claude_cli();
    println!("Claude: {} - {}", if ok { "PASS" } else { "FAIL" }, msg);
    // 테스트 환경에서는 실패해도 OK (CLI가 설치 안 되어 있을 수 있음)
}

#[test]
fn test_codex_availability() {
    let (ok, msg) = cli_test::test_codex_cli();
    println!("Codex: {} - {}", if ok { "PASS" } else { "FAIL" }, msg);
}

#[test]
fn test_gemini_availability() {
    let (ok, msg) = cli_test::test_gemini_cli();
    println!("Gemini: {} - {}", if ok { "PASS" } else { "FAIL" }, msg);
}

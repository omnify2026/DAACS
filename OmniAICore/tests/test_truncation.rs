use omni_ai_core::{parse_rfi_outcome, RfiStatus};

#[test]
fn test_truncated_json_recovery() {
    let truncated_raw = r#"{
  "status": "needs_clarification",
  "refined_goal": "원격 팀 회의 일정 추천에서 시간대, 필수 참석자, 회의 길이, 반복 주기, 역할 우선순위, 개인 선호를 반영해"#;

    let result = parse_rfi_outcome(truncated_raw);
    assert!(
        result.is_ok(),
        "Truncated JSON parse failed! Result: {:?}",
        result
    );

    let outcome = result.unwrap();
    assert_eq!(outcome.status, RfiStatus::NeedsClarification);
    assert!(outcome.refined_goal.starts_with("원격 팀 회의 일정 추천"));
    assert_eq!(outcome.ready_to_plan, false);

    println!("SUCCESS! Parsed Outcome: {:#?}", outcome);
}

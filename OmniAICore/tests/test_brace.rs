use omni_ai_core::{parse_rfi_outcome, rfi_system_prompt};
use std::io::Write;
use std::process::{Command, Stdio};

#[test]
fn test_brace_parser_no_inner_override() {
    let raw = r#"
OpenAI Codex v0.116.0
--------
user
You are the DAACS RFI agent.
{
  "status": "needs_clarification | ready_to_plan",
  "questions": [ { "id": "placeholder" } ]
}
---
codex
{
  "status": "needs_clarification",
  "refined_goal": "협업 일정 추천 웹사이트",
  "missing_topics": ["platform"],
  "questions": [
    {
      "id": "q1",
      "topic": "platform",
      "question": "What platform?",
      "reason": "Need to know",
      "required": true
    }
  ],
  "ready_to_plan": false
}
tokens used
83,264
"#;

    let parsed = parse_rfi_outcome(raw).expect("Failed to parse");
    assert_eq!(
        parsed.questions.len(),
        1,
        "Questions array should have length 1, but got {}",
        parsed.questions.len()
    );
    assert_eq!(
        parsed.questions[0].id, "q1",
        "Extracted the wrong inner object!"
    );
    println!("SUCCESS! Extracted correct top-level JSON.");
}

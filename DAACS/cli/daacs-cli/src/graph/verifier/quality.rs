//! Quality scoring helpers.

use crate::document::review_md::ReviewData;

pub fn calculate_quality_score(review: &ReviewData) -> f32 {
    review.score
}

pub fn apply_severity_penalty(
    score: f32,
    critical: u32,
    high: u32,
    medium: u32,
    low: u32,
) -> f32 {
    let mut adjusted = score;
    adjusted -= critical as f32 * 3.0;
    adjusted -= high as f32 * 1.5;
    adjusted -= medium as f32 * 0.5;
    adjusted -= low as f32 * 0.2;
    adjusted.clamp(0.0, 10.0)
}

pub fn generate_recommendation(score: f32) -> String {
    if score >= 8.0 {
        "pass".to_string()
    } else if score >= 6.0 {
        "conditional".to_string()
    } else {
        "fail".to_string()
    }
}

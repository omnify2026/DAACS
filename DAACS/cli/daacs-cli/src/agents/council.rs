//! Council of AIs - SPEC.md 11.2 기반
//!
//! 5개 모델(Claude, Codex, Gemini, DeepSeek, GLM) 토론으로 합의안을 도출합니다.
//! 정족수(기본 3/5)와 타임아웃(기본 15초)을 사용합니다.

use std::collections::HashSet;
use std::time::Duration;

use anyhow::Result;
use tokio::time::timeout;

use crate::clients::cli_client::{ModelProvider, SessionBasedCLIClient};
use crate::tui::dashboard::events::{AgentEvent, VoteType};
use flume::Sender;

/// Council 설정
#[derive(Debug, Clone)]
pub struct CouncilConfig {
    /// 정족수(기본: 3)
    pub quorum: usize,
    /// 타임아웃(기본: 15초)
    pub timeout_secs: u64,
    /// 사용 모델 목록
    pub models: Vec<ModelProvider>,
}

impl Default for CouncilConfig {
    fn default() -> Self {
        Self {
            quorum: 4,  // Wait for all 4 models (User Request)
            timeout_secs: 120, // Increased to 2m for reliable 4-model analysis
            models: vec![
                ModelProvider::Codex,
                ModelProvider::Gemini,
                ModelProvider::Claude,
                ModelProvider::GLM,
            ],
        }
    }
}

/// Council 응답
#[derive(Debug, Clone)]
pub struct CouncilResponse {
    pub model: String,
    pub response: String,
}

/// Council of AIs 실행
pub async fn run_council(
    prompt: &str,
    config: CouncilConfig,
    working_dir: std::path::PathBuf,
) -> Result<Vec<CouncilResponse>> {
    let debate_prompt = if prompt.contains("Error Log:") || prompt.contains("Healer Request:") {
        format!(
            "🚨 [긴급 소집] Healer가 수정을 포기한 에러입니다.\n\n[상황]\n{}\n\n[요청]\n이 에러의 원인이 단순 문법 오류인지, 아니면 설계/논리적 결함인지 분석하고, 구체적인 수정 코드를 포함한 해결책을 제시하세요.",
            prompt
        )
    } else {
        format!(
            "다음 문제를 분석하고 최선의 해결책을 제시해 주세요.\n\n{}\n\n결론과 근거를 한국어로 명확하게 정리하세요.",
            prompt
        )
    };

    let mut handles = Vec::new();

    for model in config.models.clone() {
        let prompt_clone = debate_prompt.clone();
        let working_dir_clone = working_dir.clone();

        let handle = tokio::spawn(async move {
            crate::logger::status_update(&format!("📤 Sending prompt to {:?}", model));
            let client = SessionBasedCLIClient::new(model.clone(), working_dir_clone);
            let result = client.execute(&prompt_clone).await;
            if result.is_ok() {
                crate::logger::status_update(&format!("📥 Received response from {:?}", model));
            }
            (format!("{:?}", model), result)
        });

        handles.push(handle);
    }

    // Quorum + Timeout
    let mut responses = Vec::new();
    let timeout_duration = Duration::from_secs(config.timeout_secs);

    let collection_result = timeout(timeout_duration, async {
        for handle in handles {
            if let Ok((model, result)) = handle.await {
                if let Ok(response) = result {
                    responses.push(CouncilResponse { model, response });

                    // 정족수 도달 시 조기 종료
                    if responses.len() >= config.quorum {
                        break;
                    }
                }
            }
        }
    })
    .await;

    // 타임아웃 체크
    if collection_result.is_err() {
        crate::logger::log_warning(&format!(
            "⚠️ Council 타임아웃 발생 ({}초 초과). 현재까지 {}/{}개 응답 수신",
            config.timeout_secs,
            responses.len(),
            config.models.len()
        ));
    }

    if responses.is_empty() {
        anyhow::bail!("Council 타임아웃: 모든 모델이 응답하지 않았습니다. API 키 설정을 확인하세요.");
    }

    let status_msg = if responses.len() >= config.quorum {
        format!(
            "✅ Council 정족수 달성: {}/{}개 응답 수신",
            responses.len(),
            config.models.len()
        )
    } else {
        format!(
            "⚠️ Council 부분 성공: {}/{}개 응답 수신 (정족수 {}, 계속 진행)",
            responses.len(),
            config.models.len(),
            config.quorum
        )
    };
    let status_msg = if responses.len() >= config.quorum {
        format!(
            "✅ Council 정족수 달성: {}/{}개 응답 수신",
            responses.len(),
            config.models.len()
        )
    } else {
        format!(
            "⚠️ Council 부분 성공: {}/{}개 응답 수신 (정족수 {}, 계속 진행)",
            responses.len(),
            config.models.len(),
            config.quorum
        )
    };
    crate::logger::status_update(&status_msg);

    Ok(responses)
}

/// Council 실행 (Event Sender 포함)
pub async fn run_council_with_events(
    prompt: &str,
    config: CouncilConfig,
    working_dir: std::path::PathBuf,
    event_sender: Option<Sender<AgentEvent>>,
) -> Result<Vec<CouncilResponse>> {
    if let Some(sender) = &event_sender {
        let _ = sender.send(AgentEvent::StatusChange {
            agent: "Council".to_string(),
            status: "투표 진행 중...".to_string(),
            is_active: true,
        });
    }

    let responses = run_council(prompt, config, working_dir.clone()).await?;

    if let Some(sender) = &event_sender {
        // Broadcast votes individually
        for res in &responses {
            let vote_type = if res.response.to_lowercase().contains("reject") || res.response.contains("거절") {
                VoteType::Reject
            } else {
                VoteType::Approve
            };
            
            let _ = sender.send(AgentEvent::CouncilVote {
                voter: res.model.clone(),
                vote: vote_type,
                reason: res.response.chars().take(50).collect(), // Brief reason
            });
        }

        let _ = sender.send(AgentEvent::StatusChange {
            agent: "Council".to_string(),
            status: "투표 완료".to_string(),
            is_active: false,
        });
    }

    Ok(responses)
}

/// Council 결과 합성
pub fn synthesize_responses(responses: &[CouncilResponse]) -> String {
    if responses.is_empty() {
        return "응답 없음".to_string();
    }

    let mut synthesis = String::new();
    
    // Header
    synthesis.push_str("\n╭──────────────────────────────────────────────────╮\n");
    synthesis.push_str("│           🏛️  Council of AIs 합의 결과              │\n");
    synthesis.push_str("╰──────────────────────────────────────────────────╯\n\n");

    // 1. 합의된 솔루션 (Consensus)
    let candidates = extract_candidates(responses);
    let clusters = cluster_candidates(&candidates);
    
    // Threshold calculation (Majority)
    let threshold = responses.len().div_ceil(2);
    let mut consensus_points = Vec::new();

    for cluster in clusters {
        if cluster.supporting_models.len() >= threshold {
            consensus_points.push((cluster.supporting_models.len(), cluster.representative));
        }
    }
    consensus_points.sort_by(|a, b| b.0.cmp(&a.0));

    synthesis.push_str("🏆 최종 결론 (The Verdict)\n");
    synthesis.push_str("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
    if consensus_points.is_empty() {
        synthesis.push_str("💡 (모델 간 의견이 갈려서 명확한 합의점이 없습니다.)\n");
    } else {
        for (_, point) in consensus_points.iter().take(10) {
             synthesis.push_str(&format!("• {}\n", point));
        }
        if consensus_points.len() > 10 {
            synthesis.push_str(&format!("... 외 {}개 포인트\n", consensus_points.len() - 10));
        }
    }
    synthesis.push_str("\n");

    // 2. 개별 모델 의견 (Individual Opinions)
    synthesis.push_str("🗳️  모델별 상세 의견 (Individual Voices)\n");
    synthesis.push_str("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
    
    for response in responses {
        synthesis.push_str(&format!("\n👤 [{}]\n", response.model));
        synthesis.push_str("──────────────────────────────────────────────────\n");
        let clean_body = response.response.trim();
        synthesis.push_str(clean_body);
        synthesis.push_str("\n");
    }

    synthesis
}

struct CandidateLine {
    model: String,
    line: String,
    tokens: HashSet<String>,
}

struct Cluster {
    representative: String,
    supporting_models: HashSet<String>,
    tokens: HashSet<String>,
}

fn extract_candidates(responses: &[CouncilResponse]) -> Vec<CandidateLine> {
    let mut candidates = Vec::new();

    for response in responses {
        for line in response.response.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }

            let cleaned = strip_bullet(line);
            if cleaned.len() < 12 || cleaned.len() > 200 {
                continue;
            }

            let tokens = tokenize(cleaned);
            if tokens.len() < 2 {
                continue;
            }

            candidates.push(CandidateLine {
                model: response.model.clone(),
                line: cleaned.to_string(),
                tokens,
            });
        }
    }

    candidates
}

fn cluster_candidates(candidates: &[CandidateLine]) -> Vec<Cluster> {
    let mut clusters: Vec<Cluster> = Vec::new();

    for candidate in candidates {
        let mut best_idx: Option<usize> = None;
        let mut best_score = 0.0;

        for (idx, cluster) in clusters.iter().enumerate() {
            let score = jaccard(&candidate.tokens, &cluster.tokens);
            if score > best_score {
                best_score = score;
                best_idx = Some(idx);
            }
        }

        if let Some(idx) = best_idx {
            if best_score >= 0.5 {
                let cluster = &mut clusters[idx];
                cluster.supporting_models.insert(candidate.model.clone());
                cluster.tokens.extend(candidate.tokens.iter().cloned());
                if candidate.line.len() < cluster.representative.len() {
                    cluster.representative = candidate.line.clone();
                }
                continue;
            }
        }

        let mut supporting_models = HashSet::new();
        supporting_models.insert(candidate.model.clone());
        clusters.push(Cluster {
            representative: candidate.line.clone(),
            supporting_models,
            tokens: candidate.tokens.clone(),
        });
    }

    clusters
}

fn strip_bullet(line: &str) -> &str {
    let trimmed = line.trim_start();
    if let Some(rest) = trimmed.strip_prefix('-') {
        return rest.trim_start();
    }
    if let Some(rest) = trimmed.strip_prefix('*') {
        return rest.trim_start();
    }
    if let Some(rest) = trimmed.strip_prefix('•') {
        return rest.trim_start();
    }
    if trimmed.len() >= 2 {
        let mut chars = trimmed.chars();
        if let Some(first) = chars.next() {
            if first.is_ascii_digit() {
                if let Some(second) = chars.next() {
                    if second == '.' || second == ')' {
                        return chars.as_str().trim_start();
                    }
                }
            }
        }
    }
    trimmed
}

fn tokenize(text: &str) -> HashSet<String> {
    let stopwords = stopwords();
    let mut tokens = HashSet::new();
    let mut current = String::new();

    for ch in text.chars() {
        if ch.is_alphanumeric() || is_korean(ch) {
            current.push(ch);
        } else if !current.is_empty() {
            let token = current.to_lowercase();
            if token.len() >= 2 && !stopwords.contains(token.as_str()) {
                tokens.insert(token);
            }
            current.clear();
        }
    }

    if !current.is_empty() {
        let token = current.to_lowercase();
        if token.len() >= 2 && !stopwords.contains(token.as_str()) {
            tokens.insert(token);
        }
    }

    tokens
}

fn is_korean(ch: char) -> bool {
    ('\u{AC00}'..='\u{D7A3}').contains(&ch) || ('\u{1100}'..='\u{11FF}').contains(&ch)
}

fn stopwords() -> HashSet<&'static str> {
    let mut set = HashSet::new();
    let words = [
        "the", "and", "or", "to", "a", "of", "in", "on", "for", "is", "are", "be", "as",
        "with", "that", "this", "it", "we", "you", "i", "our", "your", "their",
        "그리고", "또는", "및", "을", "를", "에", "의", "가", "이", "은", "는", "하다",
        "하는", "합니다", "이다", "있다", "없다", "위해", "관련", "필요", "해야", "가능",
        "에서", "또한", "부터", "또", "등", "와", "과",
    ];
    for w in words {
        set.insert(w);
    }
    set
}

fn jaccard(a: &HashSet<String>, b: &HashSet<String>) -> f32 {
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    let intersection = a.intersection(b).count() as f32;
    let union = (a.len() + b.len()) as f32 - intersection;
    if union == 0.0 { 0.0 } else { intersection / union }
}

fn truncate_response(text: &str, max_chars: usize) -> String {
    if text.len() <= max_chars {
        return text.trim().to_string();
    }
    let mut truncated = text.chars().take(max_chars).collect::<String>();
    truncated.push_str("...");
    truncated
}

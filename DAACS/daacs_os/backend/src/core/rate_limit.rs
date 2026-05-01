#![allow(dead_code)]

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use infra_error::{AppError, AppResult};

struct RateLimitStore {
    events: HashMap<String, Vec<Instant>>,
}

static STORE: std::sync::OnceLock<Mutex<RateLimitStore>> = std::sync::OnceLock::new();

fn get_store() -> AppResult<&'static Mutex<RateLimitStore>> {
    STORE.get_or_init(|| {
        Mutex::new(RateLimitStore {
            events: HashMap::new(),
        })
    });
    Ok(STORE
        .get()
        .ok_or_else(|| AppError::Message("rate_limit store".into()))?)
}

pub fn check_rate_limit(
    key: &str,
    limit: u32,
    window_seconds: u64,
) -> AppResult<(bool, Option<u64>)> {
    let window = Duration::from_secs(window_seconds.max(1));
    let now = Instant::now();
    let cutoff = now.checked_sub(window).unwrap_or(now);
    let mut guard = get_store()?
        .lock()
        .map_err(|e| AppError::Message(e.to_string()))?;
    let events = guard.events.entry(key.to_string()).or_default();
    events.retain(|&ts| ts > cutoff);
    let allowed = (events.len() as u32) < limit;
    let retry_after = if allowed {
        None
    } else {
        events.first().map(|first| {
            let elapsed = now.saturating_duration_since(*first);
            (window.as_secs().saturating_sub(elapsed.as_secs())).max(1)
        })
    };
    if allowed {
        events.push(now);
    }
    Ok((allowed, retry_after))
}

#![allow(dead_code)]

use infra_error::AppResult;

pub struct TurnLimitGuard;

impl TurnLimitGuard {
    pub fn new() -> Self {
        Self
    }

    pub fn check(&self, _project_id: &str, _role: &str) -> AppResult<bool> {
        Ok(true)
    }
}

pub struct SpendCapGuard {
    pub daily_cap_usd: f64,
}

impl SpendCapGuard {
    pub fn new(daily_cap_usd: f64) -> Self {
        Self { daily_cap_usd }
    }

    pub fn check(&self, _project_id: &str, _estimated_usd: f64) -> AppResult<bool> {
        Ok(true)
    }
}

//! Verification module interfaces.

use anyhow::Result;

#[async_trait::async_trait]
pub trait Verifier {
    async fn verify(&self) -> Result<VerificationResult>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VerificationStatus {
    Ok,
    Conditional,
    Fail,
}

#[derive(Debug, Clone)]
pub struct VerificationResult {
    pub status: VerificationStatus,
    pub message: String,
    pub details: Option<serde_json::Value>,
}

impl VerificationResult {
    pub fn ok(message: impl Into<String>) -> Self {
        Self {
            status: VerificationStatus::Ok,
            message: message.into(),
            details: None,
        }
    }

    pub fn conditional(message: impl Into<String>) -> Self {
        Self {
            status: VerificationStatus::Conditional,
            message: message.into(),
            details: None,
        }
    }

    pub fn fail(message: impl Into<String>) -> Self {
        Self {
            status: VerificationStatus::Fail,
            message: message.into(),
            details: None,
        }
    }
}

pub mod quality;
pub mod runtime;
pub mod visual;
pub mod e2e;
pub mod performance;
pub mod stability;
pub mod consistency;

#![allow(dead_code)]

use serde::Serialize;

#[derive(Debug, Clone, Default, Serialize)]
pub struct TokenTracker {
    pub total_input_tokens: u64,
    pub total_output_tokens: u64,
}

impl TokenTracker {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn record(&mut self, input: u64, output: u64) {
        self.total_input_tokens += input;
        self.total_output_tokens += output;
    }
}

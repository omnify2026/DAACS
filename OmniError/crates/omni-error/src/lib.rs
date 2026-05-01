use std::fmt::{Display, Formatter};

#[derive(Debug, Clone)]
pub enum AppError {
    Message(String),
}

impl Display for AppError {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            AppError::Message(msg) => write!(f, "{}", msg),
        }
    }
}

impl std::error::Error for AppError {}

impl From<String> for AppError {
    fn from(InValue: String) -> Self {
        AppError::Message(InValue)
    }
}

impl From<&str> for AppError {
    fn from(InValue: &str) -> Self {
        AppError::Message(InValue.to_string())
    }
}

impl From<std::time::SystemTimeError> for AppError {
    fn from(InValue: std::time::SystemTimeError) -> Self {
        AppError::Message(InValue.to_string())
    }
}

impl From<jsonwebtoken::errors::Error> for AppError {
    fn from(InValue: jsonwebtoken::errors::Error) -> Self {
        AppError::Message(InValue.to_string())
    }
}

impl From<sqlx::Error> for AppError {
    fn from(InValue: sqlx::Error) -> Self {
        AppError::Message(InValue.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;

use thiserror::Error;

#[derive(Error, Debug)]
pub enum AppError {
    #[error("IO: {0}")]
    Io(#[from] std::io::Error),
    #[error("JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("{0}")]
    Message(String),
}

pub type AppResult<T> = Result<T, AppError>;

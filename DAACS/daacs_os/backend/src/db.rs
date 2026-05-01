use std::str::FromStr;

use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

use infra_error::{AppError, AppResult};

pub async fn init_pool(database_url: &str) -> AppResult<sqlx::SqlitePool> {
    let options = SqliteConnectOptions::from_str(database_url)
        .map_err(|e| AppError::Message(e.to_string()))?
        .create_if_missing(true);

    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(options)
        .await
        .map_err(|e| AppError::Message(e.to_string()))?;
    Ok(pool)
}

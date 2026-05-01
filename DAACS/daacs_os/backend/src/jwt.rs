use infra_error::{AppError, AppResult};
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

const DEFAULT_TTL_SECS: u64 = 86400;

#[derive(Debug, Serialize, Deserialize)]
pub struct Claims {
    pub sub: String,
    pub email: String,
    #[serde(default)]
    pub billing_track: Option<String>,
    pub exp: u64,
    pub iat: u64,
}

fn current_unix_secs() -> AppResult<u64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .map_err(|e| AppError::Message(e.to_string()))
}

#[cfg(test)]
pub fn create_access_token(sub: &str, email: &str, secret: &[u8]) -> AppResult<String> {
    create_access_token_with_billing_track(sub, email, None, secret)
}

pub fn create_access_token_with_billing_track(
    sub: &str,
    email: &str,
    billing_track: Option<&str>,
    secret: &[u8],
) -> AppResult<String> {
    let now = current_unix_secs()?;
    let exp = now + DEFAULT_TTL_SECS;
    let claims = Claims {
        sub: sub.to_string(),
        email: email.to_string(),
        billing_track: billing_track.map(str::to_string),
        exp,
        iat: now,
    };
    encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(secret),
    )
    .map_err(|e| AppError::Message(e.to_string()))
}

pub fn decode_access_token(token: &str, secret: &[u8]) -> AppResult<Claims> {
    decode::<Claims>(
        token,
        &DecodingKey::from_secret(secret),
        &Validation::default(),
    )
    .map(|d| d.claims)
    .map_err(|e| AppError::Message(e.to_string()))
}

pub fn jwt_secret() -> AppResult<Vec<u8>> {
    let secret = std::env::var("DAACS_JWT_SECRET")
        .map_err(|_| AppError::Message("DAACS_JWT_SECRET is not configured".into()))?;
    let secret = secret.trim();
    if secret.len() < 32 {
        return Err(AppError::Message(
            "DAACS_JWT_SECRET must be at least 32 characters".into(),
        ));
    }
    Ok(secret.as_bytes().to_vec())
}

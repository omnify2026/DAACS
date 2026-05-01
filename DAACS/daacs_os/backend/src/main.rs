use axum::Router;
use std::collections::HashMap;
use std::fs;
use std::net::SocketAddr;
use std::path::Path;
use std::sync::Arc;
use tokio::sync::Mutex;
use tower_http::cors::{Any, CorsLayer};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

mod agents;
mod application;
mod auth;
mod core;
mod db;
mod domain;
mod events;
mod executor;
mod jwt;
mod llm;
mod memory;
mod monitoring;
mod overnight;
mod planner;
mod routes;
mod safety;
mod sandbox;
mod templates;
mod worktree;

use db::init_pool;
use domain::seed::seed_builtin_blueprints;
use events::EventBus;
use infra_error::AppError;
use routes::{api_router, health_router};

const LOCAL_AUTH_HOST: &str = "127.0.0.1";
const LOCAL_AUTH_PORT: u16 = 8001;

#[tokio::main]
async fn main() {
    let filter = match tracing_subscriber::EnvFilter::try_from_default_env() {
        Ok(f) => f,
        Err(_) => tracing_subscriber::EnvFilter::new("info"),
    };
    tracing_subscriber::registry()
        .with(filter)
        .with(tracing_subscriber::fmt::layer())
        .init();

    if let Err(e) = run().await {
        tracing::error!("server error: {}", e);
        std::process::exit(1);
    }
}

async fn run() -> Result<(), AppError> {
    load_runtime_env();
    jwt::jwt_secret()?;

    let database_url = resolve_database_url()?;

    let pool = init_pool(&database_url).await?;
    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .map_err(|e| AppError::Message(e.to_string()))?;
    seed_builtin_blueprints(&pool).await?;

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let event_bus = EventBus::new(256);
    let skill_loader = domain::skills::load_shared_skill_loader()?;

    let app = Router::new()
        .merge(health_router())
        .nest("/api", api_router())
        .layer(cors)
        .with_state(AppState {
            pool,
            event_bus,
            skill_loader,
            http_client: reqwest::Client::new(),
            collaboration_sessions: Arc::new(Mutex::new(HashMap::new())),
        });

    let addr = resolve_auth_bind_addr()?;
    tracing::info!("listening on {}", addr);

    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .map_err(|e| AppError::Message(e.to_string()))?;
    axum::serve(listener, app)
        .await
        .map_err(|e| AppError::Message(e.to_string()))?;
    Ok(())
}

fn load_runtime_env() {
    let env_path = Path::new(env!("CARGO_MANIFEST_DIR")).join(".env");
    let Ok(contents) = fs::read_to_string(&env_path) else {
        return;
    };

    for line in contents.lines() {
        let entry = line.trim();
        if entry.is_empty() || entry.starts_with('#') {
            continue;
        }

        let Some((raw_key, raw_value)) = entry.split_once('=') else {
            continue;
        };

        let key = raw_key.trim();
        if key.is_empty() || std::env::var_os(key).is_some() {
            continue;
        }

        let value = raw_value
            .trim()
            .trim_matches('"')
            .trim_matches('\'')
            .to_string();
        std::env::set_var(key, value);
    }
}

fn resolve_auth_bind_addr() -> Result<SocketAddr, AppError> {
    let host = std::env::var("DAACS_AUTH_HOST").unwrap_or_else(|_| LOCAL_AUTH_HOST.into());
    if host != LOCAL_AUTH_HOST {
        return Err(AppError::Message(format!(
            "DAACS auth backend must bind to {}:{}, but DAACS_AUTH_HOST={host}",
            LOCAL_AUTH_HOST, LOCAL_AUTH_PORT
        )));
    }

    let port = std::env::var("DAACS_AUTH_PORT")
        .unwrap_or_else(|_| LOCAL_AUTH_PORT.to_string())
        .parse::<u16>()
        .map_err(|e| AppError::Message(format!("invalid DAACS_AUTH_PORT: {e}")))?;
    if port != LOCAL_AUTH_PORT {
        return Err(AppError::Message(format!(
            "DAACS auth backend must bind to {}:{}, but DAACS_AUTH_PORT={port}",
            LOCAL_AUTH_HOST, LOCAL_AUTH_PORT
        )));
    }

    Ok(SocketAddr::from(([127, 0, 0, 1], LOCAL_AUTH_PORT)))
}

fn resolve_database_url() -> Result<String, AppError> {
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let raw_url = std::env::var("DAACS_DATABASE_URL")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "sqlite:./daacs.db".to_string());

    let Some(path_part) = raw_url.strip_prefix("sqlite:") else {
        return Ok(raw_url);
    };

    if path_part.is_empty()
        || path_part == ":memory:"
        || path_part.starts_with('/')
        || path_part.starts_with("file:")
    {
        return Ok(raw_url);
    }

    let resolved = manifest_dir.join(path_part);
    let absolute = resolved
        .canonicalize()
        .or_else(|_| {
            resolved
                .parent()
                .map(fs::create_dir_all)
                .transpose()?
                .ok_or_else(|| std::io::Error::other("database path has no parent"))?;
            Ok::<_, std::io::Error>(resolved)
        })
        .map_err(|e| AppError::Message(format!("failed to resolve database path: {e}")))?;

    let display = absolute.display().to_string();
    let cleaned = display.strip_prefix(r"\\?\").unwrap_or(&display);

    Ok(format!("sqlite:{}", cleaned))
}

#[derive(Clone)]
pub struct AppState {
    pub pool: sqlx::SqlitePool,
    pub event_bus: EventBus,
    pub skill_loader: domain::skills::SharedSkillLoader,
    pub http_client: reqwest::Client,
    pub collaboration_sessions: Arc<Mutex<HashMap<String, serde_json::Value>>>,
}

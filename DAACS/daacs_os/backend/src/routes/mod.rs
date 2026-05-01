mod agents;
mod blueprints;
mod execution;
mod health;
mod llm_settings;
mod runtime;

use axum::Router;

use crate::auth::auth_router;

pub fn api_router() -> Router<crate::AppState> {
    Router::new()
        .nest("/auth", auth_router())
        .merge(agents::agents_router())
        .merge(blueprints::blueprints_router())
        .merge(runtime::runtime_router())
        .merge(execution::execution_router())
        .merge(llm_settings::llm_router())
}

pub fn health_router() -> Router<crate::AppState> {
    Router::new()
        .route("/health", axum::routing::get(health::health))
        .route("/", axum::routing::get(health::root))
}

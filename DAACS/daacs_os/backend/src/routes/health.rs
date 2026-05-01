use axum::extract::State;
use axum::Json;
use serde::Serialize;

use crate::AppState;

#[derive(Serialize)]
pub struct HealthBody {
    status: &'static str,
    service: &'static str,
}

pub async fn health(State(_): State<AppState>) -> Json<HealthBody> {
    Json(HealthBody {
        status: "ok",
        service: "daacs-os",
    })
}

#[derive(Serialize)]
pub struct RootBody {
    name: &'static str,
    version: &'static str,
    description: &'static str,
}

pub async fn root(State(_): State<AppState>) -> Json<RootBody> {
    Json(RootBody {
        name: "DAACS OS",
        version: "1.0.0",
        description: "One Man, One Enterprise",
    })
}

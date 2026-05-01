#![allow(dead_code)]

use std::collections::HashMap;
use std::sync::Mutex;

use infra_error::{AppError, AppResult};

struct TicketEntry {
    user_id: String,
    project_id: String,
    expires_at: std::time::Instant,
}

struct WsTicketStore {
    tickets: HashMap<String, TicketEntry>,
}

static STORE: std::sync::OnceLock<Mutex<WsTicketStore>> = std::sync::OnceLock::new();

fn get_store() -> AppResult<&'static Mutex<WsTicketStore>> {
    STORE.get_or_init(|| {
        Mutex::new(WsTicketStore {
            tickets: HashMap::new(),
        })
    });
    Ok(STORE
        .get()
        .ok_or_else(|| AppError::Message("ws_ticket store".into()))?)
}

fn cleanup_expired(store: &mut WsTicketStore) {
    let now = std::time::Instant::now();
    store.tickets.retain(|_, v| v.expires_at > now);
}

pub fn issue_ws_ticket(user_id: &str, project_id: &str, ttl_seconds: u64) -> AppResult<String> {
    let ttl = ttl_seconds.max(1);
    let ticket = format!("wst_{}", uuid::Uuid::new_v4().simple());
    let expires_at = std::time::Instant::now() + std::time::Duration::from_secs(ttl);
    let mut guard = get_store()?
        .lock()
        .map_err(|e| AppError::Message(e.to_string()))?;
    cleanup_expired(&mut guard);
    guard.tickets.insert(
        ticket.clone(),
        TicketEntry {
            user_id: user_id.to_string(),
            project_id: project_id.to_string(),
            expires_at,
        },
    );
    Ok(ticket)
}

/// Consumes a short-lived WebSocket ticket exactly once and only for the
/// project it was minted for.
pub fn consume_ws_ticket(ticket: &str, project_id: &str) -> AppResult<Option<String>> {
    if ticket.is_empty() {
        return Ok(None);
    }
    let mut guard = get_store()?
        .lock()
        .map_err(|e| AppError::Message(e.to_string()))?;
    cleanup_expired(&mut guard);
    let entry = match guard.tickets.remove(ticket) {
        Some(e) => e,
        None => return Ok(None),
    };
    if entry.expires_at < std::time::Instant::now() {
        return Ok(None);
    }
    if entry.project_id != project_id {
        return Ok(None);
    }
    Ok(Some(entry.user_id))
}

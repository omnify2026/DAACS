use infra_error::{AppError, AppResult};

use crate::domain::blueprint::AgentBlueprint;
use crate::domain::repository::upsert_system_blueprint;
use crate::domain::ui_profile::UiProfile;

const SYSTEM_USER_ID: &str = "system";
const SYSTEM_EMAIL: &str = "system@daacs.local";
const CORE_BUILTIN_BLUEPRINT_IDS: [&str; 3] =
    ["builtin-pm", "builtin-reviewer", "builtin-verifier"];

pub async fn seed_builtin_blueprints(pool: &sqlx::SqlitePool) -> AppResult<()> {
    sqlx::query(
        r#"
        INSERT OR IGNORE INTO users (id, email, hashed_password, plan, billing_track)
        VALUES (?, ?, '!', 'system', 'system')
        "#,
    )
    .bind(SYSTEM_USER_ID)
    .bind(SYSTEM_EMAIL)
    .execute(pool)
    .await
    .map_err(|e| AppError::Message(e.to_string()))?;

    sqlx::query(
        r#"
        DELETE FROM agent_blueprints
        WHERE is_builtin = 1
          AND owner_user_id = ?
          AND id NOT IN (?, ?, ?)
        "#,
    )
    .bind(SYSTEM_USER_ID)
    .bind(CORE_BUILTIN_BLUEPRINT_IDS[0])
    .bind(CORE_BUILTIN_BLUEPRINT_IDS[1])
    .bind(CORE_BUILTIN_BLUEPRINT_IDS[2])
    .execute(pool)
    .await
    .map_err(|e| AppError::Message(e.to_string()))?;

    for blueprint in builtin_blueprints() {
        upsert_system_blueprint(pool, &blueprint).await?;
    }

    Ok(())
}

fn builtin_blueprints() -> Vec<AgentBlueprint> {
    vec![
        builtin_blueprint(
            "builtin-pm",
            "PM",
            "pm",
            "#6366F1",
            "ClipboardList",
            "meeting_room",
            "executive_team",
            8,
            vec!["planning", "coordination", "delivery"],
            vec!["kanban", "timeline", "review"],
            vec!["logs"],
        ),
        builtin_blueprint(
            "builtin-reviewer",
            "Reviewer",
            "reviewer",
            "#F59E0B",
            "ShieldCheck",
            "review_room",
            "quality_team",
            7,
            vec!["review", "regression_detection", "quality_gate"],
            vec!["review", "timeline", "logs"],
            vec!["approval"],
        ),
        builtin_blueprint(
            "builtin-verifier",
            "Verifier",
            "verifier",
            "#F97316",
            "BadgeCheck",
            "verification_lab",
            "quality_team",
            7,
            vec!["verification", "evidence", "runtime_checks"],
            vec!["logs", "timeline", "review"],
            vec!["logs"],
        ),
    ]
}

fn builtin_blueprint(
    id: &str,
    name: &str,
    role_label: &str,
    accent_color: &str,
    icon: &str,
    home_zone: &str,
    team_affinity: &str,
    authority_level: u8,
    capabilities: Vec<&str>,
    primary_widgets: Vec<&str>,
    secondary_widgets: Vec<&str>,
) -> AgentBlueprint {
    AgentBlueprint {
        id: id.to_string(),
        name: name.to_string(),
        role_label: role_label.to_string(),
        capabilities: capabilities.into_iter().map(str::to_string).collect(),
        prompt_bundle_ref: Some(format!("agent_{}", role_label)),
        skill_bundle_refs: vec![bundle_role_for(role_label).to_string()],
        tool_policy: serde_json::json!({ "default": true }),
        permission_policy: serde_json::json!({ "mode": "standard" }),
        memory_policy: serde_json::json!({ "mode": "shared" }),
        collaboration_policy: serde_json::json!({ "handoff": "standard" }),
        approval_policy: serde_json::json!({ "required": authority_level >= 8 }),
        ui_profile: UiProfile {
            display_name: name.to_string(),
            title: name.to_string(),
            avatar_style: "pixel".to_string(),
            accent_color: accent_color.to_string(),
            icon: icon.to_string(),
            home_zone: home_zone.to_string(),
            team_affinity: team_affinity.to_string(),
            authority_level,
            capability_tags: vec![role_label.to_string()],
            primary_widgets: primary_widgets.into_iter().map(str::to_string).collect(),
            secondary_widgets: secondary_widgets.into_iter().map(str::to_string).collect(),
            focus_mode: "default".to_string(),
            meeting_behavior: "standard".to_string(),
        },
        is_builtin: true,
        owner_user_id: SYSTEM_USER_ID.to_string(),
        created_at: String::new(),
        updated_at: String::new(),
    }
}

fn bundle_role_for(role_label: &str) -> &str {
    match role_label {
        "pm" => "pm",
        "reviewer" => "reviewer",
        "verifier" => "verifier",
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::{builtin_blueprints, seed_builtin_blueprints};
    use sqlx::sqlite::SqlitePoolOptions;
    use uuid::Uuid;

    #[test]
    fn builtin_blueprints_are_limited_to_core_agents() {
        let roles: Vec<_> = builtin_blueprints()
            .into_iter()
            .map(|blueprint| blueprint.role_label)
            .collect();

        assert_eq!(roles, vec!["pm", "reviewer", "verifier"]);
    }

    #[tokio::test]
    async fn seed_builtin_blueprints_removes_legacy_system_defaults() {
        let database_url = format!("sqlite:file:{}?mode=memory&cache=shared", Uuid::new_v4());
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&database_url)
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();

        sqlx::query(
            r#"
            INSERT INTO users (id, email, hashed_password, plan, billing_track)
            VALUES ('system', 'system@daacs.local', '!', 'system', 'system')
            "#,
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            r#"
            INSERT INTO agent_blueprints (
                id, name, role_label, capabilities, prompt_bundle_ref, skill_bundle_refs,
                tool_policy, permission_policy, memory_policy, collaboration_policy,
                approval_policy, ui_profile, is_builtin, owner_user_id
            ) VALUES (
                'builtin-developer-front', 'Frontend Developer', 'developer_front', '[]',
                'agent_frontend', '[]', '{}', '{}', '{}', '{}', '{}', '{}', 1, 'system'
            )
            "#,
        )
        .execute(&pool)
        .await
        .unwrap();

        seed_builtin_blueprints(&pool).await.unwrap();
        let roles: Vec<String> = sqlx::query_scalar(
            "SELECT role_label FROM agent_blueprints WHERE is_builtin = 1 ORDER BY role_label ASC",
        )
        .fetch_all(&pool)
        .await
        .unwrap();

        assert_eq!(roles, vec!["pm", "reviewer", "verifier"]);
    }
}

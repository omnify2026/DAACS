#![allow(dead_code)]

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct WidgetGroup {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub widgets: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct DashboardSchema {
    #[serde(default)]
    pub summary: serde_json::Value,
    #[serde(default)]
    pub widget_groups: Vec<WidgetGroup>,
    #[serde(default)]
    pub priority_panels: Vec<String>,
    #[serde(default)]
    pub actions: Vec<String>,
    #[serde(default)]
    pub alerts: Vec<String>,
    #[serde(default)]
    pub logs: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct UiProfile {
    #[serde(default)]
    pub display_name: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub avatar_style: String,
    #[serde(default)]
    pub accent_color: String,
    #[serde(default)]
    pub icon: String,
    #[serde(default)]
    pub home_zone: String,
    #[serde(default)]
    pub team_affinity: String,
    #[serde(default)]
    pub authority_level: u8,
    #[serde(default)]
    pub capability_tags: Vec<String>,
    #[serde(default)]
    pub primary_widgets: Vec<String>,
    #[serde(default)]
    pub secondary_widgets: Vec<String>,
    #[serde(default)]
    pub focus_mode: String,
    #[serde(default)]
    pub meeting_behavior: String,
}

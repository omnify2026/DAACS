CREATE TABLE IF NOT EXISTS agent_blueprints (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    role_label TEXT NOT NULL,
    capabilities TEXT NOT NULL DEFAULT '[]',
    prompt_bundle_ref TEXT NULL,
    skill_bundle_refs TEXT NOT NULL DEFAULT '[]',
    tool_policy TEXT NOT NULL DEFAULT '{}',
    permission_policy TEXT NOT NULL DEFAULT '{}',
    memory_policy TEXT NOT NULL DEFAULT '{}',
    collaboration_policy TEXT NOT NULL DEFAULT '{}',
    approval_policy TEXT NOT NULL DEFAULT '{}',
    ui_profile TEXT NOT NULL DEFAULT '{}',
    is_builtin INTEGER NOT NULL DEFAULT 0,
    owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agent_instances (
    instance_id TEXT PRIMARY KEY NOT NULL,
    blueprint_id TEXT NOT NULL REFERENCES agent_blueprints(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    runtime_status TEXT NOT NULL DEFAULT 'idle',
    assigned_team TEXT NULL,
    current_tasks TEXT NOT NULL DEFAULT '[]',
    context_window_state TEXT NOT NULL DEFAULT '{}',
    memory_bindings TEXT NOT NULL DEFAULT '{}',
    live_metrics TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS company_runtimes (
    runtime_id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
    company_name TEXT NOT NULL,
    org_graph TEXT NOT NULL DEFAULT '{}',
    agent_instance_ids TEXT NOT NULL DEFAULT '[]',
    meeting_protocol TEXT NOT NULL DEFAULT '{}',
    approval_graph TEXT NOT NULL DEFAULT '{}',
    shared_boards TEXT NOT NULL DEFAULT '{}',
    execution_mode TEXT NOT NULL DEFAULT 'assisted',
    owner_ops_state TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS execution_plans (
    plan_id TEXT PRIMARY KEY NOT NULL,
    runtime_id TEXT NOT NULL REFERENCES company_runtimes(runtime_id) ON DELETE CASCADE,
    goal TEXT NOT NULL,
    created_by TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS execution_steps (
    step_id TEXT PRIMARY KEY NOT NULL,
    plan_id TEXT NOT NULL REFERENCES execution_plans(plan_id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    description TEXT NOT NULL,
    assigned_to TEXT NULL,
    depends_on TEXT NOT NULL DEFAULT '[]',
    approval_required_by TEXT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    input TEXT NOT NULL DEFAULT '{}',
    output TEXT NOT NULL DEFAULT '{}',
    started_at TEXT NULL,
    completed_at TEXT NULL
);

CREATE INDEX IF NOT EXISTS ix_agent_blueprints_owner_user_id ON agent_blueprints(owner_user_id);
CREATE INDEX IF NOT EXISTS ix_agent_blueprints_role_label ON agent_blueprints(role_label);
CREATE INDEX IF NOT EXISTS ix_agent_instances_blueprint_id ON agent_instances(blueprint_id);
CREATE INDEX IF NOT EXISTS ix_agent_instances_project_id ON agent_instances(project_id);
CREATE INDEX IF NOT EXISTS ix_company_runtimes_project_id ON company_runtimes(project_id);
CREATE INDEX IF NOT EXISTS ix_execution_plans_runtime_id ON execution_plans(runtime_id);
CREATE INDEX IF NOT EXISTS ix_execution_steps_plan_id ON execution_steps(plan_id);

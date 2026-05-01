CREATE TABLE IF NOT EXISTS execution_intents (
    intent_id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    runtime_id TEXT NULL REFERENCES company_runtimes(runtime_id) ON DELETE CASCADE,
    created_by TEXT NULL,
    agent_id TEXT NOT NULL,
    agent_role TEXT NOT NULL,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    target TEXT NOT NULL,
    connector_id TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    result_payload TEXT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    requires_approval INTEGER NOT NULL DEFAULT 1,
    note TEXT NULL,
    result_summary TEXT NULL,
    approved_at TEXT NULL,
    resolved_at TEXT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_execution_intents_project_created
    ON execution_intents(project_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_execution_intents_project_status
    ON execution_intents(project_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_execution_intents_agent
    ON execution_intents(project_id, agent_id, created_at DESC);

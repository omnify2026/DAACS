ALTER TABLE execution_plans
    ADD COLUMN workflow_name TEXT NOT NULL DEFAULT 'feature_development';

CREATE TABLE IF NOT EXISTS overnight_runs (
    run_id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    task_id TEXT NOT NULL,
    workflow_name TEXT NOT NULL DEFAULT 'feature_development',
    goal TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    overnight_config TEXT NOT NULL DEFAULT '{}',
    steps TEXT NOT NULL DEFAULT '[]',
    spent_usd REAL NOT NULL DEFAULT 0,
    deadline_at TEXT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS ix_overnight_runs_task_id ON overnight_runs(task_id);
CREATE INDEX IF NOT EXISTS ix_overnight_runs_project_id ON overnight_runs(project_id);
CREATE INDEX IF NOT EXISTS ix_overnight_runs_project_status ON overnight_runs(project_id, status);

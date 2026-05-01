CREATE TABLE execution_events (
    event_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    runtime_id TEXT NOT NULL,
    plan_id TEXT,
    step_id TEXT,
    actor_id TEXT,
    event_type TEXT NOT NULL,
    sequence_no INTEGER NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    timestamp_ms INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY(runtime_id) REFERENCES company_runtimes(runtime_id) ON DELETE CASCADE,
    FOREIGN KEY(plan_id) REFERENCES execution_plans(plan_id) ON DELETE CASCADE,
    FOREIGN KEY(step_id) REFERENCES execution_steps(step_id) ON DELETE CASCADE,
    UNIQUE(project_id, sequence_no)
);

CREATE INDEX idx_execution_events_project_sequence
    ON execution_events(project_id, sequence_no);

CREATE INDEX idx_execution_events_plan_sequence
    ON execution_events(plan_id, sequence_no);

CREATE INDEX idx_execution_events_runtime_sequence
    ON execution_events(runtime_id, sequence_no);

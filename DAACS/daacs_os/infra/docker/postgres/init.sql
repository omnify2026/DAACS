-- ===== DAACS OS — PostgreSQL Initial Schema =====
-- Auto-executed on first container start

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ===== Core Tables =====

CREATE TABLE projects (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    goal TEXT,
    status VARCHAR(50) DEFAULT 'created',
    config JSONB DEFAULT '{}',
    workspace_path TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE agents (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
    role VARCHAR(50) NOT NULL,
    status VARCHAR(50) DEFAULT 'idle',
    current_task TEXT,
    message TEXT,
    position JSONB DEFAULT '{"x": 0, "y": 0}',
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE tasks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
    agent_role VARCHAR(50),
    parent_task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
    description TEXT NOT NULL,
    status VARCHAR(50) DEFAULT 'pending',
    priority INTEGER DEFAULT 0,
    dependencies UUID[] DEFAULT '{}',
    result JSONB,
    started_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE cost_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
    agent_role VARCHAR(50),
    model VARCHAR(100) NOT NULL,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    cost_usd DECIMAL(10,6) DEFAULT 0,
    task_complexity VARCHAR(50),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE workflow_runs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
    workflow_name VARCHAR(100) NOT NULL,
    status VARCHAR(50) DEFAULT 'running',
    current_step INTEGER DEFAULT 0,
    total_steps INTEGER DEFAULT 0,
    steps JSONB DEFAULT '[]',
    started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    completed_at TIMESTAMP WITH TIME ZONE
);

CREATE TABLE workflow_checkpoints (
    thread_id VARCHAR(255) PRIMARY KEY,
    checkpoint BYTEA,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE commands (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
    agent_role VARCHAR(50) NOT NULL,
    message TEXT NOT NULL,
    status VARCHAR(50) DEFAULT 'pending',
    response TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    completed_at TIMESTAMP WITH TIME ZONE
);

CREATE TABLE file_locks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
    file_path TEXT NOT NULL,
    lock_type VARCHAR(10) NOT NULL,  -- 'read' or 'write'
    agent_role VARCHAR(50) NOT NULL,
    acquired_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    expires_at TIMESTAMP WITH TIME ZONE,
    UNIQUE(project_id, file_path, lock_type, agent_role)
);

-- ===== Indexes =====

CREATE INDEX idx_agents_project ON agents(project_id);
CREATE INDEX idx_agents_role ON agents(role);
CREATE INDEX idx_agents_status ON agents(status);

CREATE INDEX idx_tasks_project ON tasks(project_id);
CREATE INDEX idx_tasks_agent ON tasks(agent_role);
CREATE INDEX idx_tasks_status ON tasks(status);

CREATE INDEX idx_cost_log_project ON cost_log(project_id);
CREATE INDEX idx_cost_log_created ON cost_log(created_at);
CREATE INDEX idx_cost_log_agent ON cost_log(agent_role);

CREATE INDEX idx_workflow_runs_project ON workflow_runs(project_id);
CREATE INDEX idx_workflow_runs_status ON workflow_runs(status);

CREATE INDEX idx_commands_project ON commands(project_id);
CREATE INDEX idx_commands_agent ON commands(agent_role);

CREATE INDEX idx_file_locks_project ON file_locks(project_id);
CREATE INDEX idx_file_locks_file ON file_locks(file_path);

-- ===== Functions =====

-- Auto-update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_projects_updated
    BEFORE UPDATE ON projects
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trigger_agents_updated
    BEFORE UPDATE ON agents
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trigger_checkpoints_updated
    BEFORE UPDATE ON workflow_checkpoints
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ===== Daily Spend Cap View =====

CREATE VIEW daily_spend AS
SELECT
    DATE(created_at) as spend_date,
    project_id,
    agent_role,
    SUM(cost_usd) as total_cost,
    SUM(input_tokens) as total_input_tokens,
    SUM(output_tokens) as total_output_tokens,
    COUNT(*) as api_calls
FROM cost_log
GROUP BY DATE(created_at), project_id, agent_role;

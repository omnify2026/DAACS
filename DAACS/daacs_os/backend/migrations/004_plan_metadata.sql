ALTER TABLE execution_plans
    ADD COLUMN planner_version TEXT NOT NULL DEFAULT 'pm_planner_v1';

ALTER TABLE execution_plans
    ADD COLUMN planning_mode TEXT NOT NULL DEFAULT 'sequential';

ALTER TABLE execution_plans
    ADD COLUMN plan_rationale TEXT NOT NULL DEFAULT '';

ALTER TABLE execution_plans
    ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;

ALTER TABLE execution_steps
    ADD COLUMN required_capabilities TEXT NOT NULL DEFAULT '[]';

ALTER TABLE execution_steps
    ADD COLUMN selection_reason TEXT;

ALTER TABLE execution_steps
    ADD COLUMN approval_reason TEXT;

ALTER TABLE execution_steps
    ADD COLUMN planner_notes TEXT;

ALTER TABLE execution_steps
    ADD COLUMN parallel_group TEXT;

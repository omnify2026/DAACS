"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const agentHandoff_1 = require("./agentHandoff");
function assert(condition, message) {
    if (!condition) {
        throw new Error(message);
    }
}
const runtimeBundle = {
    runtime: {
        runtime_id: "runtime-1",
        project_id: "project-1",
        company_name: "DAACS",
        org_graph: {},
        agent_instance_ids: ["inst-back", "inst-review"],
        meeting_protocol: {},
        approval_graph: {},
        shared_boards: {},
        execution_mode: "manual",
        owner_ops_state: {},
        created_at: "",
        updated_at: "",
    },
    instances: [
        {
            instance_id: "inst-back",
            blueprint_id: "bp-back",
            project_id: "project-1",
            runtime_status: "idle",
            assigned_team: "development_team",
            current_tasks: [],
            context_window_state: {},
            memory_bindings: {},
            live_metrics: {},
            created_at: "",
            updated_at: "",
        },
        {
            instance_id: "inst-review",
            blueprint_id: "bp-review",
            project_id: "project-1",
            runtime_status: "idle",
            assigned_team: "review_team",
            current_tasks: [],
            context_window_state: {},
            memory_bindings: {},
            live_metrics: {},
            created_at: "",
            updated_at: "",
        },
    ],
    blueprints: [
        {
            id: "bp-back",
            name: "Backend Engineer",
            role_label: "developer_back",
            capabilities: ["api"],
            prompt_bundle_ref: null,
            skill_bundle_refs: ["backend"],
            tool_policy: {},
            permission_policy: {},
            memory_policy: {},
            collaboration_policy: {},
            approval_policy: {},
            ui_profile: {
                display_name: "Backend",
                title: "Backend Engineer",
                avatar_style: "pixel",
                accent_color: "#fff",
                icon: "Code",
                home_zone: "rd_lab",
                team_affinity: "development_team",
                authority_level: 50,
                capability_tags: ["api"],
                primary_widgets: [],
                secondary_widgets: [],
                focus_mode: "default",
                meeting_behavior: "standard",
            },
            is_builtin: false,
            owner_user_id: "user-1",
            created_at: "",
            updated_at: "",
        },
        {
            id: "bp-review",
            name: "Reviewer",
            role_label: "reviewer",
            capabilities: ["review"],
            prompt_bundle_ref: null,
            skill_bundle_refs: ["reviewer"],
            tool_policy: {},
            permission_policy: {},
            memory_policy: {},
            collaboration_policy: {},
            approval_policy: {},
            ui_profile: {
                display_name: "Reviewer",
                title: "Reviewer",
                avatar_style: "pixel",
                accent_color: "#fff",
                icon: "Search",
                home_zone: "meeting_room",
                team_affinity: "review_team",
                authority_level: 60,
                capability_tags: ["review"],
                primary_widgets: [],
                secondary_widgets: [],
                focus_mode: "default",
                meeting_behavior: "standard",
            },
            is_builtin: false,
            owner_user_id: "user-1",
            created_at: "",
            updated_at: "",
        },
    ],
};
const completedStep = {
    step_id: "step-1",
    label: "Implement API",
    description: "Build the payment endpoint",
    assigned_to: "inst-back",
    depends_on: [],
    approval_required_by: null,
    status: "completed",
    input: {},
    output: {},
    started_at: null,
    completed_at: null,
};
const nextStep = {
    step_id: "step-2",
    label: "Review API",
    description: "Review the backend implementation",
    assigned_to: "inst-review",
    depends_on: ["step-1"],
    approval_required_by: null,
    status: "pending",
    input: {},
    output: {},
    started_at: null,
    completed_at: null,
};
const handoff = (0, agentHandoff_1.handoffToNextAgent)(runtimeBundle, completedStep, nextStep, "Payment endpoint is ready for review.");
assert(handoff.type === "review_request", "review step should create review_request handoff");
assert(handoff.from_agent_id === "inst-back", "handoff should preserve source instance");
assert(handoff.to_agent_id === "inst-review", "handoff should preserve target instance");
const merged = (0, agentHandoff_1.attachHandoffsToInput)({ draft: true }, [handoff]);
assert(Array.isArray(merged.handoff_messages), "handoff messages should be attached to input");
assert(merged.handoff_messages?.length === 1, "exactly one handoff should be attached");
console.log("agentHandoff tests passed");

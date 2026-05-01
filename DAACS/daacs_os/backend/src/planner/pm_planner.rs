use infra_error::AppResult;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::domain::{
    blueprint::AgentBlueprint,
    execution::{ExecutionPlan, ExecutionStep, PlanStatus, StepStatus},
    instance::AgentInstance,
    runtime::CompanyRuntime,
};

const PLANNER_VERSION: &str = "pm_planner_v2";
const PLANNING_MODE: &str = "dynamic_graph";

pub struct PmPlanner;

impl PmPlanner {
    pub fn new() -> Self {
        Self
    }

    pub async fn plan(
        &self,
        goal: &str,
        runtime: &CompanyRuntime,
        instances: &[AgentInstance],
        blueprints: &[AgentBlueprint],
    ) -> AppResult<ExecutionPlan> {
        let pm_instance = select_pm_instance(instances, blueprints);
        let execution_instance = select_execution_instance(instances, blueprints, pm_instance);
        let approval_instance = select_approval_instance(instances, blueprints);

        let is_ko = is_korean_text(goal);

        // TODO(track-b): restore server-side LLM planning once production orchestration is ready.
        let planning_notes = if is_ko {
            format!(
                "로컬 계획 트랙이 목표 기반 동적 플랜을 준비했습니다. 목표: '{}', 사용 에이전트: {}.",
                goal,
                summarize_agents(instances, blueprints)
            )
        } else {
            format!(
                "Local CLI planning track prepared a goal-driven dynamic plan for '{goal}' with agents: {}.",
                summarize_agents(instances, blueprints)
            )
        };

        let plan_id = Uuid::new_v4().to_string();
        let discovery_step_id = Uuid::new_v4().to_string();
        let workspace_step_id = Uuid::new_v4().to_string();
        let frontend_step_id = Uuid::new_v4().to_string();
        let backend_step_id = Uuid::new_v4().to_string();
        let review_step_id = Uuid::new_v4().to_string();
        let verification_step_id = Uuid::new_v4().to_string();
        let approval_step_id = Uuid::new_v4().to_string();

        let frontend_instance = select_frontend_instance(instances, blueprints, pm_instance);
        let backend_instance = select_backend_instance(instances, blueprints, pm_instance);
        let reviewer_instance = select_reviewer_instance(instances, blueprints);
        let verifier_instance = select_verifier_instance(instances, blueprints);

        let goal_features = detect_goal_features(goal);
        let wants_workspace = goal_features.wants_workspace;
        let wants_frontend = goal_features.wants_frontend;
        let wants_backend = goal_features.wants_backend;
        let wants_review = goal_features.wants_review;
        let wants_verification = goal_features.wants_verification;
        let wants_deepaudit = goal_features.wants_deepaudit;
        let wants_input_driven_decision = goal_features.wants_input_driven_decision;
        let wants_fresh_artifact_delivery = goal_features.wants_fresh_artifact_delivery;
        let quality_guardrails = build_quality_guardrails(goal, &goal_features, is_ko);
        let review_coverage = plan_review_coverage(
            reviewer_instance,
            approval_instance,
            blueprints,
            is_ko,
            wants_deepaudit,
        );
        let verification_coverage = plan_verification_coverage(
            verifier_instance,
            reviewer_instance,
            approval_instance,
            blueprints,
            is_ko,
            wants_deepaudit,
        );

        let discovery_selection_reason = selection_reason_for_instance(
            pm_instance,
            blueprints,
            if is_ko {
                "기획 및 범위 조율"
            } else {
                "planning and scope alignment"
            },
        );
        let execution_selection_reason = selection_reason_for_instance(
            execution_instance,
            blueprints,
            if is_ko {
                "핵심 목표 수행"
            } else {
                "core goal delivery"
            },
        );
        let approval_selection_reason = selection_reason_for_instance(
            approval_instance,
            blueprints,
            if is_ko {
                "최종 승인 권한"
            } else {
                "final approval authority"
            },
        );
        let plan_rationale = if is_ko {
            format!(
                "목표 '{}'는 목표 특징에 맞춰 동적으로 분해되었습니다. workspace 준비: {}, 프론트엔드: {}, 백엔드: {}, 리뷰: {}, 검증: {}, 새 산출물 생성: {}, 입력기반 선택/추천: {}, deepaudit: {}. 리뷰 커버리지: {}. 검증 커버리지: {}. 기획자 노트: {}",
                goal,
                wants_workspace,
                wants_frontend,
                wants_backend,
                wants_review,
                wants_verification,
                wants_fresh_artifact_delivery,
                wants_input_driven_decision,
                wants_deepaudit,
                review_coverage.rationale_fragment,
                verification_coverage.rationale_fragment,
                planning_notes
            )
        } else {
            format!(
                "Goal '{goal}' is decomposed dynamically by goal shape. workspace prep: {}, frontend: {}, backend: {}, review: {}, verification: {}, fresh artifact delivery: {}, input-driven decision: {}, deepaudit: {}. Review coverage: {}. Verification coverage: {}. Planner notes: {}",
                wants_workspace,
                wants_frontend,
                wants_backend,
                wants_review,
                wants_verification,
                wants_fresh_artifact_delivery,
                wants_input_driven_decision,
                wants_deepaudit,
                review_coverage.rationale_fragment,
                verification_coverage.rationale_fragment,
                planning_notes
            )
        };

        let discovery_label = if is_ko {
            "실행 범위 확인"
        } else {
            "Clarify execution scope"
        };

        let mut steps = vec![ExecutionStep {
            step_id: discovery_step_id.clone(),
            label: discovery_label.to_string(),
            description: if is_ko {
                "목표, 제약 조건 및 전달 목표에 대해 런타임의 방향을 조정합니다.".to_string()
            } else {
                "Align the company runtime on the goal, constraints, and delivery target."
                    .to_string()
            },
            assigned_to: pm_instance.map(|instance| instance.instance_id.clone()),
            depends_on: vec![],
            approval_required_by: None,
            status: StepStatus::Pending,
            required_capabilities: vec!["planning".to_string(), "goal_decomposition".to_string()],
            selection_reason: Some(discovery_selection_reason),
            approval_reason: None,
            planner_notes: Some(if is_ko {
                "첫 단계는 성공 기준, 산출물 기대치, 검증 기준을 명확히 합니다.".to_string()
            } else {
                "First step establishes success criteria, artifact expectations, and verification requirements."
                    .to_string()
            }),
            parallel_group: None,
            input: json!({
                "goal": goal,
                "runtime_id": runtime.runtime_id,
                "planning_notes": planning_notes,
                "goal_features": {
                    "workspace": wants_workspace,
                    "frontend": wants_frontend,
                    "backend": wants_backend,
                    "review": wants_review,
                    "verification": wants_verification,
                    "fresh_artifact_delivery": wants_fresh_artifact_delivery,
                    "input_driven_decision": wants_input_driven_decision,
                    "deepaudit": wants_deepaudit,
                },
                "quality_guardrails": quality_guardrails.clone(),
            }),
            output: json!({}),
            started_at: None,
            completed_at: None,
        }];

        let mut delivery_dependencies = vec![discovery_step_id.clone()];
        let mut artifact_step_ids: Vec<String> = Vec::new();

        if wants_workspace {
            steps.push(ExecutionStep {
                step_id: workspace_step_id.clone(),
                label: if is_ko {
                    "워크스페이스 및 실행 환경 준비".to_string()
                } else {
                    "Prepare workspace and execution environment".to_string()
                },
                description: if is_ko {
                    "산출물 제작과 검증에 필요한 workspace, preview, 실행 경로를 준비합니다.".to_string()
                } else {
                    "Prepare the workspace, preview path, and execution environment required for delivery and verification."
                        .to_string()
                },
                assigned_to: execution_instance.map(|instance| instance.instance_id.clone()),
                depends_on: vec![discovery_step_id.clone()],
                approval_required_by: None,
                status: StepStatus::Pending,
                required_capabilities: vec![
                    "workspace_management".to_string(),
                    "runtime_preparation".to_string(),
                ],
                selection_reason: Some(execution_selection_reason.clone()),
                approval_reason: None,
                planner_notes: Some(if is_ko {
                    "preview, 테스트, 산출물 저장 위치를 먼저 준비해 후속 품질 저하를 막습니다."
                        .to_string()
                } else {
                    "Prepare preview, test, and artifact paths first to avoid avoidable quality loss downstream."
                        .to_string()
                }),
                parallel_group: None,
                input: json!({
                    "goal": goal,
                    "workspace_required": true,
                }),
                output: json!({}),
                started_at: None,
                completed_at: None,
            });
            delivery_dependencies = vec![workspace_step_id.clone()];
        }

        if wants_frontend {
            let frontend_owner = frontend_instance.or(execution_instance);
            let frontend_capabilities = instance_capabilities_or_default(
                frontend_owner,
                blueprints,
                &["frontend_delivery", "ui_implementation", "preview_support"],
            );
            let frontend_selection_reason = selection_reason_for_instance(
                frontend_owner,
                blueprints,
                if is_ko {
                    "프론트엔드 및 사용자 경험 산출물"
                } else {
                    "frontend and user-experience delivery"
                },
            );
            if should_split_frontend_delivery(goal, &goal_features) {
                let frontend_slices =
                    frontend_delivery_slices(goal, is_ko, frontend_step_id.clone());
                let mut previous_dependencies = delivery_dependencies.clone();
                for slice_spec in frontend_slices {
                    let mut step_input = json!({
                        "goal": goal,
                        "artifact_type": "frontend",
                        "delivery_slice": slice_spec.slice,
                        "slice_contract": slice_spec.slice_contract,
                        "allowed_file_focus": slice_spec.allowed_file_focus,
                        "deferred_scope": slice_spec.deferred_scope,
                        "timeout_risk_policy": "bounded_frontend_slice",
                        "quality_guardrails": quality_guardrails.clone(),
                    });
                    if slice_spec.slice == "foundation_scaffold" || slice_spec.slice == "foundation"
                    {
                        step_input["required_scaffold_files"] =
                            json!(REQUIRED_FRONTEND_SCAFFOLD_FILES);
                    }
                    steps.push(ExecutionStep {
                        step_id: slice_spec.step_id.clone(),
                        label: slice_spec.label,
                        description: slice_spec.description,
                        assigned_to: frontend_owner.map(|instance| instance.instance_id.clone()),
                        depends_on: previous_dependencies.clone(),
                        approval_required_by: None,
                        status: StepStatus::Pending,
                        required_capabilities: frontend_capabilities.clone(),
                        selection_reason: Some(frontend_selection_reason.clone()),
                        approval_reason: None,
                        planner_notes: Some(slice_spec.planner_note),
                        parallel_group: None,
                        input: step_input,
                        output: json!({}),
                        started_at: None,
                        completed_at: None,
                    });
                    previous_dependencies = vec![slice_spec.step_id.clone()];
                    artifact_step_ids.push(slice_spec.step_id);
                }
            } else {
                steps.push(ExecutionStep {
                    step_id: frontend_step_id.clone(),
                    label: if is_ko {
                        "프론트엔드 산출물 제작".to_string()
                    } else {
                        "Produce frontend artifact".to_string()
                    },
                    description: if is_ko {
                        "UI, preview, 사용자 상호작용과 관련된 산출물을 제작합니다.".to_string()
                    } else {
                        "Produce the artifact related to UI, preview, and user-facing interaction.".to_string()
                    },
                    assigned_to: frontend_owner.map(|instance| instance.instance_id.clone()),
                    depends_on: delivery_dependencies.clone(),
                    approval_required_by: None,
                    status: StepStatus::Pending,
                    required_capabilities: frontend_capabilities,
                    selection_reason: Some(frontend_selection_reason),
                    approval_reason: None,
                    planner_notes: Some(if is_ko {
                        "사용자에게 보이는 결과물의 완성도와 미리보기 가능성을 높이는 단계입니다."
                            .to_string()
                    } else {
                        "This step raises the quality of the visible artifact and its previewability."
                            .to_string()
                    }),
                    parallel_group: if wants_backend {
                        Some("delivery".to_string())
                    } else {
                        None
                    },
                    input: json!({
                        "goal": goal,
                        "artifact_type": "frontend",
                        "quality_guardrails": quality_guardrails.clone(),
                    }),
                    output: json!({}),
                    started_at: None,
                    completed_at: None,
                });
                artifact_step_ids.push(frontend_step_id.clone());
            }
        }

        if wants_backend {
            steps.push(ExecutionStep {
                step_id: backend_step_id.clone(),
                label: if is_ko {
                    "백엔드 및 오케스트레이션 작업".to_string()
                } else {
                    "Produce backend and orchestration work".to_string()
                },
                description: if is_ko {
                    "workflow, API, 상태 관리, 실행 로직 등 핵심 동작을 구현합니다.".to_string()
                } else {
                    "Implement the core behavior such as workflow, API, state handling, and execution logic."
                        .to_string()
                },
                assigned_to: backend_instance
                    .or(execution_instance)
                    .map(|instance| instance.instance_id.clone()),
                depends_on: delivery_dependencies.clone(),
                approval_required_by: None,
                status: StepStatus::Pending,
                required_capabilities: instance_capabilities_or_default(
                    backend_instance.or(execution_instance),
                    blueprints,
                    &["backend_delivery", "workflow_logic", "system_integration"],
                ),
                selection_reason: Some(selection_reason_for_instance(
                    backend_instance.or(execution_instance),
                    blueprints,
                    if is_ko {
                        "백엔드 및 실행 로직 전달"
                    } else {
                        "backend and execution-logic delivery"
                    },
                )),
                approval_reason: None,
                planner_notes: Some(if is_ko {
                    "산출물 품질을 좌우하는 실제 동작과 데이터 흐름을 구현합니다.".to_string()
                } else {
                    "Implements the actual behavior and data flow that determines artifact quality."
                        .to_string()
                }),
                parallel_group: if wants_frontend {
                    Some("delivery".to_string())
                } else {
                    None
                },
                input: json!({
                    "goal": goal,
                    "artifact_type": "backend",
                    "quality_guardrails": quality_guardrails.clone(),
                }),
                output: json!({}),
                started_at: None,
                completed_at: None,
            });
            artifact_step_ids.push(backend_step_id.clone());
        }

        if artifact_step_ids.is_empty() {
            steps.push(ExecutionStep {
                step_id: backend_step_id.clone(),
                label: if is_ko {
                    "핵심 산출물 제작".to_string()
                } else {
                    "Produce core artifact".to_string()
                },
                description: if is_ko {
                    "목표를 달성하는 데 필요한 핵심 산출물을 생성합니다.".to_string()
                } else {
                    "Produce the primary artifact required to satisfy the goal.".to_string()
                },
                assigned_to: execution_instance.map(|instance| instance.instance_id.clone()),
                depends_on: delivery_dependencies.clone(),
                approval_required_by: None,
                status: StepStatus::Pending,
                required_capabilities: execution_capabilities_for_instance(execution_instance, blueprints),
                selection_reason: Some(execution_selection_reason.clone()),
                approval_reason: None,
                planner_notes: Some(if is_ko {
                    "명시적 프론트엔드/백엔드 신호가 없으므로 범용 전달 단계로 처리합니다.".to_string()
                } else {
                    "No explicit frontend/backend signal was found, so the planner uses a generic delivery step."
                        .to_string()
                }),
                parallel_group: None,
                input: json!({
                    "goal": goal,
                    "artifact_type": "general",
                    "quality_guardrails": quality_guardrails.clone(),
                }),
                output: json!({}),
                started_at: None,
                completed_at: None,
            });
            artifact_step_ids.push(backend_step_id.clone());
        }

        if wants_review {
            steps.push(ExecutionStep {
                step_id: review_step_id.clone(),
                label: if is_ko {
                    "산출물 리뷰".to_string()
                } else {
                    "Review artifact quality".to_string()
                },
                description: if is_ko {
                    "정확성, 회귀 위험, 누락된 요구사항을 검토합니다.".to_string()
                } else {
                    "Review correctness, regression risk, and missing requirements.".to_string()
                },
                assigned_to: reviewer_instance
                    .or(approval_instance)
                    .map(|instance| instance.instance_id.clone()),
                depends_on: artifact_step_ids.clone(),
                approval_required_by: None,
                status: StepStatus::Pending,
                required_capabilities: quality_review_capabilities(wants_input_driven_decision),
                selection_reason: Some(review_coverage.selection_reason.clone()),
                approval_reason: None,
                planner_notes: Some(review_coverage.planner_note.clone()),
                parallel_group: None,
                input: json!({
                    "goal": goal,
                    "review_scope": artifact_step_ids,
                    "requires_independent_reviewer": wants_deepaudit,
                    "requires_negative_adversarial_case": wants_input_driven_decision,
                    "review_coverage": review_coverage.rationale_fragment,
                    "quality_guardrails": quality_guardrails.clone(),
                }),
                output: json!({}),
                started_at: None,
                completed_at: None,
            });
        }

        if wants_verification {
            let mut verification_dependencies = artifact_step_ids.clone();
            if wants_review {
                verification_dependencies.push(review_step_id.clone());
            }
            steps.push(ExecutionStep {
                step_id: verification_step_id.clone(),
                label: if is_ko {
                    "실행 검증 및 미리보기 확인".to_string()
                } else {
                    "Verify execution and preview readiness".to_string()
                },
                description: if is_ko {
                    "빌드, 테스트, 런타임 smoke, preview 접근성을 검증합니다.".to_string()
                } else {
                    "Verify build, tests, runtime smoke checks, and preview accessibility."
                        .to_string()
                },
                assigned_to: verifier_instance
                    .or(reviewer_instance)
                    .or(approval_instance)
                    .map(|instance| instance.instance_id.clone()),
                depends_on: verification_dependencies,
                approval_required_by: None,
                status: StepStatus::Pending,
                required_capabilities: quality_verification_capabilities(
                    wants_input_driven_decision,
                ),
                selection_reason: Some(verification_coverage.selection_reason.clone()),
                approval_reason: None,
                planner_notes: Some(verification_coverage.planner_note.clone()),
                parallel_group: None,
                input: json!({
                    "goal": goal,
                    "verify_preview": goal_features.wants_preview,
                    "requires_independent_verifier": wants_deepaudit,
                    "requires_negative_adversarial_case": wants_input_driven_decision,
                    "verification_coverage": verification_coverage.rationale_fragment,
                    "quality_guardrails": quality_guardrails.clone(),
                }),
                output: json!({}),
                started_at: None,
                completed_at: None,
            });
        }

        let mut approval_dependencies = artifact_step_ids.clone();
        if wants_review {
            approval_dependencies.push(review_step_id.clone());
        }
        if wants_verification {
            approval_dependencies.push(verification_step_id.clone());
        }

        steps.push(ExecutionStep {
            step_id: approval_step_id,
            label: if is_ko {
                "결과물 승인"
            } else {
                "Approve delivery"
            }
            .to_string(),
            description: if is_ko {
                "생성된 결과물이 릴리스 가능한 수준인지 최종 승인합니다.".to_string()
            } else {
                "Provide final sign-off on whether the artifact is release-ready.".to_string()
            },
            assigned_to: approval_instance.map(|instance| instance.instance_id.clone()),
            depends_on: approval_dependencies,
            approval_required_by: approval_instance.map(|instance| instance.instance_id.clone()),
            status: StepStatus::Pending,
            required_capabilities: vec!["approval".to_string(), "sign_off".to_string()],
            selection_reason: Some(approval_selection_reason),
            approval_reason: Some(if is_ko {
                "최종 결과물은 릴리스 전 책임자의 승인 게이트를 통과해야 합니다.".to_string()
            } else {
                "The final artifact must pass an owner-level approval gate before release."
                    .to_string()
            }),
            planner_notes: Some(if is_ko {
                "승인은 discovery/delivery/review/verification의 누적 증거를 바탕으로 이뤄집니다."
                    .to_string()
            } else {
                "Approval is based on the accumulated evidence from discovery, delivery, review, and verification."
                    .to_string()
            }),
            parallel_group: None,
            input: json!({
                "goal": goal,
                "approval_mode": "owner_gate",
                "quality_guardrails": quality_guardrails,
            }),
            output: json!({}),
            started_at: None,
            completed_at: None,
        });

        Ok(ExecutionPlan {
            plan_id,
            runtime_id: runtime.runtime_id.clone(),
            workflow_name: "feature_development".to_string(),
            goal: goal.to_string(),
            created_by: pm_instance
                .map(|instance| instance.instance_id.clone())
                .unwrap_or_else(|| "pm-planner".to_string()),
            planner_version: PLANNER_VERSION.to_string(),
            planning_mode: PLANNING_MODE.to_string(),
            plan_rationale,
            revision: 1,
            steps,
            status: PlanStatus::Draft,
            created_at: String::new(),
            updated_at: String::new(),
        })
    }
}

fn select_pm_instance<'a>(
    instances: &'a [AgentInstance],
    blueprints: &'a [AgentBlueprint],
) -> Option<&'a AgentInstance> {
    select_instance_by_role(instances, blueprints, "pm")
        .or_else(|| select_highest_authority_instance(instances, blueprints))
}

fn select_execution_instance<'a>(
    instances: &'a [AgentInstance],
    blueprints: &'a [AgentBlueprint],
    pm_instance: Option<&'a AgentInstance>,
) -> Option<&'a AgentInstance> {
    instances
        .iter()
        .filter(|instance| {
            Some(instance.instance_id.as_str()) != pm_instance.map(|item| item.instance_id.as_str())
        })
        .find(|instance| {
            blueprint_for_instance(instance, blueprints)
                .map(|blueprint| {
                    blueprint.capabilities.iter().any(|capability| {
                        capability == "code_generation"
                            || capability == "research"
                            || capability == "design"
                    })
                })
                .unwrap_or(false)
        })
        .or_else(|| {
            instances.iter().find(|instance| {
                Some(instance.instance_id.as_str())
                    != pm_instance.map(|item| item.instance_id.as_str())
            })
        })
}

fn select_frontend_instance<'a>(
    instances: &'a [AgentInstance],
    blueprints: &'a [AgentBlueprint],
    pm_instance: Option<&'a AgentInstance>,
) -> Option<&'a AgentInstance> {
    select_instance_by_role(instances, blueprints, "frontend").or_else(|| {
        select_instance_by_capability(
            instances,
            blueprints,
            pm_instance,
            &["design", "ui", "frontend"],
        )
    })
}

fn select_backend_instance<'a>(
    instances: &'a [AgentInstance],
    blueprints: &'a [AgentBlueprint],
    pm_instance: Option<&'a AgentInstance>,
) -> Option<&'a AgentInstance> {
    select_instance_by_role(instances, blueprints, "backend").or_else(|| {
        select_instance_by_capability(
            instances,
            blueprints,
            pm_instance,
            &["code_generation", "api", "backend", "delivery"],
        )
    })
}

fn select_reviewer_instance<'a>(
    instances: &'a [AgentInstance],
    blueprints: &'a [AgentBlueprint],
) -> Option<&'a AgentInstance> {
    select_instance_by_role(instances, blueprints, "reviewer")
}

fn select_verifier_instance<'a>(
    instances: &'a [AgentInstance],
    blueprints: &'a [AgentBlueprint],
) -> Option<&'a AgentInstance> {
    select_instance_by_role(instances, blueprints, "verifier")
        .or_else(|| select_instance_by_role(instances, blueprints, "qa"))
}

fn select_approval_instance<'a>(
    instances: &'a [AgentInstance],
    blueprints: &'a [AgentBlueprint],
) -> Option<&'a AgentInstance> {
    select_instance_by_role(instances, blueprints, "ceo")
        .or_else(|| select_highest_authority_instance(instances, blueprints))
}

fn select_instance_by_role<'a>(
    instances: &'a [AgentInstance],
    blueprints: &'a [AgentBlueprint],
    role_label: &str,
) -> Option<&'a AgentInstance> {
    instances.iter().find(|instance| {
        blueprint_for_instance(instance, blueprints)
            .map(|blueprint| blueprint.role_label == role_label)
            .unwrap_or(false)
    })
}

fn select_instance_by_capability<'a>(
    instances: &'a [AgentInstance],
    blueprints: &'a [AgentBlueprint],
    excluded_instance: Option<&'a AgentInstance>,
    capability_needles: &[&str],
) -> Option<&'a AgentInstance> {
    instances
        .iter()
        .filter(|instance| {
            Some(instance.instance_id.as_str())
                != excluded_instance.map(|item| item.instance_id.as_str())
        })
        .find(|instance| {
            blueprint_for_instance(instance, blueprints)
                .map(|blueprint| {
                    blueprint.capabilities.iter().any(|capability| {
                        let normalized = capability.to_lowercase();
                        capability_needles
                            .iter()
                            .any(|needle| normalized.contains(&needle.to_lowercase()))
                    })
                })
                .unwrap_or(false)
        })
}

fn select_highest_authority_instance<'a>(
    instances: &'a [AgentInstance],
    blueprints: &'a [AgentBlueprint],
) -> Option<&'a AgentInstance> {
    instances.iter().max_by_key(|instance| {
        blueprint_for_instance(instance, blueprints)
            .map(|blueprint| blueprint.ui_profile.authority_level)
            .unwrap_or_default()
    })
}

fn blueprint_for_instance<'a>(
    instance: &AgentInstance,
    blueprints: &'a [AgentBlueprint],
) -> Option<&'a AgentBlueprint> {
    blueprints
        .iter()
        .find(|blueprint| blueprint.id == instance.blueprint_id)
}

fn summarize_agents(instances: &[AgentInstance], blueprints: &[AgentBlueprint]) -> String {
    instances
        .iter()
        .map(|instance| {
            let blueprint = blueprint_for_instance(instance, blueprints);
            let role_label = blueprint
                .map(|item| item.role_label.as_str())
                .unwrap_or("unknown");
            let capabilities = blueprint
                .map(|item| item.capabilities.join(", "))
                .unwrap_or_default();
            format!(
                "{} [{}] ({})",
                instance.instance_id, role_label, capabilities
            )
        })
        .collect::<Vec<_>>()
        .join("; ")
}

fn selection_reason_for_instance(
    instance: Option<&AgentInstance>,
    blueprints: &[AgentBlueprint],
    purpose: &str,
) -> String {
    match instance.and_then(|candidate| blueprint_for_instance(candidate, blueprints)) {
        Some(blueprint) => format!(
            "Selected '{}' because its role '{}' and capabilities [{}] fit {}.",
            blueprint.name,
            blueprint.role_label,
            blueprint.capabilities.join(", "),
            purpose,
        ),
        None => format!(
            "No dedicated agent matched {}; fallback execution will be used.",
            purpose
        ),
    }
}

struct RoleCoverage {
    selection_reason: String,
    planner_note: String,
    rationale_fragment: String,
}

fn plan_review_coverage(
    reviewer_instance: Option<&AgentInstance>,
    approval_instance: Option<&AgentInstance>,
    blueprints: &[AgentBlueprint],
    is_ko: bool,
    wants_deepaudit: bool,
) -> RoleCoverage {
    if let Some(reviewer) = reviewer_instance {
        let reviewer_label = agent_reference(reviewer, blueprints);
        return RoleCoverage {
            selection_reason: if is_ko {
                format!(
                    "{}가 전용 reviewer 역할로 산출물 품질 검토를 담당합니다.",
                    reviewer_label
                )
            } else {
                format!(
                    "{} is assigned as the dedicated reviewer for artifact quality review.",
                    reviewer_label
                )
            },
            planner_note: if is_ko {
                if wants_deepaudit {
                    "deepaudit 의도에 맞춰 구현 담당과 reviewer 역할을 분리해 독립 검토를 유지합니다."
                        .to_string()
                } else {
                    "구현 직후 리뷰를 분리해 산출물 수준 저하를 조기에 걸러냅니다.".to_string()
                }
            } else if wants_deepaudit {
                "Deepaudit intent keeps reviewer work separate from implementation so the audit remains independent."
                    .to_string()
            } else {
                "Separate review after delivery catches quality regressions before final sign-off."
                    .to_string()
            },
            rationale_fragment: if is_ko {
                format!("전용 reviewer 확보 ({})", reviewer_label)
            } else {
                format!("dedicated reviewer available ({})", reviewer_label)
            },
        };
    }

    if let Some(approver) = approval_instance {
        let approver_label = agent_reference(approver, blueprints);
        return RoleCoverage {
            selection_reason: if is_ko {
                format!(
                    "전용 reviewer 인스턴스가 없어 {}가 review 단계를 대체 수행합니다.",
                    approver_label
                )
            } else {
                format!(
                    "No dedicated reviewer instance is available, so {} will cover the review step as a fallback.",
                    approver_label
                )
            },
            planner_note: if is_ko {
                if wants_deepaudit {
                    "deepaudit 이 요청한 독립 reviewer 가 부재합니다. 계획은 유지하되 approver 대체 경로를 명시합니다."
                        .to_string()
                } else {
                    "전용 reviewer 가 없어 approver 가 review 를 겸임합니다.".to_string()
                }
            } else if wants_deepaudit {
                "The independent reviewer requested by deepaudit is unavailable. The plan stays explicit about the fallback to the approver."
                    .to_string()
            } else {
                "No dedicated reviewer is available, so the approver will also perform review."
                    .to_string()
            },
            rationale_fragment: if is_ko {
                format!("전용 reviewer 없음 -> approver 대체 ({})", approver_label)
            } else {
                format!(
                    "no dedicated reviewer -> approver fallback ({})",
                    approver_label
                )
            },
        };
    }

    RoleCoverage {
        selection_reason: if is_ko {
            "전용 reviewer 와 approver 인스턴스가 모두 없어 review 역할 배정을 확정하지 못했습니다."
                .to_string()
        } else {
            "No dedicated reviewer or approver instance is available, so the review assignment remains unresolved."
                .to_string()
        },
        planner_note: if is_ko {
            if wants_deepaudit {
                "deepaudit 이 요구한 독립 reviewer 역할을 충족할 인스턴스가 없습니다. 후속 오케스트레이션에서 review 책임자 확보가 필요합니다."
                    .to_string()
            } else {
                "review 단계를 수행할 명시 인스턴스가 없어 후속 오케스트레이션 확인이 필요합니다."
                    .to_string()
            }
        } else if wants_deepaudit {
            "No instance can satisfy the independent reviewer role requested by deepaudit. Follow-on orchestration must provide review ownership."
                .to_string()
        } else {
            "No explicit instance is available to perform review, so follow-on orchestration must supply ownership."
                .to_string()
        },
        rationale_fragment: if is_ko {
            "reviewer/approver 부재".to_string()
        } else {
            "reviewer/approver unavailable".to_string()
        },
    }
}

fn plan_verification_coverage(
    verifier_instance: Option<&AgentInstance>,
    reviewer_instance: Option<&AgentInstance>,
    approval_instance: Option<&AgentInstance>,
    blueprints: &[AgentBlueprint],
    is_ko: bool,
    wants_deepaudit: bool,
) -> RoleCoverage {
    if let Some(verifier) = verifier_instance {
        let verifier_label = agent_reference(verifier, blueprints);
        return RoleCoverage {
            selection_reason: if is_ko {
                format!(
                    "{}가 전용 verifier 역할로 실행 검증과 preview 확인을 담당합니다.",
                    verifier_label
                )
            } else {
                format!(
                    "{} is assigned as the dedicated verifier for runtime verification and preview validation.",
                    verifier_label
                )
            },
            planner_note: if is_ko {
                if wants_deepaudit {
                    "deepaudit 의도에 맞춰 verifier 역할을 review 와 분리해 독립 검증 증거를 유지합니다."
                        .to_string()
                } else {
                    "실행 증거가 없는 산출물은 품질이 낮으므로 검증을 명시 단계로 유지합니다."
                        .to_string()
                }
            } else if wants_deepaudit {
                "Deepaudit intent keeps verifier work separate from review so the plan retains independent verification evidence."
                    .to_string()
            } else {
                "Artifacts without executable evidence are lower quality, so verification stays explicit."
                    .to_string()
            },
            rationale_fragment: if is_ko {
                format!("전용 verifier 확보 ({})", verifier_label)
            } else {
                format!("dedicated verifier available ({})", verifier_label)
            },
        };
    }

    if let Some(reviewer) = reviewer_instance {
        let reviewer_label = agent_reference(reviewer, blueprints);
        return RoleCoverage {
            selection_reason: if is_ko {
                format!(
                    "전용 verifier 인스턴스가 없어 {}가 verification 단계를 대체 수행합니다.",
                    reviewer_label
                )
            } else {
                format!(
                    "No dedicated verifier instance is available, so {} will cover the verification step as a fallback.",
                    reviewer_label
                )
            },
            planner_note: if is_ko {
                if wants_deepaudit {
                    "deepaudit 이 요청한 독립 verifier 가 부재합니다. reviewer 대체 경로를 드러내되 검증 단계를 유지합니다."
                        .to_string()
                } else {
                    "전용 verifier 가 없어 reviewer 가 verification 을 겸임합니다.".to_string()
                }
            } else if wants_deepaudit {
                "The independent verifier requested by deepaudit is unavailable. The plan keeps verification explicit while surfacing the reviewer fallback."
                    .to_string()
            } else {
                "No dedicated verifier is available, so the reviewer will also perform verification."
                    .to_string()
            },
            rationale_fragment: if is_ko {
                format!("전용 verifier 없음 -> reviewer 대체 ({})", reviewer_label)
            } else {
                format!(
                    "no dedicated verifier -> reviewer fallback ({})",
                    reviewer_label
                )
            },
        };
    }

    if let Some(approver) = approval_instance {
        let approver_label = agent_reference(approver, blueprints);
        return RoleCoverage {
            selection_reason: if is_ko {
                format!(
                    "전용 verifier 와 reviewer 인스턴스가 없어 {}가 verification 단계를 대체 수행합니다.",
                    approver_label
                )
            } else {
                format!(
                    "No dedicated verifier or reviewer instance is available, so {} will cover the verification step as a fallback.",
                    approver_label
                )
            },
            planner_note: if is_ko {
                if wants_deepaudit {
                    "deepaudit 이 요청한 verifier/reviewer 분리가 모두 불가능합니다. approver 대체 경로를 노출한 채 verification 단계를 유지합니다."
                        .to_string()
                } else {
                    "전용 verifier/reviewer 가 없어 approver 가 verification 을 겸임합니다."
                        .to_string()
                }
            } else if wants_deepaudit {
                "Both independent verifier and reviewer coverage requested by deepaudit are unavailable. The plan surfaces the approver fallback while keeping verification explicit."
                    .to_string()
            } else {
                "No dedicated verifier or reviewer is available, so the approver will also perform verification."
                    .to_string()
            },
            rationale_fragment: if is_ko {
                format!(
                    "전용 verifier/reviewer 없음 -> approver 대체 ({})",
                    approver_label
                )
            } else {
                format!(
                    "no dedicated verifier/reviewer -> approver fallback ({})",
                    approver_label
                )
            },
        };
    }

    RoleCoverage {
        selection_reason: if is_ko {
            "전용 verifier, reviewer, approver 인스턴스가 모두 없어 verification 역할 배정을 확정하지 못했습니다."
                .to_string()
        } else {
            "No dedicated verifier, reviewer, or approver instance is available, so the verification assignment remains unresolved."
                .to_string()
        },
        planner_note: if is_ko {
            if wants_deepaudit {
                "deepaudit 이 요구한 독립 verifier 경로를 충족할 인스턴스가 없습니다. 후속 오케스트레이션에서 verification 책임자 확보가 필요합니다."
                    .to_string()
            } else {
                "verification 단계를 수행할 명시 인스턴스가 없어 후속 오케스트레이션 확인이 필요합니다."
                    .to_string()
            }
        } else if wants_deepaudit {
            "No instance can satisfy the independent verifier path requested by deepaudit. Follow-on orchestration must provide verification ownership."
                .to_string()
        } else {
            "No explicit instance is available to perform verification, so follow-on orchestration must supply ownership."
                .to_string()
        },
        rationale_fragment: if is_ko {
            "verifier/reviewer/approver 부재".to_string()
        } else {
            "verifier/reviewer/approver unavailable".to_string()
        },
    }
}

fn agent_reference(instance: &AgentInstance, blueprints: &[AgentBlueprint]) -> String {
    match blueprint_for_instance(instance, blueprints) {
        Some(blueprint) => format!("'{}' (role '{}')", blueprint.name, blueprint.role_label),
        None => format!("instance '{}'", instance.instance_id),
    }
}

fn execution_capabilities_for_instance(
    instance: Option<&AgentInstance>,
    blueprints: &[AgentBlueprint],
) -> Vec<String> {
    instance
        .and_then(|candidate| blueprint_for_instance(candidate, blueprints))
        .map(|blueprint| {
            if blueprint.capabilities.is_empty() {
                vec!["delivery".to_string()]
            } else {
                blueprint.capabilities.clone()
            }
        })
        .unwrap_or_else(|| vec!["delivery".to_string()])
}

fn instance_capabilities_or_default(
    instance: Option<&AgentInstance>,
    blueprints: &[AgentBlueprint],
    fallback: &[&str],
) -> Vec<String> {
    instance
        .and_then(|candidate| blueprint_for_instance(candidate, blueprints))
        .map(|blueprint| {
            if blueprint.capabilities.is_empty() {
                fallback.iter().map(|item| (*item).to_string()).collect()
            } else {
                blueprint.capabilities.clone()
            }
        })
        .unwrap_or_else(|| fallback.iter().map(|item| (*item).to_string()).collect())
}

struct GoalFeatures {
    wants_workspace: bool,
    wants_frontend: bool,
    wants_backend: bool,
    wants_review: bool,
    wants_verification: bool,
    wants_preview: bool,
    wants_deepaudit: bool,
    wants_input_driven_decision: bool,
    wants_fresh_artifact_delivery: bool,
}

struct FrontendDeliverySliceSpec {
    step_id: String,
    label: String,
    description: String,
    slice: &'static str,
    slice_contract: &'static str,
    allowed_file_focus: &'static [&'static str],
    deferred_scope: &'static str,
    planner_note: String,
}

const REQUIRED_FRONTEND_SCAFFOLD_FILES: &[&str] = &[
    "package.json",
    "tsconfig.json",
    "vite.config.ts",
    "index.html",
    "src/main.tsx",
    "src/App.tsx",
];

const FRONTEND_SCAFFOLD_FILE_FOCUS: &[&str] = &[
    "package.json",
    "tsconfig.json",
    "vite.config.ts",
    "index.html",
    "src/main.tsx",
    "src/App.tsx",
    "src/domain/*",
    "src/data/*",
];

const FRONTEND_SCORING_FILE_FOCUS: &[&str] = &[
    "src/domain/*",
    "src/data/*",
    "src/engine/*",
    "src/lib/*",
    "src/**/*.test.*",
];

const FRONTEND_INPUT_STATE_FILE_FOCUS: &[&str] = &[
    "src/state/*",
    "src/hooks/*",
    "src/components/*Input*",
    "src/components/*Filter*",
    "src/App.tsx",
];

const FRONTEND_PERSISTENCE_FILE_FOCUS: &[&str] =
    &["src/state/*", "src/storage/*", "src/hooks/*", "src/App.tsx"];

const FRONTEND_RESULTS_FILE_FOCUS: &[&str] = &[
    "src/App.tsx",
    "src/components/*Result*",
    "src/components/*Card*",
    "src/styles*",
    "src/**/*.test.*",
];

const FRONTEND_INTERACTION_FILE_FOCUS: &[&str] = &[
    "src/App.tsx",
    "src/state/*",
    "src/hooks/*",
    "src/components/*",
    "src/storage/*",
];

const FRONTEND_QUALITY_FILE_FOCUS: &[&str] = &[
    "src/App.tsx",
    "src/components/*",
    "src/styles*",
    "src/**/*.test.*",
    "package.json",
];

const FRESH_ARTIFACT_DELIVERY_SIGNALS: &[&str] = &[
    "new",
    "fresh",
    "from scratch",
    "clean slate",
    "build",
    "create",
    "make",
    "generate",
    "scaffold",
    "prototype",
    "produce",
    "write",
    "새로",
    "처음부터",
    "신규",
    "만들어줘",
    "만들",
    "제작",
    "생성",
    "작성",
    "구축",
    "짜줘",
];

const STRONG_EXISTING_ARTIFACT_REPAIR_SIGNALS: &[&str] = &[
    "fix",
    "repair",
    "refactor",
    "patch",
    "rework",
    "고쳐",
    "고치",
    "수리",
    "보수",
    "패치",
    "리팩터",
    "리팩토",
    "재작업",
];

const EXISTING_ARTIFACT_SCOPE_SIGNALS: &[&str] = &[
    "existing", "previous", "prior", "old", "기존", "이전", "방금", "아까",
];

const CURRENT_ARTIFACT_SCOPE_SIGNALS: &[&str] = &["current", "현재"];

const ARTIFACT_SCOPE_SIGNALS: &[&str] = &[
    "artifact",
    "output",
    "deliverable",
    "file",
    "code",
    "implementation",
    "project",
    "workspace",
    "dashboard",
    "website",
    "web app",
    "webapp",
    "app",
    "page",
    "component",
    "source",
    "repo",
    "repository",
    "산출물",
    "결과물",
    "파일",
    "코드",
    "구현",
    "프로젝트",
    "작업물",
    "대시보드",
    "웹사이트",
    "웹 앱",
    "웹앱",
    "앱",
    "페이지",
    "컴포넌트",
    "소스",
    "저장소",
];

const INPUT_DRIVEN_DECISION_SIGNALS: &[&str] = &[
    "recommend",
    "recommendation",
    "ranking",
    "rank",
    "select",
    "selection",
    "choose",
    "filter",
    "search",
    "match",
    "book",
    "booking",
    "reserve",
    "reservation",
    "schedule",
    "assign",
    "allocate",
    "picker",
    "추천",
    "순위",
    "랭킹",
    "선택",
    "고르",
    "골라",
    "픽",
    "필터",
    "검색",
    "매칭",
    "예약",
    "일정",
    "배정",
    "할당",
    "찾아주는",
    "추천해주는",
];

const FRONTEND_DELIVERY_SIGNALS: &[&str] = &[
    "frontend",
    "front-end",
    "ui",
    "ux",
    "component",
    "page",
    "homepage",
    "landing page",
    "single page",
    "single-page",
    "website",
    "web app",
    "web-app",
    "webapp",
    "browser app",
    "dashboard",
    "screen",
    "preview",
    "프론트",
    "프론트엔드",
    "화면",
    "미리보기",
    "웹사이트",
    "웹 사이트",
    "웹앱",
    "웹 앱",
    "웹 페이지",
    "페이지",
    "랜딩",
    "대시보드",
    "브라우저",
];

const USER_FACING_APP_DELIVERY_SIGNALS: &[&str] = &[
    "app",
    "application",
    "tool",
    "advisor",
    "picker",
    "앱",
    "어플",
    "애플리케이션",
    "도구",
    "툴",
];

const USER_FACING_APP_CONTEXT_SIGNALS: &[&str] = &[
    "user",
    "interactive",
    "input",
    "form",
    "visual",
    "card",
    "result",
    "calculator",
    "사용자",
    "입력",
    "조건",
    "상호작용",
    "화면",
    "폼",
    "카드",
    "결과",
    "계산기",
];

const WORKSPACE_DELIVERY_SIGNALS: &[&str] = &[
    "workspace",
    "work1",
    "work2",
    "preview",
    "build",
    "run",
    "test",
    "artifact",
    "deliverable",
    "website",
    "web app",
    "web-app",
    "webapp",
    "dashboard",
    "prototype",
    "워크스페이스",
    "산출물",
    "결과물",
    "웹사이트",
    "웹 사이트",
    "웹앱",
    "웹 앱",
    "대시보드",
    "프로토타입",
];

const BACKEND_DELIVERY_SIGNALS: &[&str] = &[
    "backend",
    "back-end",
    "api",
    "server",
    "sequencer",
    "workflow",
    "stop",
    "cli",
    "command-line",
    "script",
    "automation",
    "백엔드",
    "서버",
    "워크플로우",
    "스크립트",
    "자동화",
];

const AUTH_BACKEND_CAPABILITY_SIGNALS: &[&str] = &[
    "signup",
    "sign-up",
    "register",
    "account",
    "session",
    "password",
    "oauth",
    "회원가입",
    "계정",
    "세션",
    "비밀번호",
    "인증",
];

const AUTH_GENERIC_SIGNALS: &[&str] = &["auth", "authentication", "인증"];

const AUTH_FRONTEND_ONLY_SIGNALS: &[&str] = &[
    "login page",
    "login screen",
    "login button",
    "login form",
    "auth page",
    "auth screen",
    "auth modal",
    "로그인 화면",
    "로그인 페이지",
    "로그인 버튼",
    "로그인 폼",
    "로그인 모달",
];

const PERSISTENCE_BACKEND_INFRASTRUCTURE_SIGNALS: &[&str] = &["persist", "storage", "crud"];

const DATABASE_REFERENCE_SIGNALS: &[&str] = &["database", "db", "데이터베이스", "디비"];

const DATABASE_BACKEND_CONTEXT_SIGNALS: &[&str] = &[
    "schema",
    "migration",
    "migrate",
    "postgres",
    "postgresql",
    "mysql",
    "sqlite",
    "sql",
    "query",
    "table",
    "admin",
    "connect",
    "connection",
    "server",
    "api",
    "backend",
    "crud",
    "persist",
    "storage",
    "save",
    "store",
    "saved",
    "스키마",
    "마이그레이션",
    "쿼리",
    "테이블",
    "관리자",
    "연결",
    "서버",
    "백엔드",
    "저장",
    "영구",
];

const STATIC_REFERENCE_DATA_CONTEXT_SIGNALS: &[&str] = &[
    "static",
    "sample",
    "mock",
    "seed",
    "catalog",
    "dataset",
    "data source",
    "reference data",
    "public data",
    "include",
    "built-in",
    "local",
    "정적",
    "샘플",
    "목업",
    "카탈로그",
    "데이터셋",
    "데이터 소스",
    "공개 데이터",
    "참고 데이터",
    "목록",
    "리스트",
    "포함",
    "내장",
    "로컬",
    "알아서",
    "준비",
];

const PERSISTENCE_ACTION_SIGNALS: &[&str] = &["save", "store", "saved", "저장"];

const PERSISTENCE_OBJECT_SIGNALS: &[&str] = &[
    "data",
    "result",
    "results",
    "recommendation",
    "recommendations",
    "history",
    "profile",
    "setting",
    "settings",
    "preference",
    "preferences",
    "record",
    "records",
    "file",
    "files",
    "데이터",
    "결과",
    "추천",
    "기록",
    "프로필",
    "설정",
    "선호",
    "파일",
];

const FUNCTIONAL_AUTH_CONTEXT_SIGNALS: &[&str] = &[
    "feature",
    "flow",
    "system",
    "works",
    "functional",
    "can login",
    "log in",
    "sign in",
    "기능",
    "흐름",
    "시스템",
    "동작",
    "가능",
    "할 수",
];

fn quality_review_capabilities(wants_input_driven_decision: bool) -> Vec<String> {
    let mut capabilities = vec![
        "review".to_string(),
        "quality_gate".to_string(),
        "regression_detection".to_string(),
    ];
    if wants_input_driven_decision {
        capabilities.push("constraint_modeling".to_string());
        capabilities.push("negative_case_review".to_string());
    }
    capabilities
}

fn quality_verification_capabilities(wants_input_driven_decision: bool) -> Vec<String> {
    let mut capabilities = vec![
        "verification".to_string(),
        "runtime_checks".to_string(),
        "preview_validation".to_string(),
    ];
    if wants_input_driven_decision {
        capabilities.push("adversarial_testing".to_string());
        capabilities.push("user_flow_validation".to_string());
    }
    capabilities
}

fn build_quality_guardrails(goal: &str, features: &GoalFeatures, is_ko: bool) -> Value {
    let mut invariants = vec![
        "visible_results_match_current_input",
        "conditional_explanations_require_true_conditions",
        "negative_or_unavailable_terms_are_not_positive_signals",
    ];
    if features.wants_input_driven_decision {
        invariants.push("unavailable_reserved_banned_or_conflicting_items_are_excluded");
        invariants.push("at_least_one_negative_adversarial_case_is_required");
    }

    json!({
        "source_goal": goal,
        "risk_profile": if features.wants_input_driven_decision {
            "input_driven_selection"
        } else {
            "standard"
        },
        "requires_domain_neutral_rule_map": true,
        "requires_negative_adversarial_case": features.wants_input_driven_decision,
        "delivery_intent": if features.wants_fresh_artifact_delivery {
            "fresh_artifact"
        } else {
            "preserve_or_repair_existing"
        },
        "dirty_workspace_policy": if features.wants_fresh_artifact_delivery {
            "treat_dirty_files_as_context_not_repair_scope_unless_named"
        } else {
            "use_dirty_files_as_primary_evidence_when_assignment_is_repair_or_refactor"
        },
        "must_prove": invariants,
        "review_instruction": if is_ko {
            "원문 요구에서 엔터티/상태/불가 조건/상호배타 조건/조건부 설명 규칙을 뽑아 현재 산출물이 이를 어기면 재작업으로 판정합니다."
        } else {
            "Derive entities, states, unavailable conditions, mutually exclusive choices, and conditional explanation rules from the original request; require rework if the artifact violates them."
        },
        "verification_instruction": if is_ko {
            "사용자 입력 기반 산출물은 행복 경로 하나만 보지 말고 원문에서 뽑은 부정/반례 시나리오를 최소 하나 실행 증거로 확인합니다."
        } else {
            "For user-input-driven artifacts, verify at least one negative/adversarial scenario derived from the original request, not only a happy path."
        },
    })
}

fn should_split_frontend_delivery(goal: &str, features: &GoalFeatures) -> bool {
    features.wants_frontend
        && features.wants_input_driven_decision
        && features.wants_fresh_artifact_delivery
        && frontend_delivery_complexity_score(goal) >= 5
}

fn should_use_deep_frontend_split(goal: &str) -> bool {
    frontend_delivery_complexity_score(goal) >= 8
}

fn frontend_delivery_slices(
    goal: &str,
    is_ko: bool,
    first_step_id: String,
) -> Vec<FrontendDeliverySliceSpec> {
    if should_use_deep_frontend_split(goal) {
        if is_ko {
            return vec![
                FrontendDeliverySliceSpec {
                    step_id: first_step_id,
                    label: "실행 가능한 프론트엔드 골격과 기본 도메인 데이터 준비".to_string(),
                    description: "package.json, tsconfig.json, vite.config.ts, index.html, src/main.tsx, src/App.tsx와 최소 도메인 타입/기초 데이터를 먼저 만듭니다.".to_string(),
                    slice: "foundation_scaffold",
                    slice_contract: "create runnable scaffold and minimal reference data only before deeper behavior work",
                    allowed_file_focus: FRONTEND_SCAFFOLD_FILE_FOCUS,
                    deferred_scope: "defer scoring/ranking engine, live input wiring, persistence, and result polish",
                    planner_note: "첫 카드는 실행 골격과 기본 데이터만 닫고, 추천 엔진/입력 연결/결과 UX는 뒤 카드로 분리합니다.".to_string(),
                },
                FrontendDeliverySliceSpec {
                    step_id: Uuid::new_v4().to_string(),
                    label: "도메인 규칙과 추천/점수 엔진 구현".to_string(),
                    description: "원문 요구에서 사거리/거리/예산/예약불가 같은 도메인 중립 제약을 뽑아 순위와 제외 규칙을 구현합니다.".to_string(),
                    slice: "scoring_engine",
                    slice_contract: "implement domain rules, exclusion logic, ranking, and reason primitives only",
                    allowed_file_focus: FRONTEND_SCORING_FILE_FOCUS,
                    deferred_scope: "defer UI control binding, localStorage persistence, and visual result polish",
                    planner_note: "추천 이유와 제외 규칙의 참/거짓을 UI 입력 연결 전에 작은 순수 로직으로 먼저 고정합니다.".to_string(),
                },
                FrontendDeliverySliceSpec {
                    step_id: Uuid::new_v4().to_string(),
                    label: "검색/선택 입력 상태와 즉시 재계산 연결".to_string(),
                    description: "검색, 카드 선택, 1~5개 입력 변화가 추천 엔진을 즉시 다시 부르게 연결합니다.".to_string(),
                    slice: "input_state",
                    slice_contract: "wire current input/search/selection state to immediate recompute only",
                    allowed_file_focus: FRONTEND_INPUT_STATE_FILE_FOCUS,
                    deferred_scope: "defer favorites persistence, result-card polish, and broad scoring rewrites",
                    planner_note: "입력 상태와 recompute 호출만 다뤄 큰 UI/결과 렌더링과 섞지 않습니다.".to_string(),
                },
                FrontendDeliverySliceSpec {
                    step_id: Uuid::new_v4().to_string(),
                    label: "즐겨찾기와 로컬 저장 흐름 구현".to_string(),
                    description: "로그인 없는 즐겨찾기/localStorage 저장과 복구, 입력 변화 시 저장 상태 반영을 구현합니다.".to_string(),
                    slice: "persistence_recompute",
                    slice_contract: "add no-login favorites/localStorage persistence on top of existing recompute only",
                    allowed_file_focus: FRONTEND_PERSISTENCE_FILE_FOCUS,
                    deferred_scope: "defer result-card visual polish and core scoring rewrites unless persistence exposes a blocker",
                    planner_note: "저장/persistence 문제를 입력 상태 카드와 분리해 timeout과 부분 실패를 줄입니다.".to_string(),
                },
                FrontendDeliverySliceSpec {
                    step_id: Uuid::new_v4().to_string(),
                    label: "추천 결과/이유 표시와 품질 보강".to_string(),
                    description: "추천 10개, 이유, 부정 조건 제외 증거, 빈 상태, preview/build 준비를 마무리합니다.".to_string(),
                    slice: "results_quality",
                    slice_contract: "finish visible results, truthful reasons, empty states, and verification readiness only",
                    allowed_file_focus: FRONTEND_RESULTS_FILE_FOCUS,
                    deferred_scope: "do not expand product scope or rewrite completed data/state/scoring unless verifier evidence requires it",
                    planner_note: "마지막 카드에서 결과 UX와 검수 가능 증거만 닫고 새 기능 확장을 하지 않습니다.".to_string(),
                },
            ];
        }
        return vec![
            FrontendDeliverySliceSpec {
                step_id: first_step_id,
                label: "Prepare runnable frontend scaffold and base domain data".to_string(),
                description: "Create package.json, tsconfig.json, vite.config.ts, index.html, src/main.tsx, src/App.tsx, plus minimal domain types and seed data.".to_string(),
                slice: "foundation_scaffold",
                slice_contract: "create runnable scaffold and minimal reference data only before deeper behavior work",
                allowed_file_focus: FRONTEND_SCAFFOLD_FILE_FOCUS,
                deferred_scope: "defer scoring/ranking engine, live input wiring, persistence, and result polish",
                planner_note: "Close runnable scaffold and base data first; defer scoring, input wiring, persistence, and result UX to later slices.".to_string(),
            },
            FrontendDeliverySliceSpec {
                step_id: Uuid::new_v4().to_string(),
                label: "Implement domain rules and recommendation scoring".to_string(),
                description: "Derive domain-neutral constraints from the request and implement ranking, exclusion, and reason primitives.".to_string(),
                slice: "scoring_engine",
                slice_contract: "implement domain rules, exclusion logic, ranking, and reason primitives only",
                allowed_file_focus: FRONTEND_SCORING_FILE_FOCUS,
                deferred_scope: "defer UI control binding, localStorage persistence, and visual result polish",
                planner_note: "Stabilize recommendation truth rules as small pure logic before connecting all UI controls.".to_string(),
            },
            FrontendDeliverySliceSpec {
                step_id: Uuid::new_v4().to_string(),
                label: "Wire search, selection state, and immediate recompute".to_string(),
                description: "Connect search, card selection, and 1-to-5 item input changes to immediate recommendation refresh.".to_string(),
                slice: "input_state",
                slice_contract: "wire current input/search/selection state to immediate recompute only",
                allowed_file_focus: FRONTEND_INPUT_STATE_FILE_FOCUS,
                deferred_scope: "defer favorites persistence, result-card polish, and broad scoring rewrites",
                planner_note: "Keep state and recompute wiring separate from result-card polish to avoid another timeout-prone card.".to_string(),
            },
            FrontendDeliverySliceSpec {
                step_id: Uuid::new_v4().to_string(),
                label: "Implement favorites and local persistence".to_string(),
                description: "Implement no-login favorites, localStorage save/restore, and persisted preference influence on recompute.".to_string(),
                slice: "persistence_recompute",
                slice_contract: "add no-login favorites/localStorage persistence on top of existing recompute only",
                allowed_file_focus: FRONTEND_PERSISTENCE_FILE_FOCUS,
                deferred_scope: "defer result-card visual polish and core scoring rewrites unless persistence exposes a blocker",
                planner_note: "Separate persistence from raw input wiring so partial progress can be reviewed safely.".to_string(),
            },
            FrontendDeliverySliceSpec {
                step_id: Uuid::new_v4().to_string(),
                label: "Finish recommendation results and quality evidence".to_string(),
                description: "Finish top-10 results, truthful reasons, negative-condition exclusion evidence, empty states, and preview/build readiness.".to_string(),
                slice: "results_quality",
                slice_contract: "finish visible results, truthful reasons, empty states, and verification readiness only",
                allowed_file_focus: FRONTEND_RESULTS_FILE_FOCUS,
                deferred_scope: "do not expand product scope or rewrite completed data/state/scoring unless verifier evidence requires it",
                planner_note: "Final slice closes visible quality and verification readiness without expanding product scope.".to_string(),
            },
        ];
    }

    if is_ko {
        vec![
            FrontendDeliverySliceSpec {
                step_id: first_step_id,
                label: "프론트엔드 산출물 골격과 기준 데이터 준비".to_string(),
                description: "package.json, tsconfig.json, vite.config.ts, index.html, src/main.tsx, src/App.tsx와 정적 참고 데이터, 상태 모델, 화면 골격을 먼저 작게 만듭니다.".to_string(),
                slice: "foundation",
                slice_contract: "create runnable scaffold, reference data, state model, and visible shell only",
                allowed_file_focus: FRONTEND_SCAFFOLD_FILE_FOCUS,
                deferred_scope: "defer advanced interactions, persistence polish, and verifier-facing quality hardening",
                planner_note: "큰 자연어 요청을 한 번에 구현하지 않고, 실행 골격/데이터/상태/화면 뼈대를 먼저 고정해 timeout 위험을 줄입니다.".to_string(),
            },
            FrontendDeliverySliceSpec {
                step_id: Uuid::new_v4().to_string(),
                label: "입력 기반 추천 상호작용 구현".to_string(),
                description: "검색, 선택, 즐겨찾기, 추천 갱신 같은 핵심 상호작용을 구현합니다.".to_string(),
                slice: "interaction",
                slice_contract: "implement user input interaction and recommendation refresh only",
                allowed_file_focus: FRONTEND_INTERACTION_FILE_FOCUS,
                deferred_scope: "defer final visual polish and verification-only evidence work",
                planner_note: "사용자 입력이 바뀔 때 결과가 바뀌는 핵심 동작만 집중해서 구현합니다.".to_string(),
            },
            FrontendDeliverySliceSpec {
                step_id: Uuid::new_v4().to_string(),
                label: "프론트엔드 품질 보강과 미리보기 준비".to_string(),
                description: "부정 조건, 제외 규칙, 조건부 이유 표시, preview 가능성을 보강합니다.".to_string(),
                slice: "quality_finish",
                slice_contract: "harden negative cases, conditional reasons, preview/build readiness, and result honesty only",
                allowed_file_focus: FRONTEND_QUALITY_FILE_FOCUS,
                deferred_scope: "do not reopen completed scaffold or core logic unless quality evidence proves a blocker",
                planner_note: "검수 전에 unavailable/already-used/conflicting 항목 제외와 preview 증거를 닫습니다.".to_string(),
            },
        ]
    } else {
        vec![
            FrontendDeliverySliceSpec {
                step_id: first_step_id,
                label: "Prepare frontend shell and reference data".to_string(),
                description: "Create package.json, tsconfig.json, vite.config.ts, index.html, src/main.tsx, src/App.tsx, static reference data, state model, and visible shell first.".to_string(),
                slice: "foundation",
                slice_contract: "create runnable scaffold, reference data, state model, and visible shell only",
                allowed_file_focus: FRONTEND_SCAFFOLD_FILE_FOCUS,
                deferred_scope: "defer advanced interactions, persistence polish, and verifier-facing quality hardening",
                planner_note: "Split the large natural-language request so runnable scaffold, data, state, and shell are stabilized before heavier behavior work.".to_string(),
            },
            FrontendDeliverySliceSpec {
                step_id: Uuid::new_v4().to_string(),
                label: "Implement input-driven recommendation interactions".to_string(),
                description: "Implement search, selection, favorites, and recommendation refresh behavior.".to_string(),
                slice: "interaction",
                slice_contract: "implement user input interaction and recommendation refresh only",
                allowed_file_focus: FRONTEND_INTERACTION_FILE_FOCUS,
                deferred_scope: "defer final visual polish and verification-only evidence work",
                planner_note: "Focus this slice on the core behavior that changes output when user input changes.".to_string(),
            },
            FrontendDeliverySliceSpec {
                step_id: Uuid::new_v4().to_string(),
                label: "Harden frontend quality and preview readiness".to_string(),
                description: "Harden negative conditions, exclusion rules, conditional explanations, and preview readiness.".to_string(),
                slice: "quality_finish",
                slice_contract: "harden negative cases, conditional reasons, preview/build readiness, and result honesty only",
                allowed_file_focus: FRONTEND_QUALITY_FILE_FOCUS,
                deferred_scope: "do not reopen completed scaffold or core logic unless quality evidence proves a blocker",
                planner_note: "Close unavailable/already-used/conflicting exclusion evidence and preview evidence before review.".to_string(),
            },
        ]
    }
}

fn frontend_delivery_complexity_score(goal: &str) -> usize {
    let lowered = goal.to_lowercase();
    let non_empty_lines = goal.lines().filter(|line| !line.trim().is_empty()).count();
    let numbered_items = goal
        .lines()
        .filter(|line| {
            line.trim_start()
                .chars()
                .next()
                .is_some_and(|ch| ch.is_ascii_digit())
        })
        .count();
    let mut score = 0;
    if non_empty_lines >= 5 {
        score += 2;
    } else if non_empty_lines >= 3 {
        score += 1;
    }
    if numbered_items >= 2 {
        score += 2;
    }
    let interaction_signals = [
        "favorite",
        "favorites",
        "즐겨찾기",
        "search",
        "검색",
        "filter",
        "필터",
        "refresh",
        "새로고침",
        "바뀌",
        "update",
        "추천 10",
        "10 recommendations",
        "db",
        "database",
        "데이터베이스",
        "디비",
        "알아서",
        "입력",
        "선택",
    ];
    score += interaction_signals
        .iter()
        .filter(|signal| lowered.contains(**signal))
        .count()
        .min(5);
    if lowered.contains("고려해야")
        || lowered.contains("requirements")
        || lowered.contains("constraints")
    {
        score += 1;
    }
    if lowered.matches(',').count() + lowered.matches('，').count() + lowered.matches('/').count()
        >= 4
    {
        score += 1;
    }
    score
}

fn detect_goal_features(goal: &str) -> GoalFeatures {
    let lowered = goal.to_lowercase();
    let wants_deepaudit = contains_any(
        &lowered,
        &[
            "deepaudit",
            "deep audit",
            "deupaudit",
            "independent reviewer",
            "independent verifier",
            "reviewer/verifier",
            "reviewer verifier",
            "독립 reviewer",
            "독립 verifier",
            "독립 리뷰",
            "독립 검증",
            "심층 감사",
        ],
    );
    let wants_input_driven_decision = contains_any(&lowered, INPUT_DRIVEN_DECISION_SIGNALS);
    let wants_frontend = contains_any(&lowered, FRONTEND_DELIVERY_SIGNALS)
        || looks_like_user_facing_app_delivery(&lowered, wants_input_driven_decision);
    let wants_preview = wants_frontend
        || contains_any(
            &lowered,
            &[
                "preview",
                "render",
                "iframe",
                "미리보기",
                "브라우저",
                "화면",
                "웹사이트",
                "웹앱",
            ],
        );
    let wants_workspace = wants_frontend || contains_any(&lowered, WORKSPACE_DELIVERY_SIGNALS);
    let wants_backend = contains_any(&lowered, BACKEND_DELIVERY_SIGNALS)
        || looks_like_stateful_backend_delivery(&lowered);
    let wants_fresh_artifact_delivery = contains_any(&lowered, FRESH_ARTIFACT_DELIVERY_SIGNALS)
        && !contains_existing_artifact_repair_signal(&lowered);
    let wants_review = contains_any(
        &lowered,
        &[
            "quality",
            "review",
            "audit",
            "correct",
            "산출물",
            "퀄리티",
            "리뷰",
            "감사",
        ],
    ) || wants_frontend
        || wants_backend
        || wants_input_driven_decision
        || wants_deepaudit;
    let wants_verification = contains_any(
        &lowered,
        &[
            "verify",
            "verification",
            "test",
            "preview",
            "build",
            "smoke",
            "검증",
            "테스트",
            "미리보기",
        ],
    ) || wants_frontend
        || wants_backend
        || wants_input_driven_decision
        || wants_deepaudit;

    GoalFeatures {
        wants_workspace,
        wants_frontend,
        wants_backend,
        wants_review,
        wants_verification,
        wants_preview,
        wants_deepaudit,
        wants_input_driven_decision,
        wants_fresh_artifact_delivery,
    }
}

fn contains_any(text: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| text.contains(needle))
}

fn looks_like_user_facing_app_delivery(text: &str, wants_input_driven_decision: bool) -> bool {
    contains_bounded_or_literal_any(text, USER_FACING_APP_DELIVERY_SIGNALS)
        && !contains_any(text, BACKEND_DELIVERY_SIGNALS)
        && (wants_input_driven_decision || contains_any(text, USER_FACING_APP_CONTEXT_SIGNALS))
}

fn looks_like_stateful_backend_delivery(text: &str) -> bool {
    let has_persistence = looks_like_persistent_state_capability(text);
    let has_auth_capability = contains_any(text, AUTH_BACKEND_CAPABILITY_SIGNALS);
    let has_negated_auth_requirement = contains_negated_auth_requirement(text);
    let has_auth_system = contains_any(text, AUTH_GENERIC_SIGNALS)
        && contains_any(text, FUNCTIONAL_AUTH_CONTEXT_SIGNALS)
        && !has_negated_auth_requirement;
    let has_login_function = text.contains("login")
        && contains_any(text, FUNCTIONAL_AUTH_CONTEXT_SIGNALS)
        && !has_negated_auth_requirement;
    let has_korean_login_function = text.contains("로그인")
        && contains_any(text, FUNCTIONAL_AUTH_CONTEXT_SIGNALS)
        && !has_negated_auth_requirement;
    let ui_only_auth =
        contains_any(text, AUTH_FRONTEND_ONLY_SIGNALS) || has_negated_auth_requirement;
    let ui_only_auth = ui_only_auth
        && !has_persistence
        && !has_auth_capability
        && !has_auth_system
        && !has_login_function
        && !has_korean_login_function;
    if ui_only_auth {
        return false;
    }
    has_persistence
        || has_auth_capability
        || has_auth_system
        || has_login_function
        || has_korean_login_function
}

fn contains_negated_auth_requirement(text: &str) -> bool {
    contains_any(
        text,
        &[
            "no login",
            "without login",
            "login-free",
            "no sign in",
            "without sign in",
            "without signing in",
            "no authentication",
            "without authentication",
            "로그인불필요",
            "로그인 불필요",
            "로그인 없이",
            "로그인 필요 없어",
            "로그인 필요없",
            "로그인은 필요 없어",
            "로그인은 필요없",
            "로그인은 없어",
            "로그인 없어",
            "로그인 없음",
            "로그인 없는",
            "로그인하지 않아도",
            "로그인 안",
            "회원가입 없이",
            "회원가입 불필요",
            "회원가입 필요 없어",
            "회원가입 필요없",
        ],
    )
}

fn looks_like_persistent_state_capability(text: &str) -> bool {
    contains_any(text, PERSISTENCE_BACKEND_INFRASTRUCTURE_SIGNALS)
        || looks_like_database_backend_capability(text)
        || contains_near_pair(
            text,
            PERSISTENCE_ACTION_SIGNALS,
            PERSISTENCE_OBJECT_SIGNALS,
            32,
        )
}

fn looks_like_database_backend_capability(text: &str) -> bool {
    if !contains_any(text, DATABASE_REFERENCE_SIGNALS) {
        return false;
    }

    let has_static_reference_data_context =
        contains_any(text, STATIC_REFERENCE_DATA_CONTEXT_SIGNALS)
            && contains_any(text, FRONTEND_DELIVERY_SIGNALS)
            && !contains_any(text, BACKEND_DELIVERY_SIGNALS)
            && !contains_near_pair(
                text,
                DATABASE_REFERENCE_SIGNALS,
                DATABASE_BACKEND_CONTEXT_SIGNALS,
                48,
            )
            && !contains_near_pair(
                text,
                DATABASE_BACKEND_CONTEXT_SIGNALS,
                DATABASE_REFERENCE_SIGNALS,
                48,
            );
    if has_static_reference_data_context {
        return false;
    }

    !contains_any(text, FRONTEND_DELIVERY_SIGNALS)
        || contains_near_pair(
            text,
            DATABASE_REFERENCE_SIGNALS,
            DATABASE_BACKEND_CONTEXT_SIGNALS,
            48,
        )
        || contains_near_pair(
            text,
            DATABASE_BACKEND_CONTEXT_SIGNALS,
            DATABASE_REFERENCE_SIGNALS,
            48,
        )
}

fn contains_bounded_or_literal_any(text: &str, needles: &[&str]) -> bool {
    needles
        .iter()
        .any(|needle| contains_bounded_or_literal(text, needle))
}

fn contains_bounded_or_literal(text: &str, needle: &str) -> bool {
    if needle.chars().all(|c| c.is_ascii_alphanumeric()) {
        return text.match_indices(needle).any(|(start, _)| {
            let end = start + needle.len();
            let before = text[..start].chars().next_back();
            let after = text[end..].chars().next();
            !before.is_some_and(|c| c.is_ascii_alphanumeric())
                && !after.is_some_and(|c| c.is_ascii_alphanumeric())
        });
    }
    text.contains(needle)
}

fn contains_existing_artifact_repair_signal(text: &str) -> bool {
    contains_any(text, STRONG_EXISTING_ARTIFACT_REPAIR_SIGNALS)
        || contains_near_pair(
            text,
            EXISTING_ARTIFACT_SCOPE_SIGNALS,
            ARTIFACT_SCOPE_SIGNALS,
            48,
        )
        || contains_ordered_near_pair(
            text,
            CURRENT_ARTIFACT_SCOPE_SIGNALS,
            ARTIFACT_SCOPE_SIGNALS,
            16,
        )
}

fn contains_near_pair(
    text: &str,
    left_needles: &[&str],
    right_needles: &[&str],
    max_gap: usize,
) -> bool {
    for left in left_needles {
        for (left_start, _) in text.match_indices(left) {
            let left_end = left_start + left.len();
            for right in right_needles {
                for (right_start, _) in text.match_indices(right) {
                    let right_end = right_start + right.len();
                    let gap = if left_end <= right_start {
                        right_start.saturating_sub(left_end)
                    } else if right_end <= left_start {
                        left_start.saturating_sub(right_end)
                    } else {
                        0
                    };
                    if gap <= max_gap {
                        return true;
                    }
                }
            }
        }
    }
    false
}

fn contains_ordered_near_pair(
    text: &str,
    left_needles: &[&str],
    right_needles: &[&str],
    max_gap: usize,
) -> bool {
    for left in left_needles {
        for (left_start, _) in text.match_indices(left) {
            let left_end = left_start + left.len();
            for right in right_needles {
                for (right_start, _) in text.match_indices(right) {
                    if right_start < left_end {
                        continue;
                    }
                    if right_start.saturating_sub(left_end) <= max_gap {
                        return true;
                    }
                }
            }
        }
    }
    false
}

fn is_korean_text(text: &str) -> bool {
    text.chars().any(|c| {
        (c >= '\u{AC00}' && c <= '\u{D7A3}') // Hangul Syllables
            || (c >= '\u{3130}' && c <= '\u{318F}') // Hangul Compatibility Jamo
            || (c >= '\u{1100}' && c <= '\u{11FF}') // Hangul Jamo
    })
}

#[cfg(test)]
mod tests {
    use super::{
        detect_goal_features, PmPlanner, FRONTEND_INPUT_STATE_FILE_FOCUS,
        FRONTEND_PERSISTENCE_FILE_FOCUS, FRONTEND_RESULTS_FILE_FOCUS, FRONTEND_SCAFFOLD_FILE_FOCUS,
        FRONTEND_SCORING_FILE_FOCUS, REQUIRED_FRONTEND_SCAFFOLD_FILES,
    };
    use crate::domain::runtime::{CompanyRuntime, ExecutionMode};
    use serde_json::json;

    fn test_runtime() -> CompanyRuntime {
        CompanyRuntime {
            runtime_id: "runtime-test".to_string(),
            project_id: "project-test".to_string(),
            company_name: "Test Runtime".to_string(),
            org_graph: serde_json::json!({}),
            agent_instance_ids: vec![],
            meeting_protocol: serde_json::json!({}),
            approval_graph: serde_json::json!({}),
            shared_boards: serde_json::json!({}),
            execution_mode: ExecutionMode::Assisted,
            owner_ops_state: serde_json::json!({}),
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    #[test]
    fn detects_korean_website_requests_as_frontend_artifacts() {
        let features = detect_goal_features(
            "사용자가 자연어로 요청하면 추천 결과를 보여주는 웹사이트를 만들어줘",
        );

        assert!(features.wants_frontend);
        assert!(features.wants_workspace);
        assert!(features.wants_preview);
        assert!(features.wants_review);
        assert!(features.wants_verification);
        assert!(features.wants_input_driven_decision);
        assert!(features.wants_fresh_artifact_delivery);
        assert!(!features.wants_backend);
    }

    #[test]
    fn current_input_wording_still_counts_as_fresh_artifact_delivery() {
        let features = detect_goal_features(
            "식당 예약 추천 웹사이트를 만들어줘. 추천 이유는 현재 입력과 맞을 때만 보여줘.",
        );

        assert!(features.wants_frontend);
        assert!(features.wants_input_driven_decision);
        assert!(features.wants_fresh_artifact_delivery);
    }

    #[test]
    fn detects_english_web_app_requests_as_frontend_artifacts() {
        let features = detect_goal_features(
            "Build a browser app dashboard for ranking options against the current user input",
        );

        assert!(features.wants_frontend);
        assert!(features.wants_workspace);
        assert!(features.wants_preview);
        assert!(features.wants_input_driven_decision);
        assert!(features.wants_fresh_artifact_delivery);
        assert!(!features.wants_backend);
    }

    #[test]
    fn dynamic_website_wording_does_not_add_backend_lane() {
        let features = detect_goal_features(
            "동적으로 사용자의 조건을 반영하는 챔피언 추천 웹사이트를 만들어줘",
        );

        assert!(features.wants_frontend);
        assert!(features.wants_workspace);
        assert!(features.wants_preview);
        assert!(features.wants_input_driven_decision);
        assert!(features.wants_fresh_artifact_delivery);
        assert!(!features.wants_backend);
    }

    #[test]
    fn recommendation_app_wording_routes_to_frontend_artifact() {
        let features = detect_goal_features(
            "챔피언 추천 앱을 만들어줘. 사용자가 조건을 입력하면 결과를 보여줘.",
        );

        assert!(features.wants_frontend);
        assert!(features.wants_workspace);
        assert!(features.wants_preview);
        assert!(features.wants_input_driven_decision);
        assert!(features.wants_fresh_artifact_delivery);
        assert!(!features.wants_backend);
    }

    #[test]
    fn booking_tool_wording_routes_to_frontend_artifact() {
        let features = detect_goal_features(
            "예약 가능한 시간을 찾아주는 도구를 만들어줘. 이미 예약된 시간은 제외해.",
        );

        assert!(features.wants_frontend);
        assert!(features.wants_workspace);
        assert!(features.wants_preview);
        assert!(features.wants_input_driven_decision);
        assert!(features.wants_fresh_artifact_delivery);
        assert!(!features.wants_backend);
    }

    #[test]
    fn web_app_with_signup_and_saved_data_routes_to_frontend_and_backend() {
        let features = detect_goal_features(
            "회원가입과 로그인 기능이 있고 추천 결과를 저장하는 예약 웹앱을 만들어줘",
        );

        assert!(features.wants_frontend);
        assert!(features.wants_backend);
        assert!(features.wants_workspace);
        assert!(features.wants_preview);
        assert!(features.wants_input_driven_decision);
        assert!(features.wants_fresh_artifact_delivery);
    }

    #[test]
    fn login_screen_wording_stays_frontend_only() {
        let features = detect_goal_features("로그인 화면을 예쁘게 보여주는 웹앱을 만들어줘");

        assert!(features.wants_frontend);
        assert!(!features.wants_backend);
        assert!(features.wants_workspace);
        assert!(features.wants_preview);
        assert!(features.wants_fresh_artifact_delivery);
    }

    #[test]
    fn auth_modal_wording_stays_frontend_only() {
        let features = detect_goal_features("Build an auth modal web app with polished motion");

        assert!(features.wants_frontend);
        assert!(!features.wants_backend);
        assert!(features.wants_workspace);
        assert!(features.wants_preview);
        assert!(features.wants_fresh_artifact_delivery);
    }

    #[test]
    fn login_flow_wording_routes_to_frontend_and_backend() {
        let features =
            detect_goal_features("Build a web app where users can login and save recommendations");

        assert!(features.wants_frontend);
        assert!(features.wants_backend);
        assert!(features.wants_workspace);
        assert!(features.wants_preview);
        assert!(features.wants_input_driven_decision);
        assert!(features.wants_fresh_artifact_delivery);
    }

    #[test]
    fn negated_login_requirement_does_not_enable_backend() {
        let features = detect_goal_features(
            "즐겨찾기 목록은 있어야 하지만 로그인 없이 쓰는 추천 웹사이트를 만들어줘. 언어 가능 여부도 필터링해줘.",
        );

        assert!(features.wants_frontend);
        assert!(features.wants_input_driven_decision);
        assert!(features.wants_fresh_artifact_delivery);
        assert!(!features.wants_backend);
    }

    #[test]
    fn keeps_api_server_requests_on_backend_path() {
        let features = detect_goal_features("로그인 api 서버를 만들어줘");

        assert!(!features.wants_frontend);
        assert!(features.wants_backend);
        assert!(!features.wants_input_driven_decision);
        assert!(features.wants_fresh_artifact_delivery);
    }

    #[test]
    fn cli_tool_wording_stays_backend_or_execution_lane() {
        let features = detect_goal_features("CSV 정리 CLI 도구를 만들어줘");

        assert!(!features.wants_frontend);
        assert!(features.wants_backend);
        assert!(features.wants_fresh_artifact_delivery);
    }

    #[test]
    fn report_wording_stays_generic_delivery_lane() {
        let features = detect_goal_features(
            "Happy path verification report를 만들어줘. 사용자 결과 요약을 포함해줘.",
        );

        assert!(!features.wants_frontend);
        assert!(!features.wants_backend);
        assert!(features.wants_fresh_artifact_delivery);
    }

    #[test]
    fn culture_policy_document_does_not_default_to_backend_or_quality_fanout() {
        let features = detect_goal_features(
            "브랜드 문화와 운영 정책 문서를 작성해줘. 개발 구현 없이 팀이 읽을 수 있게 정리해줘.",
        );

        assert!(!features.wants_frontend);
        assert!(!features.wants_backend);
        assert!(!features.wants_review);
        assert!(!features.wants_verification);
        assert!(features.wants_fresh_artifact_delivery);
    }

    #[test]
    fn dynamic_workflow_requests_still_use_backend_lane() {
        let features = detect_goal_features("동적 워크플로우 실행 엔진을 만들어줘");

        assert!(!features.wants_frontend);
        assert!(features.wants_backend);
        assert!(features.wants_fresh_artifact_delivery);
    }

    #[test]
    fn repair_requests_do_not_become_fresh_artifact_delivery() {
        let features = detect_goal_features("Fix the existing dashboard recommendation bug");

        assert!(features.wants_frontend);
        assert!(!features.wants_fresh_artifact_delivery);
    }

    #[test]
    fn scoped_current_artifact_repair_does_not_become_fresh_delivery() {
        let features = detect_goal_features("현재 웹사이트를 수정해서 예약 추천 기능을 만들어줘");

        assert!(features.wants_frontend);
        assert!(!features.wants_fresh_artifact_delivery);
    }

    fn assert_complex_reference_data_prompt_routes_to_frontend(prompt: &str) {
        let features = detect_goal_features(prompt);

        assert!(
            features.wants_frontend,
            "frontend should be enabled for: {prompt}"
        );
        assert!(
            features.wants_workspace,
            "workspace prep should be enabled for: {prompt}"
        );
        assert!(
            features.wants_preview,
            "preview should be enabled for: {prompt}"
        );
        assert!(
            features.wants_input_driven_decision,
            "input-driven decision guardrails should be enabled for: {prompt}"
        );
        assert!(
            features.wants_fresh_artifact_delivery,
            "fresh artifact delivery should be enabled for: {prompt}"
        );
        assert!(
            features.wants_review,
            "review should be enabled for: {prompt}"
        );
        assert!(
            features.wants_verification,
            "verification should be enabled for: {prompt}"
        );
        assert!(
            !features.wants_backend,
            "static/reference DB wording alone must not force backend routing for: {prompt}"
        );
    }

    #[test]
    fn complex_cross_domain_reference_data_prompts_stay_frontend_without_backend_by_default() {
        let prompts = [
            [
                "도시 여행 일정 추천 웹사이트를 만들어줘",
                "사용자가 방문지와 이동수단을 카드/검색으로 입력하고, 좋아하는 장소는 즐겨찾기 목록으로 저장하지만 로그인은 없어야 해.",
                "추천 10개와 이유를 보여주고 1일차부터 5일차까지 일정이 바뀔 때마다 추천이 새로 바뀌어야 해.",
                "고려해야 할 것: 이동거리, 예산, 날씨, 운영시간, 아이 동반, 휠체어 접근성, 음식 취향, 휴무/폐점 장소 제외.",
                "장소 DB는 알아서 할것.",
            ]
            .join("\n"),
            [
                "창고 출고 작업자가 주문을 고를 때 피킹 순서를 추천해주는 웹사이트를 만들어줘",
                "주문과 SKU는 검색해서 선택하고, 자주 쓰는 구역은 즐겨찾기 목록으로 두되 로그인은 필요 없어.",
                "추천 10개, 이유 표시, 주문 1번부터 5번까지 추가될 때마다 경로와 우선순위가 새로 계산되어야 해.",
                "고려해야 할 것: 동선 거리, 무게, 냉장/상온, 파손 위험, 출고 마감, 재고 부족, 이미 잠긴 구역 제외.",
                "SKU/로케이션 DB는 알아서 할것.",
            ]
            .join("\n"),
            [
                "셀프 인테리어 자재 조합 추천 웹사이트를 만들어줘",
                "사용자는 방 크기와 예산과 원하는 분위기를 입력하고, 좋아하는 자재는 즐겨찾기 목록에 넣을 수 있어야 해. 로그인은 없어야 해.",
                "추천 10개와 이유를 보여주고 바닥/벽/조명/가구/마감재가 하나씩 바뀔 때마다 다시 추천해야 해.",
                "고려해야 할 것: 습기, 방염, 내구성, 색상 조합, 시공 순서, 예산 초과, 품절/비호환 자재 제외.",
                "자재 DB는 알아서 할것.",
            ]
            .join("\n"),
            [
                "행사 부스 운영 상황별 스태프 배치 추천 웹사이트를 만들어줘",
                "부스와 스태프는 검색해서 선택하고, 자주 쓰는 배치 템플릿은 즐겨찾기 목록으로 관리하되 로그인은 없어야 해.",
                "추천 10개와 이유를 보여주고 부스 1번부터 5번까지 배정이 추가될 때마다 추천이 새로고침되어야 해.",
                "고려해야 할 것: 혼잡도, 휴식 시간, 언어 가능 여부, 안전 역할, 이동 거리, 이미 배정된 사람/휴무자 제외.",
                "스태프 DB는 알아서 할것.",
            ]
            .join("\n"),
        ];

        for prompt in prompts {
            assert_complex_reference_data_prompt_routes_to_frontend(&prompt);
        }
    }

    #[test]
    fn explicit_database_storage_or_server_requests_still_route_to_backend() {
        let stateful_web_app = detect_goal_features(
            "여행 추천 웹앱을 만들어줘. 회원가입/로그인이 있고 사용자별 선호와 추천 결과를 DB에 저장하고 관리자 API 서버에서 조회해야 해.",
        );

        assert!(stateful_web_app.wants_frontend);
        assert!(stateful_web_app.wants_backend);
        assert!(stateful_web_app.wants_input_driven_decision);
        assert!(stateful_web_app.wants_fresh_artifact_delivery);

        let database_tool =
            detect_goal_features("Postgres database schema migration CLI tool을 만들어줘");

        assert!(!database_tool.wants_frontend);
        assert!(database_tool.wants_backend);
        assert!(database_tool.wants_fresh_artifact_delivery);
    }

    #[tokio::test]
    async fn embeds_negative_case_guardrails_for_selection_artifacts() {
        let plan = PmPlanner::new()
            .plan(
                "식당 예약 추천 웹사이트를 만들어줘. 이미 예약된 시간은 추천하면 안 돼.",
                &test_runtime(),
                &[],
                &[],
            )
            .await
            .expect("plan");

        let frontend_step = plan
            .steps
            .iter()
            .find(|step| {
                step.input
                    .get("artifact_type")
                    .and_then(|value| value.as_str())
                    == Some("frontend")
            })
            .expect("frontend step");
        assert_eq!(
            frontend_step.input["quality_guardrails"]["risk_profile"],
            "input_driven_selection"
        );
        assert_eq!(
            frontend_step.input["quality_guardrails"]["delivery_intent"],
            "fresh_artifact"
        );
        assert_eq!(
            frontend_step.input["quality_guardrails"]["dirty_workspace_policy"],
            "treat_dirty_files_as_context_not_repair_scope_unless_named"
        );

        let review_step = plan
            .steps
            .iter()
            .find(|step| step.input.get("review_scope").is_some())
            .expect("review step");
        assert_eq!(
            review_step.input["requires_negative_adversarial_case"],
            true
        );
        assert_eq!(
            review_step.input["quality_guardrails"]["requires_domain_neutral_rule_map"],
            true
        );
        assert!(review_step
            .required_capabilities
            .contains(&"negative_case_review".to_string()));

        let verification_step = plan
            .steps
            .iter()
            .find(|step| step.input.get("verify_preview").is_some())
            .expect("verification step");
        assert_eq!(
            verification_step.input["quality_guardrails"]["requires_negative_adversarial_case"],
            true
        );
        assert_eq!(verification_step.input["verify_preview"], true);
        assert!(verification_step
            .required_capabilities
            .contains(&"adversarial_testing".to_string()));
    }

    #[tokio::test]
    async fn complex_frontend_artifact_plans_split_work_to_reduce_timeout_risk() {
        let prompts = [
            [
                "도시 여행 일정 추천 웹사이트를 만들어줘",
                "방문지와 이동수단은 카드/검색으로 입력하고, 좋아하는 장소는 즐겨찾기 목록으로 저장하지만 로그인은 없어야 해.",
                "추천 10개와 이유를 보여주고 1일차부터 5일차까지 일정이 바뀔 때마다 추천이 새로 바뀌어야 해.",
                "고려해야 할 것: 이동거리, 예산, 날씨, 운영시간, 아이 동반, 휠체어 접근성, 음식 취향, 휴무/폐점 장소 제외.",
                "장소 DB는 알아서 할것.",
            ]
            .join("\n"),
            [
                "식당 예약 상황별 추천 웹사이트를 만들어줘",
                "식당과 시간대는 검색/카드로 입력하고 좋아하는 식당은 즐겨찾기 목록으로 저장하지만 로그인은 없어야 해.",
                "추천 10개와 이유를 보여주고 인원/시간/지역/음식취향/예산이 바뀔 때마다 추천이 즉시 바뀌어야 해.",
                "고려해야 할 것: 예약 가능 여부, 대기시간, 거리, 아이 동반, 주차, 알레르기, 이미 예약된 시간 제외.",
                "식당 DB는 알아서 할것.",
            ]
            .join("\n"),
            [
                "운동 루틴 추천 웹사이트를 만들어줘",
                "운동과 장비는 검색해서 선택하고 좋아하는 운동은 즐겨찾기 목록으로 저장하지만 로그인은 없어야 해.",
                "추천 10개와 이유를 보여주고 요일/시간/부상부위/목표/장비가 바뀔 때마다 추천이 다시 계산되어야 해.",
                "고려해야 할 것: 부상 위험, 운동 강도, 휴식일, 장비 유무, 소요 시간, 중복 부위, 금지 동작 제외.",
                "운동 DB는 알아서 할것.",
            ]
            .join("\n"),
        ];

        for prompt in prompts {
            let plan = PmPlanner::new()
                .plan(&prompt, &test_runtime(), &[], &[])
                .await
                .expect("plan");

            let frontend_steps = plan
                .steps
                .iter()
                .filter(|step| step.input["artifact_type"] == "frontend")
                .collect::<Vec<_>>();
            assert_eq!(frontend_steps.len(), 5);
            assert_eq!(
                frontend_steps[0].input["delivery_slice"],
                "foundation_scaffold"
            );
            assert_eq!(frontend_steps[1].input["delivery_slice"], "scoring_engine");
            assert_eq!(frontend_steps[2].input["delivery_slice"], "input_state");
            assert_eq!(
                frontend_steps[3].input["delivery_slice"],
                "persistence_recompute"
            );
            assert_eq!(frontend_steps[4].input["delivery_slice"], "results_quality");
            assert_eq!(
                frontend_steps[0].input["required_scaffold_files"],
                json!(REQUIRED_FRONTEND_SCAFFOLD_FILES)
            );
            assert_eq!(
                frontend_steps[0].input["allowed_file_focus"],
                json!(FRONTEND_SCAFFOLD_FILE_FOCUS)
            );
            assert_eq!(
                frontend_steps[1].input["allowed_file_focus"],
                json!(FRONTEND_SCORING_FILE_FOCUS)
            );
            assert_eq!(
                frontend_steps[2].input["allowed_file_focus"],
                json!(FRONTEND_INPUT_STATE_FILE_FOCUS)
            );
            assert_eq!(
                frontend_steps[3].input["allowed_file_focus"],
                json!(FRONTEND_PERSISTENCE_FILE_FOCUS)
            );
            assert_eq!(
                frontend_steps[4].input["allowed_file_focus"],
                json!(FRONTEND_RESULTS_FILE_FOCUS)
            );
            assert!(frontend_steps.iter().all(|step| {
                step.input["slice_contract"]
                    .as_str()
                    .is_some_and(|value| !value.is_empty())
                    && step.input["deferred_scope"]
                        .as_str()
                        .is_some_and(|value| !value.is_empty())
            }));
            assert!(frontend_steps[1].input["slice_contract"]
                .as_str()
                .unwrap_or_default()
                .contains("ranking"));
            assert!(frontend_steps[2].input["deferred_scope"]
                .as_str()
                .unwrap_or_default()
                .contains("favorites"));
            for index in 1..frontend_steps.len() {
                assert_eq!(
                    frontend_steps[index].depends_on,
                    vec![frontend_steps[index - 1].step_id.clone()]
                );
            }
            assert!(frontend_steps
                .iter()
                .all(|step| step.input["timeout_risk_policy"] == "bounded_frontend_slice"));

            let review_step = plan
                .steps
                .iter()
                .find(|step| step.input.get("review_scope").is_some())
                .expect("review step");
            assert!(
                frontend_steps
                    .iter()
                    .all(|step| review_step.depends_on.contains(&step.step_id)),
                "review should wait for every bounded frontend slice"
            );
        }
    }
}

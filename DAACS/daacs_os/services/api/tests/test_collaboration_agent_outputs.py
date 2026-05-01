from __future__ import annotations

import pytest

from daacs.agents.developer import DeveloperAgent
from daacs.agents.devops import DevOpsAgent
from daacs.agents.pm import PMAgent
from daacs.agents.reviewer import ReviewerAgent
from daacs.agents.verifier import VerifierAgent
from daacs.routes.collaboration import (
    AgentTeam,
    _build_discovery_search_roots,
    _build_team_context,
    _build_team_instruction,
    _fallback_planning_brief,
)


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _collaboration_context() -> dict[str, object]:
    return {
        "mode": "collaboration_round",
        "shared_goal": "Ship a safer auth flow",
        "prompt": "Implement and validate login hardening",
        "acceptance_criteria": "Ship a safer auth flow\n\nOriginal request:\nImplement and validate login hardening",
        "artifacts": "1. [development_team/developer/completed] Added auth route skeleton",
        "code": "[developer] Added api/auth.py and token validation hooks.",
        "member_instructions": {
            "developer": "Implement the requested outcome concretely.",
            "reviewer": "Review the development output for correctness and regressions.",
            "verifier": "Verify acceptance criteria coverage and missing evidence.",
            "devops": "Turn the implementation into a safe rollout plan.",
        },
        "search_roots": ["apps/web/src/components/office", "apps/web/src/services"],
        "repo_layout": "Use only the listed Search Roots for repository lookups.",
    }


def test_build_discovery_search_roots_prefers_nested_checkout_paths(tmp_path):
    workspace_root = tmp_path / "workspace"
    nested_checkout = workspace_root / "DAACS_OS"
    office_dir = nested_checkout / "apps" / "web" / "src" / "components" / "office"
    services_dir = nested_checkout / "apps" / "web" / "src" / "services"
    stores_dir = nested_checkout / "apps" / "web" / "src" / "stores"

    office_dir.mkdir(parents=True)
    services_dir.mkdir(parents=True)
    stores_dir.mkdir(parents=True)

    roots = _build_discovery_search_roots(
        "Identify which frontend file renders the Shared Board panel in the workspace modal.",
        str(workspace_root),
    )

    assert roots[:3] == [
        "DAACS_OS/apps/web/src/components/office",
        "DAACS_OS/apps/web/src/services",
        "DAACS_OS/apps/web/src/stores",
    ]


def test_build_team_instruction_uses_workspace_specific_search_roots(tmp_path):
    workspace_root = tmp_path / "workspace"
    nested_checkout = workspace_root / "DAACS_OS"
    office_dir = nested_checkout / "apps" / "web" / "src" / "components" / "office"
    services_dir = nested_checkout / "apps" / "web" / "src" / "services"
    stores_dir = nested_checkout / "apps" / "web" / "src" / "stores"
    office_dir.mkdir(parents=True)
    services_dir.mkdir(parents=True)
    stores_dir.mkdir(parents=True)

    prompt = "Identify which frontend file renders the Shared Board panel in the workspace modal."
    planning_brief = _fallback_planning_brief(prompt, prompt)
    instruction = _build_team_instruction(
        AgentTeam.DEVELOPMENT_TEAM,
        prompt=prompt,
        shared_goal=planning_brief["refined_goal"],
        prior_contributions=[],
        planning_brief=planning_brief,
        project_cwd=str(workspace_root),
        discovery_only=True,
    )

    assert "DAACS_OS/apps/web/src/components/office" in instruction
    assert "DAACS_OS/apps/web/src/services" in instruction


@pytest.mark.anyio
async def test_developer_agent_structures_collaboration_round_output(monkeypatch):
    agent = DeveloperAgent(project_id="proj-dev")

    async def _fake_execute_task(
        prompt: str,
        system_prompt: str = "",
        role_override: str | None = None,
        include_skill_prompt: bool = True,
    ) -> str:
        assert "Role Objective" in prompt
        assert "Return strict JSON only" in prompt
        assert "implementation lead" in system_prompt
        assert role_override == "developer_collaboration"
        assert include_skill_prompt is False
        return (
            '{"summary":"Updated api/auth.py and login token checks.",'
            '"new_files":["api/auth.py"],'
            '"open_questions":["Need OAuth secret rotation policy"],'
            '"next_actions":["Add login integration tests"]}'
        )

    monkeypatch.setattr(agent, "execute_task", _fake_execute_task)

    result = await agent.execute("Implement auth hardening", context=_collaboration_context())

    assert result["summary"] == "Updated api/auth.py and login token checks."
    assert result["new_files"] == ["api/auth.py"]
    assert result["open_questions"] == ["Need OAuth secret rotation policy"]
    assert result["next_actions"] == ["Add login integration tests"]


@pytest.mark.anyio
async def test_developer_agent_structures_discovery_collaboration_output(monkeypatch):
    agent = DeveloperAgent(project_id="proj-dev-discovery")

    async def _fake_execute_task(
        prompt: str,
        system_prompt: str = "",
        role_override: str | None = None,
        include_skill_prompt: bool = True,
    ) -> str:
        assert "Question" in prompt
        assert "read-only investigation" in prompt.lower()
        assert "Search Roots" in prompt
        assert "apps/web/src/components/office" in prompt
        assert "repository investigation lead" in system_prompt
        assert role_override == "developer_collaboration_discovery"
        assert include_skill_prompt is False
        return (
            '{"summary":"GoalMeetingPanel.tsx uses collaborationSessionId while SharedBoardPanel.tsx renders round status.",'
            '"new_files":["apps/web/src/components/office/GoalMeetingPanel.tsx","apps/web/src/components/office/SharedBoardPanel.tsx"],'
            '"open_questions":[],'
            '"next_actions":["Confirm the second round reuses the existing session id"]}'
        )

    monkeypatch.setattr(agent, "execute_task", _fake_execute_task)

    discovery_context = {
        **_collaboration_context(),
        "prompt": "Identify the session reuse file and the round-status render file.",
        "discovery_only": True,
    }
    result = await agent.execute("Trace the reuse path", context=discovery_context)

    assert result["summary"] == (
        "GoalMeetingPanel.tsx uses collaborationSessionId while SharedBoardPanel.tsx renders round status."
    )
    assert result["new_files"] == [
        "apps/web/src/components/office/GoalMeetingPanel.tsx",
        "apps/web/src/components/office/SharedBoardPanel.tsx",
    ]
    assert result["open_questions"] == []
    assert result["next_actions"] == ["Confirm the second round reuses the existing session id"]


@pytest.mark.anyio
async def test_developer_agent_uses_local_discovery_when_project_context_is_available(tmp_path, monkeypatch):
    project_root = tmp_path / "workspace"
    office_dir = project_root / "apps" / "web" / "src" / "components" / "office"
    office_dir.mkdir(parents=True)
    (office_dir / "GoalMeetingPanel.tsx").write_text(
        "export function GoalMeetingPanel() {\n"
        "  const activeSessionId = collaborationSessionId;\n"
        "  setCollaborationSession(projectId, session.session_id, session.shared_goal);\n"
        "}\n",
        encoding="utf-8",
    )
    (office_dir / "SharedBoardPanel.tsx").write_text(
        "export function SharedBoardPanel() {\n"
        "  return <div>Round Status</div>;\n"
        "}\n",
        encoding="utf-8",
    )

    agent = DeveloperAgent(project_id="proj-dev-local-discovery")

    async def _unexpected_execute_task(*args, **kwargs) -> str:
        raise AssertionError("LLM should not run when local discovery succeeds")

    monkeypatch.setattr(agent, "execute_task", _unexpected_execute_task)

    result = await agent.execute(
        "Identify where the web collaboration flow reuses an existing session and name the main file involved.",
        context={
            **_collaboration_context(),
            "prompt": "Identify where the web collaboration flow reuses an existing session and name the main file involved.",
            "project_cwd": str(project_root),
            "search_roots": ["apps/web/src/components/office"],
            "discovery_only": True,
        },
    )

    assert result["status"] == "completed"
    assert "GoalMeetingPanel.tsx" in result["summary"]
    assert "apps/web/src/components/office/GoalMeetingPanel.tsx" in result["new_files"]


@pytest.mark.anyio
async def test_developer_local_discovery_handles_revision_prompt_without_picking_translation_noise(
    tmp_path,
    monkeypatch,
):
    project_root = tmp_path / "workspace"
    office_dir = project_root / "apps" / "web" / "src" / "components" / "office"
    dashboard_dir = project_root / "apps" / "web" / "src" / "components" / "dashboard"
    office_dir.mkdir(parents=True)
    dashboard_dir.mkdir(parents=True)

    (office_dir / "GoalMeetingPanel.tsx").write_text(
        "export function GoalMeetingPanel() {\n"
        "  const activeSessionId = collaborationSessionId;\n"
        "  setCollaborationSession(projectId, session.session_id, session.shared_goal);\n"
        "}\n",
        encoding="utf-8",
    )
    (office_dir / "SharedBoardPanel.tsx").write_text(
        "export function SharedBoardPanel() {\n"
        "  return <div>{t(\"board.roundStatus\")}{roundStatusLabel(t, latest.status)}</div>;\n"
        "}\n",
        encoding="utf-8",
    )
    (project_root / "apps" / "web" / "src" / "i18n.tsx").write_text(
        'export const translations = { "board.roundStatus": "Round Status" };\n',
        encoding="utf-8",
    )
    (dashboard_dir / "DashboardModal.tsx").write_text(
        "export const DashboardModal = () => <div>Shared board budget status</div>;\n",
        encoding="utf-8",
    )

    agent = DeveloperAgent(project_id="proj-dev-local-revision")

    async def _unexpected_execute_task(*args, **kwargs) -> str:
        raise AssertionError("LLM should not run when local discovery succeeds")

    monkeypatch.setattr(agent, "execute_task", _unexpected_execute_task)

    result = await agent.execute(
        "Revise the previous result by also naming where the shared board renders the round status for users.",
        context={
            **_collaboration_context(),
            "prompt": "Revise the previous result by also naming where the shared board renders the round status for users.",
            "shared_goal": "Identify where the web collaboration flow reuses an existing session and name the main file involved.",
            "project_cwd": str(project_root),
            "search_roots": ["apps/web/src"],
            "discovery_only": True,
            "prior_contributions": [
                {
                    "agent_role": "developer",
                    "summary": "GoalMeetingPanel.tsx reuses collaborationSessionId.",
                    "new_files": ["apps/web/src/components/office/GoalMeetingPanel.tsx"],
                }
            ],
        },
    )

    assert result["status"] == "completed"
    assert "GoalMeetingPanel.tsx" in result["summary"]
    assert "SharedBoardPanel.tsx" in result["summary"]
    assert "i18n.tsx" not in result["summary"]
    assert "DashboardModal.tsx" not in result["summary"]
    assert result["new_files"][:2] == [
        "apps/web/src/components/office/GoalMeetingPanel.tsx",
        "apps/web/src/components/office/SharedBoardPanel.tsx",
    ]


@pytest.mark.anyio
async def test_developer_local_discovery_prefers_office_component_over_store_noise(
    tmp_path,
    monkeypatch,
):
    project_root = tmp_path / "workspace"
    office_dir = project_root / "apps" / "web" / "src" / "components" / "office"
    stores_dir = project_root / "apps" / "web" / "src" / "stores"
    office_dir.mkdir(parents=True)
    stores_dir.mkdir(parents=True)

    (office_dir / "GoalMeetingPanel.tsx").write_text(
        "export function GoalMeetingPanel() {\n"
        "  setCollaborationSession(projectId, session.session_id, session.shared_goal);\n"
        "}\n",
        encoding="utf-8",
    )
    (stores_dir / "officeStore.ts").write_text(
        "export function buildRoomsFromZones() {\n"
        "  const collaborationSessionId = 'noise';\n"
        "  return [];\n"
        "}\n",
        encoding="utf-8",
    )

    agent = DeveloperAgent(project_id="proj-dev-local-office-priority")

    async def _unexpected_execute_task(*args, **kwargs) -> str:
        raise AssertionError("LLM should not run when local discovery succeeds")

    monkeypatch.setattr(agent, "execute_task", _unexpected_execute_task)

    result = await agent.execute(
        "Identify where the web collaboration flow reuses an existing session and name the main file involved.",
        context={
            **_collaboration_context(),
            "prompt": "Identify where the web collaboration flow reuses an existing session and name the main file involved.",
            "project_cwd": str(project_root),
            "search_roots": ["apps/web/src/components/office", "apps/web/src/stores"],
            "discovery_only": True,
        },
    )

    assert "GoalMeetingPanel.tsx" in result["summary"]
    assert "officeStore.ts" not in result["summary"]
    assert result["new_files"][0] == "apps/web/src/components/office/GoalMeetingPanel.tsx"


@pytest.mark.anyio
async def test_developer_local_discovery_ignores_search_root_terms_from_route_instruction(
    tmp_path,
    monkeypatch,
):
    project_root = tmp_path / "workspace"
    office_dir = project_root / "apps" / "web" / "src" / "components" / "office"
    stores_dir = project_root / "apps" / "web" / "src" / "stores"
    services_dir = project_root / "apps" / "web" / "src" / "services"
    office_dir.mkdir(parents=True)
    stores_dir.mkdir(parents=True)
    services_dir.mkdir(parents=True)

    (office_dir / "GoalMeetingPanel.tsx").write_text(
        "export function GoalMeetingPanel() {\n"
        "  const activeSessionId = collaborationSessionId;\n"
        "  setCollaborationSession(projectId, session.session_id, session.shared_goal);\n"
        "}\n",
        encoding="utf-8",
    )
    (stores_dir / "officeStore.ts").write_text(
        "export function buildRoomsFromZones(zones) {\n"
        "  const room = { kind: 'office' };\n"
        "  return zones.map(() => room);\n"
        "}\n",
        encoding="utf-8",
    )
    (services_dir / "collaborationApi.ts").write_text(
        "export async function createCollaborationSession() {\n"
        "  return { session_id: 'sess-1' };\n"
        "}\n",
        encoding="utf-8",
    )

    agent = DeveloperAgent(project_id="proj-dev-local-route-instruction")

    async def _unexpected_execute_task(*args, **kwargs) -> str:
        raise AssertionError("LLM should not run when local discovery succeeds")

    monkeypatch.setattr(agent, "execute_task", _unexpected_execute_task)

    prompt = "Identify where the web collaboration flow reuses an existing session and name the main file involved."
    planning_brief = _fallback_planning_brief(prompt, prompt)
    prior_contributions = [
        {
            "team": "planning_team",
            "agent_role": "pm",
            "status": "completed",
            "summary": planning_brief["plan_summary"],
            "open_questions": [],
            "next_actions": planning_brief["deliverables"],
            "details": {
                "refined_goal": planning_brief["refined_goal"],
                "acceptance_criteria": planning_brief["acceptance_criteria"],
                "deliverables": planning_brief["deliverables"],
                "review_focus": planning_brief["review_focus"],
                "verification_focus": planning_brief["verification_focus"],
                "ops_focus": planning_brief["ops_focus"],
            },
        }
    ]
    instruction = _build_team_instruction(
        AgentTeam.DEVELOPMENT_TEAM,
        prompt=prompt,
        shared_goal=planning_brief["refined_goal"],
        prior_contributions=prior_contributions,
        planning_brief=planning_brief,
        discovery_only=True,
    )
    context = _build_team_context(
        AgentTeam.DEVELOPMENT_TEAM,
        prompt=prompt,
        shared_goal=planning_brief["refined_goal"],
        prior_contributions=prior_contributions,
        planning_brief=planning_brief,
        project_cwd=str(project_root),
        discovery_only=True,
    )

    result = await agent.execute(instruction, context=context)

    assert "GoalMeetingPanel.tsx" in result["summary"]
    assert "officeStore.ts" not in result["summary"]
    assert result["new_files"][0] == "apps/web/src/components/office/GoalMeetingPanel.tsx"


@pytest.mark.anyio
async def test_developer_local_discovery_skips_empty_files_without_crashing(
    tmp_path,
    monkeypatch,
):
    project_root = tmp_path / "workspace"
    office_dir = project_root / "apps" / "web" / "src" / "components" / "office"
    services_dir = project_root / "apps" / "web" / "src" / "services"
    routes_dir = project_root / "services" / "api" / "daacs" / "routes"
    office_dir.mkdir(parents=True)
    services_dir.mkdir(parents=True)
    routes_dir.mkdir(parents=True)

    (office_dir / "EmptyPanel.tsx").write_text("", encoding="utf-8")
    (office_dir / "GoalMeetingPanel.tsx").write_text(
        "export function GoalMeetingPanel() {\n"
        "  setCollaborationSession(projectId, session.session_id, session.shared_goal);\n"
        "  return null;\n"
        "}\n",
        encoding="utf-8",
    )
    (services_dir / "collaborationApi.ts").write_text(
        "export async function createCollaborationSession() {\n"
        "  return { session_id: 'sess-1' };\n"
        "}\n",
        encoding="utf-8",
    )
    (routes_dir / "collaboration.py").write_text(
        "def start_round():\n"
        "    return {'status': 'ok'}\n",
        encoding="utf-8",
    )

    agent = DeveloperAgent(project_id="proj-dev-local-empty-file")

    async def _unexpected_execute_task(*args, **kwargs) -> str:
        raise AssertionError("LLM should not run when local discovery succeeds")

    monkeypatch.setattr(agent, "execute_task", _unexpected_execute_task)

    result = await agent.execute(
        "Question: Discovery only. Inspect the current DAACS_OS repository and identify the exact file paths responsible for (1) creating a collaboration session in the web flow, (2) starting a collaboration round, and (3) rendering the round artifact in the shared board UI. Do not edit any files. Include concrete verification evidence from the repo and call out any uncertainty explicitly.",
        context={
            **_collaboration_context(),
            "prompt": "Discovery only. Inspect the current DAACS_OS repository and identify the exact file paths responsible for (1) creating a collaboration session in the web flow, (2) starting a collaboration round, and (3) rendering the round artifact in the shared board UI. Do not edit any files. Include concrete verification evidence from the repo and call out any uncertainty explicitly.",
            "shared_goal": "Discovery only. Inspect the current DAACS_OS repository and identify the exact file paths responsible for (1) creating a collaboration session in the web flow, (2) starting a collaboration round, and (3) rendering the round artifact in the shared board UI. Do not edit any files. Include concrete verification evidence from the repo and call out any uncertainty explicitly.",
            "project_cwd": str(project_root),
            "search_roots": [
                "apps/web/src/components/office",
                "apps/web/src/services",
                "services/api/daacs/routes",
            ],
            "discovery_only": True,
        },
    )

    assert result["status"] == "completed"
    assert "GoalMeetingPanel.tsx" in result["summary"]
    assert "EmptyPanel.tsx" not in result["summary"]
    assert "apps/web/src/components/office/GoalMeetingPanel.tsx" in result["new_files"]


@pytest.mark.anyio
async def test_developer_local_discovery_maps_web_flow_round_and_board_paths(
    tmp_path,
    monkeypatch,
):
    project_root = tmp_path / "workspace"
    office_dir = project_root / "apps" / "web" / "src" / "components" / "office"
    services_dir = project_root / "apps" / "web" / "src" / "services"
    stores_dir = project_root / "apps" / "web" / "src" / "stores"
    routes_dir = project_root / "services" / "api" / "daacs" / "routes"
    office_dir.mkdir(parents=True)
    services_dir.mkdir(parents=True)
    stores_dir.mkdir(parents=True)
    routes_dir.mkdir(parents=True)

    (office_dir / "GoalMeetingPanel.tsx").write_text(
        "export function GoalMeetingPanel() {\n"
        "  const activeSessionId = collaborationSessionId;\n"
        "  await createCollaborationSession(projectId, goalText, []);\n"
        "  setCollaborationSession(projectId, session.session_id, session.shared_goal);\n"
        "}\n",
        encoding="utf-8",
    )
    (office_dir / "SharedBoardPanel.tsx").write_text(
        "export function SharedBoardPanel() {\n"
        "  return <div>{latest.decision}{latest.contributions?.length}{'Round Status'}</div>;\n"
        "}\n",
        encoding="utf-8",
    )
    (services_dir / "collaborationApi.ts").write_text(
        "export async function createCollaborationSession() {\n"
        "  return { session_id: 'sess-1' };\n"
        "}\n"
        "export async function startCollaborationRound() {\n"
        "  return { status: 'completed' };\n"
        "}\n",
        encoding="utf-8",
    )
    (stores_dir / "collaborationStore.ts").write_text(
        "export const useCollaborationStore = create(() => ({\n"
        "  artifacts: [],\n"
        "  addRoundArtifact: (artifact) => artifact,\n"
        "}));\n",
        encoding="utf-8",
    )
    (routes_dir / "collaboration.py").write_text(
        "async def create_collaboration_session():\n"
        "    return {'session_id': 'sess-1'}\n"
        "async def start_collaboration_round():\n"
        "    return {'status': 'completed'}\n",
        encoding="utf-8",
    )

    agent = DeveloperAgent(project_id="proj-dev-local-web-flow-map")

    async def _unexpected_execute_task(*args, **kwargs) -> str:
        raise AssertionError("LLM should not run when local discovery succeeds")

    monkeypatch.setattr(agent, "execute_task", _unexpected_execute_task)

    result = await agent.execute(
        "Discovery only. Inspect the current DAACS_OS repository and identify the exact file paths responsible for (1) creating a collaboration session in the web flow, (2) starting a collaboration round, and (3) rendering the round artifact in the shared board UI. Do not edit any files. Include concrete verification evidence from the repo and call out any uncertainty explicitly.",
        context={
            **_collaboration_context(),
            "prompt": "Discovery only. Inspect the current DAACS_OS repository and identify the exact file paths responsible for (1) creating a collaboration session in the web flow, (2) starting a collaboration round, and (3) rendering the round artifact in the shared board UI. Do not edit any files. Include concrete verification evidence from the repo and call out any uncertainty explicitly.",
            "shared_goal": "Discovery only. Inspect the current DAACS_OS repository and identify the exact file paths responsible for (1) creating a collaboration session in the web flow, (2) starting a collaboration round, and (3) rendering the round artifact in the shared board UI. Do not edit any files. Include concrete verification evidence from the repo and call out any uncertainty explicitly.",
            "project_cwd": str(project_root),
            "search_roots": [
                "apps/web/src/components/office",
                "apps/web/src/services",
                "apps/web/src/stores",
                "services/api/daacs/routes",
            ],
            "discovery_only": True,
        },
    )

    assert result["status"] == "completed"
    assert "GoalMeetingPanel.tsx" in result["summary"]
    assert "collaborationApi.ts" in result["summary"]
    assert "SharedBoardPanel.tsx" in result["summary"]
    assert "services/api/daacs/routes/collaboration.py" not in result["summary"]
    assert "apps/web/src/components/office/GoalMeetingPanel.tsx" in result["new_files"]
    assert "apps/web/src/services/collaborationApi.ts" in result["new_files"]
    assert "apps/web/src/components/office/SharedBoardPanel.tsx" in result["new_files"]


@pytest.mark.anyio
async def test_developer_local_discovery_revision_adds_collaboration_store_mapping(
    tmp_path,
    monkeypatch,
):
    project_root = tmp_path / "workspace"
    office_dir = project_root / "apps" / "web" / "src" / "components" / "office"
    services_dir = project_root / "apps" / "web" / "src" / "services"
    stores_dir = project_root / "apps" / "web" / "src" / "stores"
    office_dir.mkdir(parents=True)
    services_dir.mkdir(parents=True)
    stores_dir.mkdir(parents=True)

    (office_dir / "GoalMeetingPanel.tsx").write_text(
        "export function GoalMeetingPanel() {\n"
        "  setCollaborationSession(projectId, session.session_id, session.shared_goal);\n"
        "  return null;\n"
        "}\n",
        encoding="utf-8",
    )
    (office_dir / "SharedBoardPanel.tsx").write_text(
        "export function SharedBoardPanel() {\n"
        "  return <div>{latest.decision}{latest.contributions?.length}</div>;\n"
        "}\n",
        encoding="utf-8",
    )
    (services_dir / "collaborationApi.ts").write_text(
        "export async function startCollaborationRound() {\n"
        "  return { status: 'completed' };\n"
        "}\n",
        encoding="utf-8",
    )
    (stores_dir / "collaborationStore.ts").write_text(
        "export const useCollaborationStore = create((set) => ({\n"
        "  artifacts: [],\n"
        "  addRoundArtifact: (artifact) => set((s) => ({ artifacts: [...s.artifacts, artifact] })),\n"
        "}));\n",
        encoding="utf-8",
    )

    agent = DeveloperAgent(project_id="proj-dev-local-store-revision")

    async def _unexpected_execute_task(*args, **kwargs) -> str:
        raise AssertionError("LLM should not run when local discovery succeeds")

    monkeypatch.setattr(agent, "execute_task", _unexpected_execute_task)

    result = await agent.execute(
        "Revision request: keep this read-only, but rewrite the discovery result as a compact checklist with exact file paths for (1) the UI entry point that creates/reuses the collaboration session, (2) the API helper that starts a collaboration round, (3) the shared board component that renders the merged artifact, and (4) the store that publishes the latest artifact to the board. Explicitly state whether this second round reused the same collaboration session.",
        context={
            **_collaboration_context(),
            "prompt": "Revision request: keep this read-only, but rewrite the discovery result as a compact checklist with exact file paths for (1) the UI entry point that creates/reuses the collaboration session, (2) the API helper that starts a collaboration round, (3) the shared board component that renders the merged artifact, and (4) the store that publishes the latest artifact to the board. Explicitly state whether this second round reused the same collaboration session.",
            "shared_goal": "Discovery only. Inspect the current DAACS_OS repository and identify the exact file paths responsible for (1) creating a collaboration session in the web flow, (2) starting a collaboration round, and (3) rendering the round artifact in the shared board UI. Do not edit any files. Include concrete verification evidence from the repo and call out any uncertainty explicitly.",
            "project_cwd": str(project_root),
            "search_roots": [
                "apps/web/src/components/office",
                "apps/web/src/services",
                "apps/web/src/stores",
            ],
            "discovery_only": True,
            "prior_contributions": [
                {
                    "agent_role": "developer",
                    "summary": "GoalMeetingPanel.tsx and SharedBoardPanel.tsx were already identified for the original round.",
                    "new_files": [
                        "apps/web/src/components/office/GoalMeetingPanel.tsx",
                        "apps/web/src/components/office/SharedBoardPanel.tsx",
                    ],
                }
            ],
        },
    )

    assert result["status"] == "completed"
    assert "GoalMeetingPanel.tsx" in result["summary"]
    assert "collaborationApi.ts" in result["summary"]
    assert "SharedBoardPanel.tsx" in result["summary"]
    assert "collaborationStore.ts" in result["summary"]
    assert "apps/web/src/stores/collaborationStore.ts" in result["new_files"]


@pytest.mark.anyio
async def test_developer_local_discovery_revision_adds_backend_round_route_mapping(
    tmp_path,
    monkeypatch,
):
    project_root = tmp_path / "workspace"
    office_dir = project_root / "apps" / "web" / "src" / "components" / "office"
    routes_dir = project_root / "services" / "api" / "daacs" / "routes"
    office_dir.mkdir(parents=True)
    routes_dir.mkdir(parents=True)

    (office_dir / "SharedBoardPanel.tsx").write_text(
        "export function SharedBoardPanel() {\n"
        "  return <div>{latest.decision}{latest.contributions?.length}</div>;\n"
        "}\n",
        encoding="utf-8",
    )
    (routes_dir / "collaboration.py").write_text(
        "from fastapi import APIRouter\n"
        "router = APIRouter(prefix='/api/collaboration')\n"
        "@router.post('/{project_id}/sessions/{session_id}/rounds')\n"
        "async def start_collaboration_round():\n"
        "    return {'status': 'completed'}\n",
        encoding="utf-8",
    )
    (routes_dir / "runtime.py").write_text(
        "from fastapi import APIRouter\n"
        "router = APIRouter(prefix='/api/projects')\n"
        "@router.post('/{project_id}/runtime/bootstrap')\n"
        "async def bootstrap_runtime():\n"
        "    return {'status': 'ok'}\n",
        encoding="utf-8",
    )

    agent = DeveloperAgent(project_id="proj-dev-local-route-revision")

    async def _unexpected_execute_task(*args, **kwargs) -> str:
        raise AssertionError("LLM should not run when local discovery succeeds")

    monkeypatch.setattr(agent, "execute_task", _unexpected_execute_task)

    prompt = (
        "Revision request: keep this read-only, but add the backend route file that serves "
        "collaboration round responses and present the answer as a compact checklist with exact file paths."
    )
    result = await agent.execute(
        prompt,
        context={
            **_collaboration_context(),
            "prompt": prompt,
            "shared_goal": (
                "Identify the exact frontend file that renders the Shared Board panel in the workspace modal. "
                "Return only the file path and a one-sentence role summary."
            ),
            "project_cwd": str(project_root),
            "search_roots": [
                "apps/web/src/components/office",
                "services/api/daacs/routes",
            ],
            "discovery_only": True,
            "prior_contributions": [
                {
                    "agent_role": "developer",
                    "summary": (
                        "Read-only discovery matched: "
                        "apps/web/src/components/office/SharedBoardPanel.tsx::SharedBoardPanel"
                    ),
                    "new_files": [
                        "apps/web/src/components/office/SharedBoardPanel.tsx",
                    ],
                }
            ],
        },
    )

    assert result["status"] == "completed"
    assert "SharedBoardPanel.tsx" in result["summary"]
    assert "services/api/daacs/routes/collaboration.py" in result["summary"]
    assert "start_collaboration_round" in result["summary"]
    assert "runtime.py" not in result["summary"]
    assert "apps/web/src/components/office/SharedBoardPanel.tsx" in result["new_files"]
    assert "services/api/daacs/routes/collaboration.py" in result["new_files"]


@pytest.mark.anyio
async def test_developer_local_discovery_korean_revision_maps_classifier_timeout_and_shared_board(
    tmp_path,
    monkeypatch,
):
    project_root = tmp_path / "workspace"
    office_dir = project_root / "apps" / "web" / "src" / "components" / "office"
    routes_dir = project_root / "services" / "api" / "daacs" / "routes"
    office_dir.mkdir(parents=True)
    routes_dir.mkdir(parents=True)

    (office_dir / "SharedBoardPanel.tsx").write_text(
        "function roundStatusLabel(status) {\n"
        "  return status;\n"
        "}\n"
        "export function SharedBoardPanel({ latest }) {\n"
        "  return <div>{roundStatusLabel(latest.status)}</div>;\n"
        "}\n",
        encoding="utf-8",
    )
    (routes_dir / "collaboration.py").write_text(
        "COLLAB_RESULT_TIMEOUT_SECONDS = 120.0\n"
        "DISCOVERY_ONLY_HINTS = ('identify', '점검')\n"
        "def _is_discovery_only_request(prompt: str) -> bool:\n"
        "    return 'identify' in prompt\n\n"
        "async def _plan_round_with_pm():\n"
        "    return await _wait_for_multi_results()\n\n"
        "async def _wait_for_multi_results():\n"
        "    logger.warning('collaboration round timed out waiting for tasks')\n"
        "    return []\n",
        encoding="utf-8",
    )

    agent = DeveloperAgent(project_id="proj-dev-korean-discovery-revision")

    async def _unexpected_execute_task(*args, **kwargs) -> str:
        raise AssertionError("LLM should not run when local discovery succeeds")

    monkeypatch.setattr(agent, "execute_task", _unexpected_execute_task)

    prompt = (
        "이전 결과를 수정해서 현재 120초 타임아웃이 발생하는 정확한 파일과 함수 이름을 추가해줘. "
        "특히 discovery 판별, 개발자 실행 타임아웃, 공유 보드 상태 렌더 위치를 각각 절대 경로 기준으로 정리해줘."
    )
    result = await agent.execute(
        prompt,
        context={
            **_collaboration_context(),
            "prompt": prompt,
            "shared_goal": "사용자 관점에서 DAACS 웹 협업 흐름을 점검하고 가장 먼저 고쳐야 할 문제를 체크리스트로 정리해줘.",
            "project_cwd": str(project_root),
            "search_roots": [
                "apps/web/src/components/office",
                "services/api/daacs/routes",
            ],
            "discovery_only": True,
            "prior_contributions": [
                {
                    "agent_role": "developer",
                    "summary": "이전 결과는 timeout 파일 한 곳만 짚었다.",
                    "new_files": [
                        "services/api/daacs/routes/collaboration.py",
                    ],
                }
            ],
        },
    )

    assert result["status"] == "completed"
    assert "discovery_classifier: services/api/daacs/routes/collaboration.py::_is_discovery_only_request" in result["summary"]
    assert "timeout_control: services/api/daacs/routes/collaboration.py::_wait_for_multi_results" in result["summary"]
    assert "shared_board: apps/web/src/components/office/SharedBoardPanel.tsx::roundStatusLabel" in result["summary"]
    assert "services/api/daacs/routes/collaboration.py" in result["new_files"]
    assert "apps/web/src/components/office/SharedBoardPanel.tsx" in result["new_files"]
    assert not any(path.endswith(".test.ts") for path in result["new_files"])
    assert result["discovery_checklist"] == [
        {
            "target": "shared_board",
            "path": "apps/web/src/components/office/SharedBoardPanel.tsx",
            "symbol": "roundStatusLabel",
            "evidence": "function roundStatusLabel(status) {",
        },
        {
            "target": "discovery_classifier",
            "path": "services/api/daacs/routes/collaboration.py",
            "symbol": "_is_discovery_only_request",
            "evidence": "def _is_discovery_only_request(prompt: str) -> bool:",
        },
        {
            "target": "timeout_control",
            "path": "services/api/daacs/routes/collaboration.py",
            "symbol": "_wait_for_multi_results",
            "evidence": "COLLAB_RESULT_TIMEOUT_SECONDS = 120.0",
        },
    ]


@pytest.mark.anyio
async def test_pm_agent_structures_collaboration_planning_output(monkeypatch):
    agent = PMAgent(project_id="proj-pm")

    async def _fake_execute_task(
        prompt: str,
        system_prompt: str = "",
        role_override: str | None = None,
        include_skill_prompt: bool = True,
    ) -> str:
        assert "Return strict JSON only" in prompt
        assert "execution brief" in system_prompt
        assert role_override == "pm_collaboration"
        assert include_skill_prompt is False
        return (
            '{"refined_goal":"Ship auth hardening with proof and rollout safety.",'
            '"plan_summary":"Clarify deliverables, then verify and roll out safely.",'
            '"acceptance_criteria":["Login hardening changes are explicit","Rollback safety is verified"],'
            '"deliverables":["Concrete code changes","Verification evidence"],'
            '"review_focus":["Regression risk"],'
            '"verification_focus":["Acceptance coverage"],'
            '"ops_focus":["Canary safety"],'
            '"execution_card":"Tighten the login hardening slice without broadening the round.",'
            '"primary_focus":"Ship the login hardening code path first.",'
            '"done_for_this_round":"The login hardening slice is explicit and reviewable.",'
            '"do_not_expand":["Do not broaden into unrelated auth cleanup"]}'
        )

    monkeypatch.setattr(agent, "execute_task", _fake_execute_task)

    result = await agent.execute(
        "Plan auth hardening",
        context={
            "mode": "collaboration_planning",
            "shared_goal": "Ship auth hardening",
            "prompt": "Implement and validate login hardening",
        },
    )

    assert result["refined_goal"] == "Ship auth hardening with proof and rollout safety."
    assert result["deliverables"] == ["Concrete code changes", "Verification evidence"]
    assert result["review_focus"] == ["Regression risk"]
    assert result["verification_focus"] == ["Acceptance coverage"]
    assert result["ops_focus"] == ["Canary safety"]
    assert result["execution_card"] == "Tighten the login hardening slice without broadening the round."
    assert result["primary_focus"] == "Ship the login hardening code path first."
    assert result["done_for_this_round"] == "The login hardening slice is explicit and reviewable."
    assert result["do_not_expand"] == ["Do not broaden into unrelated auth cleanup"]


@pytest.mark.anyio
async def test_pm_agent_structures_collaboration_synthesis_output(monkeypatch):
    agent = PMAgent(project_id="proj-pm-synthesis")

    async def _fake_execute_task(
        prompt: str,
        system_prompt: str = "",
        role_override: str | None = None,
        include_skill_prompt: bool = True,
    ) -> str:
        assert "Team contributions JSON" in prompt
        assert "consolidating multi-agent collaboration" in system_prompt
        assert role_override == "pm_collaboration"
        assert include_skill_prompt is False
        return (
            '{"decision":"GoalMeetingPanel.tsx reuses the session while SharedBoardPanel.tsx renders round status.",'
            '"refined_goal":"Trace how the web flow reuses a collaboration session and reports the result.",'
            '"acceptance_criteria":["Name the session reuse entry point","Name the shared board rendering point"],'
            '"deliverables":["Exact path for session reuse","Exact path for board rendering"],'
            '"project_fit_summary":"The output is concrete enough to guide the next implementation step.",'
            '"artifact_type":"result_report",'
            '"open_questions":["None"],'
            '"next_actions":["Verify session reuse on second round"]}'
        )

    monkeypatch.setattr(agent, "execute_task", _fake_execute_task)

    result = await agent.execute(
        "Synthesize collaboration findings",
        context={
            "mode": "collaboration_synthesis",
            "shared_goal": "Trace session reuse",
            "prompt": "Find the session reuse path and board status rendering.",
            "contributions": [{"agent_role": "developer", "summary": "GoalMeetingPanel.tsx handles session reuse."}],
        },
    )

    assert result["decision"] == "GoalMeetingPanel.tsx reuses the session while SharedBoardPanel.tsx renders round status."
    assert result["refined_goal"] == "Trace how the web flow reuses a collaboration session and reports the result."
    assert result["acceptance_criteria"] == [
        "Name the session reuse entry point",
        "Name the shared board rendering point",
    ]
    assert result["deliverables"] == [
        "Exact path for session reuse",
        "Exact path for board rendering",
    ]
    assert result["project_fit_summary"] == "The output is concrete enough to guide the next implementation step."
    assert result["artifact_type"] == "result_report"
    assert result["open_questions"] == ["None"]
    assert result["next_actions"] == ["Verify session reuse on second round"]


@pytest.mark.anyio
async def test_reviewer_agent_structures_collaboration_round_output(monkeypatch):
    agent = ReviewerAgent(project_id="proj-review")

    async def _fake_execute_task(
        prompt: str,
        system_prompt: str = "",
        role_override: str | None = None,
        include_skill_prompt: bool = True,
    ) -> str:
        assert "Code / Diff Context" in prompt
        assert "principal reviewer" in system_prompt
        assert "user-visible requirement coverage" in system_prompt
        assert "transient generated artifacts" in system_prompt
        assert "verdict must be fail" in prompt
        assert role_override == "reviewer_collaboration"
        assert include_skill_prompt is False
        return (
            '{"summary":"Rollback path still lacks regression coverage.",'
            '"issues":["Rollback failure path has no regression test"],'
            '"open_questions":["Should rollback be idempotent?"],'
            '"next_actions":["Add rollback regression coverage"],'
            '"score":6,'
            '"verdict":"fail"}'
        )

    monkeypatch.setattr(agent, "execute_task", _fake_execute_task)

    result = await agent.execute("Review auth hardening", context=_collaboration_context())

    assert result["issues"] == ["Rollback failure path has no regression test"]
    assert result["open_questions"] == ["Should rollback be idempotent?"]
    assert result["next_actions"] == ["Add rollback regression coverage"]
    assert result["score"] == 6
    assert result["verdict"] == "fail"


@pytest.mark.anyio
async def test_reviewer_agent_fail_closes_invalid_pass_with_open_findings(monkeypatch):
    agent = ReviewerAgent(project_id="proj-review-invalid-pass")

    async def _fake_execute_task(
        prompt: str,
        system_prompt: str = "",
        role_override: str | None = None,
        include_skill_prompt: bool = True,
    ) -> str:
        return (
            '{"summary":"Looks mostly good.",'
            '"issues":["Rollback failure path still lacks a regression test"],'
            '"open_questions":["Should rollback be idempotent?"],'
            '"next_actions":[],'
            '"score":8,'
            '"verdict":"pass"}'
        )

    monkeypatch.setattr(agent, "execute_task", _fake_execute_task)

    result = await agent.execute("Review auth hardening", context=_collaboration_context())

    assert result["verdict"] == "fail"
    assert result["issues"] == ["Rollback failure path still lacks a regression test"]
    assert result["open_questions"] == ["Should rollback be idempotent?"]
    assert "Resolve the outstanding review issues before treating this work as passing." in result["next_actions"]
    assert "Close the unresolved review questions before treating this work as passing." in result["next_actions"]


@pytest.mark.anyio
async def test_verifier_agent_structures_collaboration_round_output(monkeypatch):
    agent = VerifierAgent(project_id="proj-verify")

    async def _fake_execute_task(
        prompt: str,
        system_prompt: str = "",
        role_override: str | None = None,
        include_skill_prompt: bool = True,
    ) -> str:
        assert "Acceptance Criteria" in prompt
        assert "verification lead" in system_prompt
        assert "user-perspective flow evidence" in system_prompt
        assert "build/lint alone is not enough" in prompt
        assert "verdict must be fail" in prompt
        assert role_override == "verifier_collaboration"
        assert include_skill_prompt is False
        return (
            '{"summary":"Acceptance coverage is incomplete until rollback is validated.",'
            '"blockers":["Rollback failure handling has no proof"],'
            '"open_questions":["What log evidence proves rollback safety?"],'
            '"next_actions":["Run rollback integration test"],'
            '"checks":["pytest tests/auth/test_login.py"],'
            '"evidence":["Missing rollback test output"],'
            '"verdict":"fail"}'
        )

    monkeypatch.setattr(agent, "execute_task", _fake_execute_task)

    result = await agent.execute("Verify auth hardening", context=_collaboration_context())

    assert result["blockers"] == ["Rollback failure handling has no proof"]
    assert result["open_questions"] == [
        "Rollback failure handling has no proof",
        "What log evidence proves rollback safety?",
    ]
    assert result["checks"] == ["pytest tests/auth/test_login.py"]
    assert result["evidence"] == ["Missing rollback test output"]
    assert result["verdict"] == "fail"


@pytest.mark.anyio
async def test_verifier_agent_fail_closes_invalid_pass_without_checks_or_evidence(monkeypatch):
    agent = VerifierAgent(project_id="proj-verify-invalid-pass")

    async def _fake_execute_task(
        prompt: str,
        system_prompt: str = "",
        role_override: str | None = None,
        include_skill_prompt: bool = True,
    ) -> str:
        return (
            '{"summary":"Everything looks releasable.",'
            '"blockers":[],'
            '"open_questions":[],'
            '"next_actions":[],'
            '"checks":[],'
            '"evidence":[],'
            '"verdict":"pass"}'
        )

    monkeypatch.setattr(agent, "execute_task", _fake_execute_task)

    result = await agent.execute("Verify auth hardening", context=_collaboration_context())

    assert result["verdict"] == "fail"
    assert "Verification pass is invalid without executed checks." in result["blockers"]
    assert "Verification pass is invalid without concrete evidence." in result["blockers"]
    assert "Run the missing verification checks." in result["next_actions"]
    assert "Attach concrete verification evidence before release." in result["next_actions"]
    assert result["open_questions"] == [
        "Verification pass is invalid without executed checks.",
        "Verification pass is invalid without concrete evidence.",
    ]


@pytest.mark.anyio
async def test_devops_agent_structures_collaboration_round_output(monkeypatch):
    agent = DevOpsAgent(project_id="proj-ops")

    async def _fake_execute_task(
        prompt: str,
        system_prompt: str = "",
        role_override: str | None = None,
        include_skill_prompt: bool = True,
    ) -> str:
        assert "Prior Artifacts" in prompt
        assert "operations lead" in system_prompt
        assert include_skill_prompt is False
        return (
            '{"summary":"Canary rollout needs auth error-rate alerts.",'
            '"open_questions":["What is the acceptable login failure threshold?"],'
            '"next_actions":["Define canary abort threshold"],'
            '"deployment_plan":["Ship to canary first"],'
            '"health_checks":["Track login success ratio"],'
            '"monitoring_setup":["Create auth error-rate alert"]}'
        )

    monkeypatch.setattr(agent, "execute_task", _fake_execute_task)

    result = await agent.execute("Plan auth rollout", context=_collaboration_context())

    assert result["summary"] == "Canary rollout needs auth error-rate alerts."
    assert result["open_questions"] == ["What is the acceptable login failure threshold?"]
    assert result["deployment_plan"] == ["Ship to canary first"]
    assert result["health_checks"] == ["Track login success ratio"]
    assert result["monitoring_setup"] == ["Create auth error-rate alert"]
    assert result["next_actions"] == [
        "Define canary abort threshold",
        "Ship to canary first",
        "Track login success ratio",
        "Create auth error-rate alert",
    ]

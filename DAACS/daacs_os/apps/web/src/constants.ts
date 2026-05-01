export const STORAGE_KEY_LOCALE = "daacs_locale";
export const STORAGE_KEY_ACTIVE_PROJECT = "daacs_active_project_id";
export const STORAGE_KEY_BILLING_TRACK = "daacs_billing_track";
export const STORAGE_KEY_CLI_WORKSPACE = "daacs_cli_workspace_path";
export const STORAGE_KEY_CLI_PROVIDER = "daacs_cli_provider";
export const STORAGE_KEY_LOCAL_LLM_BASE_URL = "daacs_local_llm_base_url";
export const STORAGE_KEY_OWNER_DOCK_POS = "daacs_owner_dock_pos";
export const STORAGE_KEY_COLLAB_DOCK_POS = "daacs_collab_dock_pos";
export const STORAGE_KEY_ACCESS_TOKEN = "daacs_access_token";
export const STORAGE_KEY_DASHBOARD_LAYOUT_PREFIX = "daacs_dashboard_layout";
export const STORAGE_KEY_FACTORY_DRAFT = "daacs_factory_draft";
export const STORAGE_KEY_OFFICE_STATE_PREFIX = "daacs_office_state";
export const STORAGE_KEY_GLOBAL_OFFICE_STATE = "daacs_global_office_state";

export const COOKIE_NAME_CSRF = "daacs_csrf_token";
export const HEADER_NAME_CSRF = "X-CSRF-Token";

export const DEFAULT_API_PORT = 8001;
export const DEFAULT_API_BASE = "http://127.0.0.1:8001";

export const AUTH_PATH_PREFIX = "/api/auth/";
export const PATH_HEALTH = "/health";
export const PATH_AUTH_LOGIN = "/api/auth/login";
export const PATH_AUTH_REGISTER = "/api/auth/register";
export const PATH_AUTH_ME = "/api/auth/me";
export const PATH_AUTH_LOGOUT = "/api/auth/logout";
export const PATH_AUTH_PROJECTS = "/api/auth/projects";
export const PATH_PROJECTS_CLOCK_IN = "/api/projects";
export const PATH_AGENTS = "/api/agents";
export const PATH_TEAMS = "/api/teams";
export const PATH_SKILLS = "/api/skills";
export const PATH_SKILLS_CATALOG = "/api/skills/catalog";
export const PATH_SKILLS_BUNDLES = "/api/skills/bundles";
export const PATH_DASHBOARD = "/api/dashboard";
export const PATH_OPS = "/api/ops";
export const PATH_WORKFLOWS = "/api/workflows";
export const PATH_AGENT_FACTORY = "/api/agent-factory";
export const PATH_COLLABORATION = "/api/collaboration";
export const PATH_BLUEPRINTS = "/api/blueprints";
export const PATH_RUNTIMES = "/api/runtimes";
export const PATH_EXECUTION_PLANS = "/api/execution-plans";
export const PATH_LLM_PROXY = "/api/llm/proxy";

export const DASHBOARD_WIDGET_APPROVAL_QUEUE = "approval_queue";
export const DASHBOARD_WIDGET_EXECUTION_GRAPH = "execution_graph";
export const DASHBOARD_WIDGET_MEETING_BRIEF = "meeting_brief";
export const DASHBOARD_WIDGET_ORG_CHART = "org_chart";

export const DASHBOARD_SECTION_PRIORITY = "priority";
export const DASHBOARD_SECTION_PRIMARY = "primary";
export const DASHBOARD_SECTION_SECONDARY = "secondary";
export const DASHBOARD_SECTION_CONTEXT = "context";
export const DASHBOARD_SECTION_PINNED = "pinned";

export const SKILL_BUNDLE_KEYS = [
  "ceo",
  "pm",
  "developer",
  "reviewer",
  "devops",
  "marketer",
  "designer",
  "cfo",
] as const;

export const DEFAULT_AGENT_WORKSPACE_MODE = "adaptive_workspace";
export const DEFAULT_AGENT_APPROVAL_MODE = "always_owner";
export const DEFAULT_AGENT_APPROVER = "owner_ops";
export const DEFAULT_AGENT_INTERACTION_MOVEMENT = "walk_to_desk";
export const DEFAULT_AGENT_INTERACTION_SPEECH = "short_bubble";
export const DEFAULT_AGENT_INTERACTION_RETURN = "return_to_origin";

export const WORKSPACE_MODE_ORCHESTRATION = "orchestration_workspace";
export const WORKSPACE_MODE_BUILDER = "builder_workspace";
export const WORKSPACE_MODE_RESEARCH = "research_workspace";
export const WORKSPACE_MODE_CAMPAIGN = "campaign_workspace";
export const WORKSPACE_MODE_DESIGN = "design_workspace";
export const WORKSPACE_MODE_OPERATIONS = "operations_workspace";
export const WORKSPACE_MODE_FINANCE = "finance_workspace";

export const CONNECTOR_INTERNAL_WORKBENCH = "internal_workbench";
export const CONNECTOR_GIT = "git_connector";
export const CONNECTOR_DEPLOY = "deploy_connector";
export const CONNECTOR_SEARCH = "search_connector";
export const CONNECTOR_SOCIAL_PUBLISH = "social_publish_connector";
export const CONNECTOR_ADS = "ads_connector";
export const CONNECTOR_DESIGN_ASSETS = "design_assets_connector";
export const CONNECTOR_DOCS = "docs_connector";
export const CONNECTOR_RUNTIME_OPS = "runtime_ops_connector";
export const CONNECTOR_FINANCE = "finance_connector";

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DASHBOARD_SECTION_CONTEXT = exports.DASHBOARD_SECTION_SECONDARY = exports.DASHBOARD_SECTION_PRIMARY = exports.DASHBOARD_SECTION_PRIORITY = exports.DASHBOARD_WIDGET_ORG_CHART = exports.DASHBOARD_WIDGET_MEETING_BRIEF = exports.DASHBOARD_WIDGET_EXECUTION_GRAPH = exports.DASHBOARD_WIDGET_APPROVAL_QUEUE = exports.BILLING_TRACK_PROJECT = exports.BILLING_TRACK_BYOK = exports.PATH_WS_AGENTS = exports.PATH_EXECUTION_PLANS = exports.PATH_RUNTIMES = exports.PATH_BLUEPRINTS = exports.PATH_COLLABORATION = exports.PATH_AGENT_FACTORY = exports.PATH_WORKFLOWS = exports.PATH_OPS = exports.PATH_DASHBOARD = exports.PATH_SKILLS_BUNDLES = exports.PATH_SKILLS_CATALOG = exports.PATH_SKILLS = exports.PATH_TEAMS = exports.PATH_AGENTS = exports.PATH_PROJECTS_CLOCK_IN = exports.PATH_AUTH_WS_TICKET = exports.PATH_AUTH_BYOK = exports.PATH_AUTH_PROJECTS = exports.PATH_AUTH_LOGOUT = exports.PATH_AUTH_ME = exports.PATH_AUTH_REGISTER = exports.PATH_AUTH_LOGIN = exports.PATH_HEALTH = exports.AUTH_PATH_PREFIX = exports.DEFAULT_WS_BASE = exports.DEFAULT_API_BASE = exports.DEFAULT_API_PORT = exports.HEADER_NAME_CSRF = exports.COOKIE_NAME_CSRF = exports.STORAGE_KEY_OFFICE_STATE_PREFIX = exports.STORAGE_KEY_FACTORY_DRAFT = exports.STORAGE_KEY_DASHBOARD_LAYOUT_PREFIX = exports.STORAGE_KEY_ACCESS_TOKEN = exports.STORAGE_KEY_COLLAB_DOCK_POS = exports.STORAGE_KEY_OWNER_DOCK_POS = exports.STORAGE_KEY_CLI_PROVIDER = exports.STORAGE_KEY_CLI_WORKSPACE = exports.STORAGE_KEY_BILLING_TRACK = exports.STORAGE_KEY_ACTIVE_PROJECT = exports.STORAGE_KEY_LOCALE = void 0;
exports.SKILL_BUNDLE_KEYS = exports.DASHBOARD_SECTION_PINNED = void 0;
exports.STORAGE_KEY_LOCALE = "daacs_locale";
exports.STORAGE_KEY_ACTIVE_PROJECT = "daacs_active_project_id";
exports.STORAGE_KEY_BILLING_TRACK = "daacs_billing_track";
exports.STORAGE_KEY_CLI_WORKSPACE = "daacs_cli_workspace_path";
exports.STORAGE_KEY_CLI_PROVIDER = "daacs_cli_provider";
exports.STORAGE_KEY_OWNER_DOCK_POS = "daacs_owner_dock_pos";
exports.STORAGE_KEY_COLLAB_DOCK_POS = "daacs_collab_dock_pos";
exports.STORAGE_KEY_ACCESS_TOKEN = "daacs_access_token";
exports.STORAGE_KEY_DASHBOARD_LAYOUT_PREFIX = "daacs_dashboard_layout";
exports.STORAGE_KEY_FACTORY_DRAFT = "daacs_factory_draft";
exports.STORAGE_KEY_OFFICE_STATE_PREFIX = "daacs_office_state";
exports.COOKIE_NAME_CSRF = "daacs_csrf_token";
exports.HEADER_NAME_CSRF = "X-CSRF-Token";
exports.DEFAULT_API_PORT = 8001;
exports.DEFAULT_API_BASE = "http://localhost:8001";
exports.DEFAULT_WS_BASE = "ws://localhost:8001";
exports.AUTH_PATH_PREFIX = "/api/auth/";
exports.PATH_HEALTH = "/health";
exports.PATH_AUTH_LOGIN = "/api/auth/login";
exports.PATH_AUTH_REGISTER = "/api/auth/register";
exports.PATH_AUTH_ME = "/api/auth/me";
exports.PATH_AUTH_LOGOUT = "/api/auth/logout";
exports.PATH_AUTH_PROJECTS = "/api/auth/projects";
exports.PATH_AUTH_BYOK = "/api/auth/byok";
exports.PATH_AUTH_WS_TICKET = "/api/auth/ws-ticket";
exports.PATH_PROJECTS_CLOCK_IN = "/api/projects";
exports.PATH_AGENTS = "/api/agents";
exports.PATH_TEAMS = "/api/teams";
exports.PATH_SKILLS = "/api/skills";
exports.PATH_SKILLS_CATALOG = "/api/skills/catalog";
exports.PATH_SKILLS_BUNDLES = "/api/skills/bundles";
exports.PATH_DASHBOARD = "/api/dashboard";
exports.PATH_OPS = "/api/ops";
exports.PATH_WORKFLOWS = "/api/workflows";
exports.PATH_AGENT_FACTORY = "/api/agent-factory";
exports.PATH_COLLABORATION = "/api/collaboration";
exports.PATH_BLUEPRINTS = "/api/blueprints";
exports.PATH_RUNTIMES = "/api/runtimes";
exports.PATH_EXECUTION_PLANS = "/api/execution-plans";
exports.PATH_WS_AGENTS = "/ws/agents";
exports.BILLING_TRACK_BYOK = "byok";
exports.BILLING_TRACK_PROJECT = "project";
exports.DASHBOARD_WIDGET_APPROVAL_QUEUE = "approval_queue";
exports.DASHBOARD_WIDGET_EXECUTION_GRAPH = "execution_graph";
exports.DASHBOARD_WIDGET_MEETING_BRIEF = "meeting_brief";
exports.DASHBOARD_WIDGET_ORG_CHART = "org_chart";
exports.DASHBOARD_SECTION_PRIORITY = "priority";
exports.DASHBOARD_SECTION_PRIMARY = "primary";
exports.DASHBOARD_SECTION_SECONDARY = "secondary";
exports.DASHBOARD_SECTION_CONTEXT = "context";
exports.DASHBOARD_SECTION_PINNED = "pinned";
exports.SKILL_BUNDLE_KEYS = [
    "ceo",
    "pm",
    "developer",
    "reviewer",
    "devops",
    "marketer",
    "designer",
    "cfo",
];

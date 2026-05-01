import {
  extractFirstJsonObject,
  normalizeBlueprintSuggestion,
} from "./agentDesignAssistant";
import type { SkillMeta } from "../types/runtime";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

const skills: SkillMeta[] = [
  {
    id: "typescript-pro",
    description: "Advanced TypeScript patterns and type safety.",
  },
  {
    id: "clean-code",
    description: "Readable, maintainable implementation discipline.",
  },
  {
    id: "code-reviewer",
    description: "Review changes for correctness and risk.",
  },
  {
    id: "security-auditor",
    description: "Analyze security posture and implementation gaps.",
  },
];

const extracted = extractFirstJsonObject(`
The best answer is below.

\`\`\`json
{
  "prompt": "You are a security reviewer. Focus on code and dependency risks.",
  "skills": ["code-reviewer", "security-auditor"],
  "name": "Security Reviewer",
  "role_label": "security reviewer",
  "capabilities": ["review", "security"],
  "accent_color": "#14B8A6",
  "home_zone": "strategy_hub",
  "team_affinity": "strategy_team",
  "tool_connectors": ["search_connector", "docs_connector"],
  "explanation": "Use the reviewer bundle."
}
\`\`\`
`);

assert(extracted !== null, "extractFirstJsonObject should recover a JSON block from markdown output");

const intent = "Need a security-focused reviewer for our API layer.";
const parsed = normalizeBlueprintSuggestion(JSON.parse(extracted!), skills, intent);
assert(parsed !== null, "normalizeBlueprintSuggestion should accept a valid JSON payload");
assert(parsed?.role_label === "security_reviewer", "role labels should normalize to snake_case");
assert(parsed?.skill_bundle_refs[0] === "code-reviewer", "selected skills should normalize to canonical skill IDs");
assert(parsed?.agent_prompt?.includes("security reviewer"), "prompt should map to agent_prompt");
assert(parsed?.accent_color === "#14B8A6", "normalizeBlueprintSuggestion should preserve accent color hints");
assert(parsed?.tool_connectors?.includes("search_connector"), "normalizeBlueprintSuggestion should preserve connector hints");

const minimal = normalizeBlueprintSuggestion(
  {
    prompt: "Build TypeScript features with clean code discipline.",
    skills: ["typescript-pro", "clean-code"],
  },
  skills,
  "Builder Agent focus for our sprint.",
);

assert(minimal !== null, "normalizeBlueprintSuggestion should accept prompt+skills only");
assert(minimal?.skill_bundle_refs[0] === "typescript-pro", "selected skills should be preserved");
assert(minimal?.name === "Builder Agent focus for our sprint.", "name should derive from intent when omitted");

console.log("agentDesignAssistant tests passed");

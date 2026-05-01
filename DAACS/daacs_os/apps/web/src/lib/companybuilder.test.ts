import { normalizeCompanyBuildPlan } from "./companyBuilder";
import type { SkillMeta } from "../types/runtime";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

const skills: SkillMeta[] = [
  { id: "ai-agents-architect", description: "Design AI agent systems." },
  { id: "product-manager-toolkit", description: "Product planning and coordination." },
  { id: "typescript-pro", description: "Advanced TypeScript." },
  { id: "security-auditor", description: "Security review." },
];

const plan = normalizeCompanyBuildPlan(
  {
    company_name: "Fintech Ops",
    rationale: "Balanced delivery team",
    agents: [
      {
        name: "Chief Builder",
        role_label: "chief_builder",
        selected_skills: ["ai-agents-architect", "typescript-pro"],
        responsibilities: "Lead implementation",
      },
      {
        name: "Risk Reviewer",
        role_label: "risk_reviewer",
        selected_skills: ["security-auditor"],
        responsibilities: "Review risk and controls",
      },
    ],
  },
  skills,
);

assert(plan !== null, "normalizeCompanyBuildPlan should accept valid plans");
assert(plan?.agents.length === 2, "normalized plan should keep valid agents");
assert(
  plan?.agents[0].selected_skills[0] === "ai-agents-architect",
  "selected skills should normalize to catalog IDs",
);

console.log("companyBuilder tests passed");

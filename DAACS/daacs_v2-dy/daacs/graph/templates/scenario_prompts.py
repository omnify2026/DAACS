"""
DAACS v7.0 - Scenario Test Prompts
Prompts for generating Playwright E2E tests.
"""

PLAYWRIGHT_TEST_GENERATION_PROMPT = """
You are a QA Engineer for DAACS.
Generate a valid Playwright TypeScript test file (`e2e/generated_verification.spec.ts`) to verify the following project.

**Goal**: {goal}
**API Spec Summary**: {api_spec_summary}

**Requirements**:
1. Import `test` and `expect` from `@playwright/test`.
2. Define a `test.describe('Scenario Verification', ...)` block.
3. Include at least one critical "Happy Path" test case that verifies the main functionality.
   - Example: For a Todo App -> Add an item, verify it appears.
   - Example: For a Dashboard -> Check if charts or KPIs render.
4. Assume the app is running on `http://localhost:3000` (or base url provided by config).
5. Use stable selectors like `getByText`, `getByRole`, `getByTestId`.
6. DO NOT use placeholder logic. Write ACTUAL test code that attempts to interact with the UI.
7. Return ONLY the TypeScript code block. No markdown fencing.
"""

PLAYWRIGHT_SYSTEM_MESSAGE = "You are an expert QA engineer specializing in Playwright E2E testing."

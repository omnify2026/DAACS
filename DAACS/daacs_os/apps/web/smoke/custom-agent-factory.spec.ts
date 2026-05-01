import { expect, test } from "@playwright/test";

import { enterOfficeFromProjectSelection } from "./helpers";

test.describe("Custom agent factory smoke", () => {
  test("creates an implementation agent from the real office flow", async ({ page }) => {
    await enterOfficeFromProjectSelection(page);

    await page.getByTestId("hud-open-agent-workspace-button").click();
    await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible();

    await page.getByRole("button", { name: "Create agent" }).click();
    await expect(page.getByRole("heading", { name: "Create Custom Agent" })).toBeVisible();

    await page
      .getByPlaceholder("Describe the agent you want in natural language")
      .fill("Frontend product builder that can implement, repair, and verify web artifacts.");
    await page.getByRole("button", { name: "Configure manually" }).click();

    await expect(page.getByText("2. Edit")).toBeVisible();
    await page.getByLabel("Agent name").fill("Frontend Product Builder");
    await page.getByLabel("Agent ID").fill("frontend_product_builder");
    await page
      .getByLabel("Description")
      .fill("frontend, backend, code_generation, repair, delivery");
    await page
      .locator("textarea")
      .last()
      .fill("Build and repair user-facing web artifacts with executable evidence.");

    await expect(page.getByText("developer").first()).toBeVisible();
    await page.getByRole("button", { name: "Preview" }).click();

    await expect(page.getByText("3. Preview")).toBeVisible();
    await expect(page.locator('input[value="Frontend Product Builder"]')).toBeVisible();
    await expect(page.locator('input[value="frontend_product_builder"]')).toBeVisible();

    await page.getByRole("button", { name: "Create", exact: true }).click();

    await expect(page.getByTestId("notification-toast")).toContainText(
      "Created agent: Frontend Product Builder",
    );
    await expect(page.getByText("frontend_product_builder")).toBeVisible();

    await page.getByTestId("hud-open-agent-workspace-button").click();
    await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible();
    const targetSelect = page.locator("#agent-ws-command-target");
    await expect(
      targetSelect.locator("option").filter({ hasText: "Frontend Product Builder" }),
    ).toHaveCount(1);
    await targetSelect.selectOption({ label: "Frontend Product Builder" });
    await expect(targetSelect).toHaveValue(/instance-|frontend_product_builder/);
  });
});

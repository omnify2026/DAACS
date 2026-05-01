import { expect, test } from "@playwright/test";

import {
  clickElementCenter,
  enterOfficeFromProjectSelection,
  expectActiveElementInModal,
  expectCoveredByModal,
  launchAtProjectSelection,
  openByokFromHud,
} from "./helpers";

test.describe("BYOK settings smoke", () => {
  test("reaches account BYOK settings from project selection and lobby", async ({ page }) => {
    await launchAtProjectSelection(page);

    await expect(page.getByText("You can preload account-level BYOK keys before choosing a project.")).toBeVisible();
    await page.getByTestId("project-select-manage-keys").click();

    const modal = page.getByTestId("llm-settings-modal");
    await expect(modal).toBeVisible();
    await expect(modal.getByText("Users can store their own API keys on the account and use BYOK when needed.")).toBeVisible();
    await expect(modal.getByText("Billing track")).toBeVisible();
    await expect(modal.getByText("project", { exact: true })).toBeVisible();

    await page.getByTestId("llm-settings-openai-input").fill("sk-openai-smoke");
    await page.getByTestId("llm-settings-save").click();
    await expect(modal.getByText("BYOK keys were stored for this account. Runtime activation is not wired yet.")).toBeVisible();
    await expect(modal.getByText("byok", { exact: true })).toBeVisible();
    await expect(modal.getByText("Configured")).toHaveCount(1);
    await page.getByTestId("llm-settings-close").click();

    await page.getByRole("button", { name: "Project Alpha" }).click();
    await expect(page.getByText("You can save account-level BYOK keys before entering the office.")).toBeVisible();
    await page.getByTestId("lobby-manage-keys").click();

    await expect(modal).toBeVisible();
    await expect(modal.getByText("byok", { exact: true })).toBeVisible();
    await expect(modal.getByText("Configured")).toHaveCount(1);
  });

  test("keeps BYOK modal isolated above office HUD controls on the real office path", async ({ page }) => {
    await enterOfficeFromProjectSelection(page);
    await expect(page.getByTestId("planner-toggle")).toBeVisible();
    await page.getByTestId("owner-ops-toggle").click();
    await expect(page.getByTestId("owner-ops-panel")).toBeVisible();

    await page.getByTestId("messenger-toggle").click();
    await expect(page.getByTestId("messenger-panel")).toBeVisible();

    await page.getByTestId("planner-toggle").click();
    await expect(page.getByTestId("planner-panel")).toBeVisible();

    await page.getByTestId("hud-main-menu-button").click();
    await page.getByTestId("hud-office-customization-menu-item").click();
    await expect(page.getByTestId("office-customization-panel")).toBeVisible();

    const ownerPanel = page.getByTestId("owner-ops-panel");
    const messengerPanel = page.getByTestId("messenger-panel");
    const plannerPanel = page.getByTestId("planner-panel");
    const plannerGoalInput = page.getByTestId("planner-goal-input");
    const closeButton = page.getByTestId("llm-settings-close");
    const claudeInput = page.getByTestId("llm-settings-claude-input");
    const openAiInput = page.getByTestId("llm-settings-openai-input");
    const saveButton = page.getByTestId("llm-settings-save");
    const modal = page.getByTestId("llm-settings-modal");

    await openByokFromHud(page);

    await expect(modal).toBeVisible();
    await expect(page.getByTestId("office-customization-panel")).toBeHidden();
    await expect(ownerPanel).toBeVisible();
    await expect(messengerPanel).toBeVisible();
    await expect(plannerPanel).toBeVisible();

    await expectCoveredByModal(page, ownerPanel);
    await expectCoveredByModal(page, messengerPanel);
    await expectCoveredByModal(page, plannerPanel);
    await expectCoveredByModal(page, plannerGoalInput);

    await expect(closeButton).toBeFocused();
    await clickElementCenter(page, plannerGoalInput);
    await expect(plannerGoalInput).not.toBeFocused();
    await expectActiveElementInModal(page);
    await expect(modal).toBeVisible();

    await page.keyboard.press("Shift+Tab");
    await expect(saveButton).toBeFocused();
    await expectActiveElementInModal(page);

    await page.keyboard.press("Tab");
    await expect(closeButton).toBeFocused();
    await expectActiveElementInModal(page);

    await page.keyboard.press("Tab");
    await expect(claudeInput).toBeFocused();
    await expectActiveElementInModal(page);

    await page.keyboard.press("Tab");
    await expect(openAiInput).toBeFocused();
    await expectActiveElementInModal(page);

    await page.keyboard.press("Escape");
    await expect(modal).toBeHidden();

    await page.getByTestId("planner-toggle").click();
    await expect(plannerPanel).toBeHidden();

    await page.getByTestId("messenger-close-button").click();
    await expect(messengerPanel).toBeHidden();

    await page.getByTestId("owner-ops-close-button").click();
    await expect(ownerPanel).toBeHidden();
  });
});

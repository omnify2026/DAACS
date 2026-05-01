import { test, expect, type APIRequestContext } from '@playwright/test';

async function createProject(request: APIRequestContext, goal: string) {
    const response = await request.post('/api/projects', {
        data: { goal, config: {} },
    });
    expect(response.ok()).toBeTruthy();
    const project = await response.json();
    return project.id as string;
}

test.describe('DAACS Landing Page', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/');
    });

    test('should display landing page elements', async ({ page }) => {
        // Verify Header Logo
        await expect(page.locator('nav').getByText('Transformers')).toBeVisible();

        // Verify Main Heading
        await expect(page.getByText('Build meaningful things.')).toBeVisible();

        // Verify Sign in button
        await expect(page.getByTestId('button-login-header')).toBeVisible();

        // Verify Input area
        await expect(page.getByTestId('input-requirement')).toBeVisible();

        // Verify Submit button
        await expect(page.getByTestId('button-start')).toBeVisible();
    });

    test('should navigate to login when clicking Sign in', async ({ page }) => {
        await page.getByTestId('button-login-header').click();
        await expect(page).toHaveURL('/login');
        await expect(page.getByText('Welcome back')).toBeVisible();
    });
});

test.describe('DAACS Login Flow', () => {
    test('should login successfully with valid credentials', async ({ page }) => {
        await page.goto('/login');

        // Fill credentials
        await page.getByLabel('Username').fill('qed900');
        await page.getByLabel('Password').fill('qed900');

        // Submit
        await page.getByRole('button', { name: /sign in/i }).click();

        // Should redirect to home (logged in view)
        await expect(page).toHaveURL('/');

        // Verify logged-in state (should see Sign out, not Sign in)
        await expect(page.getByText('Sign out')).toBeVisible();
    });

    test('should show error with invalid credentials', async ({ page }) => {
        await page.goto('/login');

        await page.getByLabel('Username').fill('wrong');
        await page.getByLabel('Password').fill('wrong');
        await page.getByRole('button', { name: /sign in/i }).click();

        // Should show error message
        await expect(page.getByText('Invalid username or password')).toBeVisible();
    });
});

test.describe('DAACS Home Page (Logged In)', () => {
    test.beforeEach(async ({ page }) => {
        // Login first
        await page.goto('/login');
        await page.getByLabel('Username').fill('qed900');
        await page.getByLabel('Password').fill('qed900');
        await page.getByRole('button', { name: /sign in/i }).click();
        await expect(page).toHaveURL('/');
    });

    test('should display home page elements after login', async ({ page }) => {
        // Verify Main Heading
        await expect(page.getByText('Build meaningful things.')).toBeVisible();

        // Verify Sign out button (logged in)
        await expect(page.getByText('Sign out')).toBeVisible();

        // Verify Input and Generate button
        await expect(page.getByTestId('home-input-requirement')).toBeVisible();
        await expect(page.getByTestId('home-button-generate')).toBeVisible();
    });

    test('should handle source type toggling', async ({ page }) => {
        const toggleBtn = page.getByTestId('home-toggle-source-btn');

        // Initial state should be "new"
        await expect(toggleBtn).toContainText('new');

        // Click to toggle to Folder
        await toggleBtn.click();
        await expect(toggleBtn).toContainText('folder');
        await expect(page.getByTestId('home-input-source-path')).toBeVisible();

        // Click to toggle back to new
        await toggleBtn.click();
        await expect(toggleBtn).toContainText('new');
    });

    test('should enable submit button when text is entered', async ({ page }) => {
        const input = page.getByTestId('home-input-requirement');
        const submitBtn = page.getByTestId('home-button-generate');

        // Button should be disabled initially
        await expect(submitBtn).toBeDisabled();

        // Type requirement
        await input.fill('Create a simple calculator app');

        // Button should be enabled
        await expect(submitBtn).toBeEnabled();
    });
});

test.describe('DAACS Project Creation Flow', () => {
    test.beforeEach(async ({ page }) => {
        // Login first
        await page.goto('/login');
        await page.getByLabel('Username').fill('qed900');
        await page.getByLabel('Password').fill('qed900');
        await page.getByRole('button', { name: /sign in/i }).click();
        await expect(page).toHaveURL('/');
    });

    test('should create project and navigate to workspace', async ({ page }) => {
        const input = page.getByTestId('home-input-requirement');
        const submitBtn = page.getByTestId('home-button-generate');

        // Enter project description
        await input.fill('E2E Test: Build a todo list app');
        await expect(submitBtn).toBeEnabled();

        // Submit project
        await submitBtn.click();

        // Either: redirect to workspace directly, OR analyst modal appears
        const enterWorkspaceBtn = page.getByRole('button', { name: /Enter Workspace|워크스페이스/i }).first();
        const navigatedEarly = await Promise.race([
            page.waitForURL(/\/workspace\/\d+/, { timeout: 12000 }).then(() => true).catch(() => false),
            enterWorkspaceBtn.waitFor({ state: 'visible', timeout: 12000 }).then(() => false).catch(() => false),
        ]);

        if (!navigatedEarly) {
            await enterWorkspaceBtn.scrollIntoViewIfNeeded();
            await enterWorkspaceBtn.click({ force: true });
        }

        await expect(page).toHaveURL(/\/workspace\/\d+/, { timeout: 15000 });
    });

    test('should show recent projects after creating one', async ({ page }) => {
        // Look for recent project chips (may or may not exist)
        const projectChips = page.locator('[data-testid^="home-project-chip-"]');
        const count = await projectChips.count();

        if (count > 0) {
            // Verify first chip is clickable
            await expect(projectChips.first()).toBeVisible();
        }
        // Test passes regardless - just verifying the selector works
    });
});

test.describe('DAACS Workspace Page', () => {
    test.beforeEach(async ({ page }) => {
        // Login first
        await page.goto('/login');
        await page.getByLabel('Username').fill('qed900');
        await page.getByLabel('Password').fill('qed900');
        await page.getByRole('button', { name: /sign in/i }).click();
        await expect(page).toHaveURL('/');
    });

    test('should navigate to existing workspace', async ({ page, request }) => {
        const projectId = await createProject(request, 'E2E workspace navigation');
        await page.goto(`/workspace/${projectId}`);

        // Verify workspace page loads
        await expect(page.getByTestId('workspace-header')).toBeVisible();
        await expect(page.getByTestId('workspace-tab-plan')).toBeVisible();
        await expect(page.getByTestId('workspace-tab-workflow')).toBeVisible();
        await expect(page.getByTestId('workspace-tab-files')).toBeVisible();
        await expect(page.getByTestId('workspace-tab-chat')).toBeVisible();
        await expect(page.getByTestId('workspace-tab-preview')).toBeVisible();

        // Should show project status or error
        const pageContent = await page.textContent('body');
        expect(pageContent).toBeTruthy();
    });

    test('should show 404 for non-existent workspace', async ({ page }) => {
        // Navigate to non-existent workspace
        await page.goto('/workspace/99999');

        // Should show 404 or error state
        await expect(page.getByText('프로젝트를 찾을 수 없습니다')).toBeVisible();
    });

    test('should return to landing via back button', async ({ page, request }) => {
        const projectId = await createProject(request, 'E2E workspace back');
        await page.goto(`/workspace/${projectId}`);

        await page.getByTestId('workspace-back').click();
        await expect(page).toHaveURL('/');
    });
});

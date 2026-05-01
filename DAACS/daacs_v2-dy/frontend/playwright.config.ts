import { defineConfig, devices } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * DAACS Playwright E2E Test Configuration
 * @see https://playwright.dev/docs/test-configuration
 */
const configDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(configDir, '..');

function numberEnv(value: string | undefined, fallback: number) {
    if (!value) return fallback;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

const daacsPort = process.env.DAACS_PORT || '8001';
const baseURL =
    process.env.DAACS_E2E_BASE_URL ||
    process.env.PLAYWRIGHT_TEST_BASE_URL ||
    'http://localhost:5173';
const backendUrl =
    process.env.DAACS_E2E_BACKEND_URL ||
    `http://localhost:${daacsPort}/api/models`;
const shouldStartBackend = process.env.DAACS_E2E_SKIP_BACKEND !== '1';
const backendCommand = process.env.DAACS_E2E_BACKEND_CMD || 'python -m daacs.server';
const frontendCommand = process.env.DAACS_E2E_FRONTEND_CMD || 'npm run dev';
const commonEnv = { ...process.env, DAACS_PORT: daacsPort };
const serverTimeoutMs = numberEnv(process.env.DAACS_E2E_SERVER_TIMEOUT_MS, 120_000);

export default defineConfig({
    testDir: './e2e',
    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 2 : 0,
    workers: process.env.CI ? 1 : undefined,
    reporter: 'html',
    use: {
        baseURL,
        trace: 'on-first-retry',
        screenshot: 'only-on-failure',
        video: 'retain-on-failure',
    },

    projects: [
        {
            name: 'chromium',
            use: { ...devices['Desktop Chrome'] },
        },
        {
            name: 'firefox',
            use: { ...devices['Desktop Firefox'] },
        },
        {
            name: 'webkit',
            use: { ...devices['Desktop Safari'] },
        },
        // Mobile viewports
        {
            name: 'Mobile Chrome',
            use: { ...devices['Pixel 5'] },
        },
        {
            name: 'Mobile Safari',
            use: { ...devices['iPhone 12'] },
        },
    ],

    // Run local dev server before starting tests
    webServer: [
        ...(shouldStartBackend
            ? [
                  {
                      command: backendCommand,
                      url: backendUrl,
                      reuseExistingServer: !process.env.CI,
                      timeout: serverTimeoutMs,
                      cwd: repoRoot,
                      env: commonEnv,
                  },
              ]
            : []),
        {
            command: frontendCommand,
            url: baseURL,
            reuseExistingServer: !process.env.CI,
            timeout: serverTimeoutMs,
            env: commonEnv,
        },
    ],
});

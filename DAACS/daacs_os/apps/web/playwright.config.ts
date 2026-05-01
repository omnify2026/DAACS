import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./smoke",
  fullyParallel: false,
  retries: 0,
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  use: {
    baseURL: "http://127.0.0.1:3001",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    viewport: { width: 1600, height: 1000 },
  },
  projects: [
    // Browser scope is intentionally Chromium-only for the current BYOK/settings smoke lane.
    // Expand this matrix only after Firefox/WebKit-specific assertions are added and verified.
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1600, height: 1000 },
      },
    },
  ],
  webServer: {
    command: "npm run dev -- --host 127.0.0.1 --port 3001 --strictPort",
    url: "http://127.0.0.1:3001",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});

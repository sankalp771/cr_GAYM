import { defineConfig, devices } from "@playwright/test";

const PORT = 3100;
const baseURL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL,
    trace: "on-first-retry"
  },
  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"] } },
    // The product brief expects most sessions to be on phones, so the mobile
    // viewport is a first-class target rather than an afterthought.
    { name: "mobile-chromium", use: { ...devices["Pixel 7"] } },
    // 360px is the narrowest width the definition of done commits to, and it is
    // narrower than any stock Playwright device profile.
    {
      name: "small-phone",
      use: {
        ...devices["Pixel 7"],
        viewport: { width: 360, height: 740 }
      }
    }
  ],
  webServer: {
    command: `npx next start --port ${PORT}`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000
  }
});

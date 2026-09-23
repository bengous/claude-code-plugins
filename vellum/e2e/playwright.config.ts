import { defineConfig } from "@playwright/test";

/** The audit's windows: 1440x900 in both themes, then the widths where the page reflows. */
const WINDOWS = [
  { name: "light-1440", width: 1440, height: 900, colorScheme: "light" },
  { name: "dark-1440", width: 1440, height: 900, colorScheme: "dark" },
  { name: "light-1024", width: 1024, height: 768, colorScheme: "light" },
  { name: "light-1280", width: 1280, height: 800, colorScheme: "light" },
  { name: "light-1920", width: 1920, height: 1080, colorScheme: "light" },
] as const;

export default defineConfig({
  testDir: import.meta.dirname,
  testMatch: "**/*.e2e.ts",
  fullyParallel: true,
  forbidOnly: process.env.CI !== undefined,
  reporter: "list",
  // Scrollbars drawn, as Chrome on Linux draws them: the one thing a fold handle can cover.
  use: {
    browserName: "chromium",
    // CI uploads no trace and recording one costs about a fifth of each test (#195): a CI
    // failure is reproduced locally, where the failing test's trace is kept.
    trace: process.env.CI === undefined ? "retain-on-failure" : "off",
    launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] },
  },
  projects: WINDOWS.map(({ name, width, height, colorScheme }) => ({
    name,
    use: { viewport: { width, height }, colorScheme },
  })),
});

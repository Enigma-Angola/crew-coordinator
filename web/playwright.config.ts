import { defineConfig } from '@playwright/test';

// Runs against a locally started stack (dev IdP :4000, API :3000, web :5173) with demo data.
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5173',
    launchOptions: { executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' },
    viewport: { width: 1440, height: 900 },
  },
});

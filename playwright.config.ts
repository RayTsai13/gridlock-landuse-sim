import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  outputDir: 'test-results/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  use: {
    baseURL: 'http://127.0.0.1:5178',
    viewport: { width: 1280, height: 800 },
    trace: 'retain-on-failure',
    launchOptions: { args: ['--enable-unsafe-swiftshader'] },
  },
  webServer: [
    { command: `${process.env.PYTHON ?? '.venv/bin/python'} -m uvicorn backend.server:app --host 127.0.0.1 --port 8000`, url: 'http://127.0.0.1:8000/healthz', reuseExistingServer: false },
    { command: 'npm run dev -- --host 127.0.0.1 --port 5178 --strictPort', url: 'http://127.0.0.1:5178', reuseExistingServer: false },
  ],
});

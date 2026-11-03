import { defineConfig, devices } from '@playwright/test';

/**
 * Browser tests for the renderer.
 *
 * What this is for: the jsdom suite proves behaviour (clicks, focus, ARIA), and
 * cannot prove layout, contrast or the real accessibility tree — it has no layout
 * engine. This project runs the **built** renderer in Chromium, so the page under
 * test is the bundle that ships, at the window sizes the app actually uses.
 *
 * What it is not: an end-to-end test of Electron. The main process cannot start in
 * this environment (a pristine Electron probe fails the same way), and the bridge
 * is stubbed instead. `media://` therefore does not resolve here; the media tests
 * assert the DOM contract and never require the image to decode.
 */
const PORT = Number(process.env.RENDERER_PORT ?? 4373);

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'off',
    screenshot: 'only-on-failure',
    ...devices['Desktop Chrome'],
    // The app's default window is 1280x860 and its documented minimum is 940x600.
    viewport: { width: 1280, height: 860 },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node scripts/serve-renderer.mjs',
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});

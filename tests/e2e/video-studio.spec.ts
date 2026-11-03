/**
 * The Video Studio in a real browser.
 *
 * Same three questions as the Image Studio — layout at the app's window sizes, the
 * accessibility tree, and the controls the provider documents — plus one that only
 * matters for video: the player must not autoplay and must be fed by the app's own
 * `media://` URL.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { installBridgeStub } from './bridge-stub';

test.beforeEach(async ({ page }) => {
  await installBridgeStub(page, { video: true, imageItems: 1 });
  await page.goto('/#/video');
});

test('lays out at the minimum window size without a horizontal scrollbar', async ({ page }) => {
  await page.setViewportSize({ width: 940, height: 600 });
  await expect(page.getByRole('heading', { level: 1, name: 'Video Studio' })).toBeVisible();

  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
});

test('lays out at the default window size', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await expect(page.getByRole('heading', { level: 1, name: 'Video Studio' })).toBeVisible();
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
});

test('offers the video controls Gemini documents, and no duration', async ({ page }) => {
  await expect(page.getByRole('combobox', { name: 'Model' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Prompt' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Aspect ratio' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Resolution' })).toBeVisible();
  // Neither provider documents a duration for these models.
  await expect(page.getByRole('combobox', { name: /duration/i })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Generate video' })).toBeVisible();
});

test('the player is not autoplaying and uses the app media scheme', async ({ page }) => {
  await page.getByRole('button', { name: /Open video preview/i }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();

  const player = dialog.locator('video');
  await expect(player).toHaveCount(1);
  // A generated video is a file the app serves, not a remote URL.
  await expect(player).toHaveAttribute('src', /^media:\/\/local\//);
  // Never autoplay: motion on open ignores the reduced-motion preference.
  expect(await player.evaluate((element) => element.hasAttribute('autoplay'))).toBe(false);
  expect(await player.evaluate((element) => element.hasAttribute('controls'))).toBe(true);
});

test('has no serious or critical accessibility violations', async ({ page }) => {
  await expect(page.getByRole('heading', { level: 1, name: 'Video Studio' })).toBeVisible();
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();

  const blocking = results.violations.filter(
    (violation) => violation.impact === 'serious' || violation.impact === 'critical',
  );
  expect(
    blocking.map((violation) => `${violation.id}: ${violation.help} (${violation.nodes.length} nodes)`),
  ).toEqual([]);
});

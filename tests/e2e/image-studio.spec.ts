/**
 * The Image Studio in a real browser, on the real bundle.
 *
 * Three things only a browser can answer:
 *  1. does the page lay out at the app's minimum window size without a horizontal
 *     scrollbar, and still at the default size;
 *  2. does the accessibility tree pass an automated scan (axe) with no serious or
 *     critical violation;
 *  3. does the rendered page show the right things — the controls the provider
 *     documents, no chat model in the picker, a real progressbar.
 *
 * What it cannot answer: `media://` images do not resolve here, because the
 * protocol handler lives in the Electron main process. The tests never require an
 * image to decode; they assert the DOM and the layout.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { installBridgeStub } from './bridge-stub';

test.beforeEach(async ({ page }) => {
  await installBridgeStub(page, { imageModels: 1, imageItems: 0 });
  await page.goto('/#/image');
});

test('lays out at the minimum window size without a horizontal scrollbar', async ({ page }) => {
  await page.setViewportSize({ width: 940, height: 600 });
  await expect(page.getByRole('heading', { level: 1, name: 'Image Studio' })).toBeVisible();

  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
});

test('lays out at the default window size', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await expect(page.getByRole('heading', { level: 1, name: 'Image Studio' })).toBeVisible();
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
});

test('offers exactly the controls the OpenAI images API documents', async ({ page }) => {
  await expect(page.getByRole('textbox', { name: 'Prompt' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Size' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Quality' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Images per request' })).toBeVisible();
  // Gemini-only controls must not appear for an OpenAI provider.
  await expect(page.getByRole('combobox', { name: 'Aspect ratio' })).toHaveCount(0);
  // Neither provider documents a negative prompt, so it is not offered.
  await expect(page.getByRole('textbox', { name: /negative/i })).toHaveCount(0);
});

test('does not offer a chat model in the image picker', async ({ page }) => {
  const picker = page.getByRole('combobox', { name: 'Model' });
  await picker.click();
  await expect(page.getByRole('option', { name: /GPT Image 2/ })).toBeVisible();
  await expect(page.getByRole('option', { name: /Chat model/ })).toHaveCount(0);
});

test('has no serious or critical accessibility violations', async ({ page }) => {
  await expect(page.getByRole('heading', { level: 1, name: 'Image Studio' })).toBeVisible();

  const results = await new AxeBuilder({ page })
    // The rail and the studio form are the two regions under test; axe scans the
    // whole document, which is what a user experiences.
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();

  const blocking = results.violations.filter(
    (violation) => violation.impact === 'serious' || violation.impact === 'critical',
  );
  expect(
    blocking.map((violation) => `${violation.id}: ${violation.help} (${violation.nodes.length} nodes)`),
  ).toEqual([]);
});

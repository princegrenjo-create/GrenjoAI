/**
 * The development policy must not be stricter than the packaged one.
 *
 * Two CSPs exist and both apply while developing: the `<meta>` tag Vite injects
 * (`vite.renderer.config.ts`) and the response header Electron sets
 * (`src/main/security.ts`). Browsers intersect every policy on a document, so a
 * directive missing from *either* one is denied — which is how the voice-memo
 * preview came to be blocked under `npm run dev` while working in the packaged
 * build: the header's dev policy had no `media-src`, so it fell back to
 * `default-src 'none'`.
 *
 * This is a source-level check of both policy literals. It cannot run a browser,
 * so it proves the directive is present and identical in both places — not that
 * a blob actually plays. A rendered check belongs to the Playwright pass.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();

/** Extract the array literal assigned to `name`, joined up to `.join(`. */
function cspBlock(file: string, name: string): string {
  const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const start = source.indexOf(`const ${name}`);
  expect(start, `${name} not found in ${file}`).toBeGreaterThan(-1);
  const end = source.indexOf('.join(', start);
  expect(end, `${name} has no .join() terminator in ${file}`).toBeGreaterThan(start);
  return source.slice(start, end);
}

const DIRECTIVES = ["media-src 'self' blob: media:"];

describe('development CSP parity', () => {
  it('main-process dev policy allows blob media', () => {
    const block = cspBlock('src/main/security.ts', 'devCsp');
    for (const directive of DIRECTIVES) expect(block).toContain(directive);
  });

  it('Vite dev policy allows blob media', () => {
    const block = cspBlock('vite.renderer.config.ts', 'DEV_CSP');
    for (const directive of DIRECTIVES) expect(block).toContain(directive);
  });

  it('the production policies still deny the network', () => {
    // The renderer performs no I/O. Loosening this would be a security change,
    // not a convenience one, so it is asserted rather than trusted.
    expect(cspBlock('src/main/security.ts', 'PROD_CSP')).toContain("connect-src 'none'");
    expect(cspBlock('vite.renderer.config.ts', 'PROD_CSP')).toContain("connect-src 'none'");
  });

  it('allows the media scheme for images and video in every policy', () => {
    // Generated media is served by the app's own protocol handler. Without the
    // scheme in img-src/media-src a generated image is a broken image and a
    // generated video cannot play at all, which is why this is asserted.
    for (const [file, name] of [
      ['src/main/security.ts', 'PROD_CSP'],
      ['src/main/security.ts', 'devCsp'],
      ['vite.renderer.config.ts', 'PROD_CSP'],
      ['vite.renderer.config.ts', 'DEV_CSP'],
    ] as const) {
      const block = cspBlock(file, name);
      expect(block, `${file} ${name}`).toContain("img-src 'self' data: blob: media:");
      expect(block, `${file} ${name}`).toContain("media-src 'self' blob: media:");
    }
  });
});

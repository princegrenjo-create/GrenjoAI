/**
 * Token integrity.
 *
 * `tokens.css` states the contract: "Component CSS is not allowed to carry a raw
 * colour, a raw length or a raw duration: if a value is needed and is not here,
 * it is added here first." A `var(--missing)` violates that contract silently —
 * an undeclared custom property is invalid at computed-value time, so the whole
 * declaration is dropped and the element renders with no measure at all. That is
 * exactly how `--size-prose` went missing in six rules without anything failing.
 *
 * This test reads the renderer's own CSS and fails on any referenced property
 * that no stylesheet defines. It is a source-level guard, not a rendering
 * assertion: it cannot prove the value is *right*, only that it exists.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const RENDERER = path.join(process.cwd(), 'src', 'renderer');

function cssFiles(dir: string, files: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) cssFiles(full, files);
    else if (entry.name.endsWith('.css')) files.push(full);
  }
  return files;
}

const files = cssFiles(RENDERER);
const sources = files.map((file) => ({
  file: path.relative(RENDERER, file),
  text: fs.readFileSync(file, 'utf8'),
}));

const defined = new Set<string>();
for (const source of sources) {
  for (const match of source.text.matchAll(/(--[a-z0-9-]+)\s*:/gi)) {
    const name = match[1];
    if (name) defined.add(name);
  }
}

describe('design tokens', () => {
  it('finds the stylesheets it is meant to check', () => {
    // A silent zero-file scan would make every assertion below vacuously pass.
    expect(files.length).toBeGreaterThan(5);
    expect(sources.some((source) => source.file.endsWith('tokens.css'))).toBe(true);
  });

  it('defines every custom property the renderer references', () => {
    const missing: string[] = [];
    for (const source of sources) {
      const lines = source.text.split(/\r?\n/);
      lines.forEach((line, index) => {
        for (const match of line.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)) {
          const name = match[1];
          if (!name) continue;
          if (!defined.has(name)) missing.push(`${source.file}:${index + 1} → ${name}`);
        }
      });
    }
    expect(missing, `undefined custom properties:\n${missing.join('\n')}`).toEqual([]);
  });

  it('defines the reading measure used for prose', () => {
    const tokens = sources.find((source) => source.file.endsWith('tokens.css'))?.text ?? '';
    expect(tokens).toMatch(/--size-prose:\s*65ch;/);
  });
});

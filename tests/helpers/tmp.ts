/**
 * Test scratch directory.
 *
 * Tests that need a real file (the credential store writes ciphertext, the smoke
 * script writes results) must not scatter files at the repository root, so they
 * all live under the run sink and are removed afterwards.
 */
import fs from 'node:fs';
import path from 'node:path';

const RUNTIME_ROOT = path.join(process.cwd(), '.work', 'test-runtime');

export interface ScratchDir {
  path: string;
  cleanup: () => void;
}

export function scratchDir(label: string): ScratchDir {
  const dir = path.join(RUNTIME_ROOT, `${label}-${Math.random().toString(36).slice(2, 10)}`);
  fs.mkdirSync(dir, { recursive: true });
  return {
    path: dir,
    cleanup: () => {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function readText(file: string): string {
  return fs.readFileSync(file, 'utf8');
}

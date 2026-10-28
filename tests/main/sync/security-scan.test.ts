/**
 * Static security guard for the sync module.
 *
 * These assertions are the mechanical half of the security invariants: a future edit
 * that reintroduces renderer storage, a hard-coded key, a debug log or a service_role
 * credential fails here even if every behavioural test still passes.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const syncSrc = path.join(repoRoot, 'src/main/sync');
const supabaseDir = path.join(repoRoot, 'supabase');

function walk(directory: string): string[] {
  const entries = readdirSync(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(fullPath));
    else if (entry.isFile()) files.push(fullPath);
  }
  return files;
}

const sourceFiles = [...walk(syncSrc), ...walk(supabaseDir)].filter((file) =>
  /\.(ts|sql|md)$/i.test(file),
);

function relative(file: string): string {
  return path.relative(repoRoot, file).replaceAll('\\', '/');
}

describe('sync security invariants (static scan)', () => {
  it('finds files to scan', () => {
    expect(sourceFiles.length).toBeGreaterThan(5);
  });

  it('never uses renderer localStorage, console logging or TypeScript escape hatches', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      const content = readFileSync(file, 'utf8');
      const checks: Array<[string, RegExp]> = [
        ['localStorage.', /localStorage\s*\./],
        ['window.localStorage', /window\s*\.\s*localStorage/],
        ['console.log', /console\s*\.\s*log\s*\(/],
        ['@ts-ignore', /@ts-ignore/],
        ['@ts-expect-error', /@ts-expect-error/],
        ['as any', /\bas\s+any\b/],
        ['TODO', /\bTODO\b/],
        ['FIXME', /\bFIXME\b/],
      ];
      for (const [label, pattern] of checks) {
        if (pattern.test(content)) offenders.push(`${relative(file)}: ${label}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('contains no hard-coded provider key, Supabase secret key or service_role JWT', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      const content = readFileSync(file, 'utf8');
      if (/sk-[A-Za-z0-9_-]{10,}/.test(content)) offenders.push(`${relative(file)}: sk- literal`);
      if (/AIza[0-9A-Za-z_-]{10,}/.test(content)) offenders.push(`${relative(file)}: AIza literal`);
      if (/sb_secret_[A-Za-z0-9_-]{8,}/.test(content)) {
        offenders.push(`${relative(file)}: sb_secret literal`);
      }
      const jwtPattern = /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;
      for (const match of content.matchAll(jwtPattern)) {
        const parts = match[0].split('.');
        const payloadPart = parts[1];
        if (payloadPart === undefined) continue;
        try {
          const decoded: unknown = JSON.parse(
            Buffer.from(payloadPart, 'base64url').toString('utf8'),
          );
          if (
            typeof decoded === 'object' &&
            decoded !== null &&
            'role' in decoded &&
            decoded.role === 'service_role'
          ) {
            offenders.push(`${relative(file)}: service_role JWT`);
          }
        } catch {
          // Not decodable: it is a test fixture string, not a real credential.
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('documents that only the publishable key is safe and the service_role key never ships', () => {
    const readme = readFileSync(path.join(supabaseDir, 'README.md'), 'utf8');
    expect(readme).toMatch(/service_role/i);
    expect(readme).toMatch(/must never/i);
    expect(readme).toMatch(/publishable/i);
    expect(readme).toMatch(/0001_init\.sql/);
    expect(readme).toMatch(/0002_rls\.sql/);
  });

  it('keeps a credential-shaped string out of the migrations', () => {
    const sqlFiles = sourceFiles.filter((file) => file.endsWith('.sql'));
    expect(sqlFiles.length).toBe(2);
    for (const file of sqlFiles) {
      const content = readFileSync(file, 'utf8');
      expect(content).not.toMatch(/sk-[A-Za-z0-9_-]{10,}/);
      expect(content).not.toMatch(/AIza[0-9A-Za-z_-]{10,}/);
      expect(content).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\./);
    }
  });
});

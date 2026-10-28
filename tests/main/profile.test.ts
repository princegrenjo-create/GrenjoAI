/**
 * Profile resolution and the pre-rename migration.
 *
 * This is the one piece of the rename that can destroy a user's history if it is
 * wrong, so it is tested against real directories on disk rather than a mock.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LEGACY_USER_DATA_FOLDER,
  PROFILE_MARKER,
  USER_DATA_FOLDER,
  resolveUserDataDir,
} from '@main/profile';
import { scratchDir, type ScratchDir } from '../helpers/tmp';

let scratch: ScratchDir | null = null;

afterEach(() => {
  scratch?.cleanup();
  scratch = null;
});

/** An appData-shaped directory with a legacy profile containing a database. */
function fixture(): { appData: string; legacy: string; next: string } {
  scratch = scratchDir('profile');
  const appData = scratch.path;
  const legacy = path.join(appData, LEGACY_USER_DATA_FOLDER);
  fs.mkdirSync(path.join(legacy, 'data'), { recursive: true });
  fs.writeFileSync(path.join(legacy, 'data', 'app.db'), 'SQLITE-FAKE');
  fs.writeFileSync(path.join(legacy, 'credentials.bin'), 'CIPHERTEXT');
  fs.mkdirSync(path.join(legacy, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(legacy, 'logs', 'main.log'), 'log line');
  return { appData, legacy, next: path.join(appData, USER_DATA_FOLDER) };
}

describe('profile resolution', () => {
  it('renames the legacy profile on the normal upgrade path and keeps its data', () => {
    const { appData, legacy, next } = fixture();
    const result = resolveUserDataDir(appData);

    expect(result.migration).toBe('renamed');
    expect(result.dir).toBe(next);
    expect(fs.existsSync(legacy)).toBe(false);
    expect(fs.readFileSync(path.join(next, 'data', 'app.db'), 'utf8')).toBe('SQLITE-FAKE');
    expect(fs.readFileSync(path.join(next, 'credentials.bin'), 'utf8')).toBe('CIPHERTEXT');
    expect(fs.existsSync(path.join(next, 'logs', 'main.log'))).toBe(true);
    expect(fs.existsSync(path.join(next, PROFILE_MARKER))).toBe(true);
  });

  it('uses a fresh profile when there is nothing to migrate', () => {
    scratch = scratchDir('profile-fresh');
    const result = resolveUserDataDir(scratch.path);
    expect(result.migration).toBe('none');
    expect(result.dir).toBe(path.join(scratch.path, USER_DATA_FOLDER));
    expect(fs.existsSync(path.join(result.dir, PROFILE_MARKER))).toBe(true);
  });

  it('does not migrate again once the new profile is claimed', () => {
    const { appData, next } = fixture();
    resolveUserDataDir(appData);
    // A stale legacy folder reappears; the marker must win.
    fs.mkdirSync(path.join(appData, LEGACY_USER_DATA_FOLDER, 'data'), { recursive: true });
    fs.writeFileSync(path.join(appData, LEGACY_USER_DATA_FOLDER, 'data', 'app.db'), 'STALE');

    const second = resolveUserDataDir(appData);
    expect(second.migration).toBe('none');
    expect(second.dir).toBe(next);
    expect(fs.readFileSync(path.join(next, 'data', 'app.db'), 'utf8')).toBe('SQLITE-FAKE');
  });

  it('copies instead of renaming when an unclaimed folder already exists', () => {
    const { appData, legacy, next } = fixture();
    // Simulates an empty folder left behind by a failed launch: no marker, no data.
    fs.mkdirSync(next, { recursive: true });

    const result = resolveUserDataDir(appData);
    expect(result.migration).toBe('copied');
    expect(result.dir).toBe(next);
    expect(fs.readFileSync(path.join(next, 'data', 'app.db'), 'utf8')).toBe('SQLITE-FAKE');
    // The source is left untouched so a failed copy is still recoverable.
    expect(fs.existsSync(path.join(legacy, 'data', 'app.db'))).toBe(true);
  });

  it('never overwrites data already present in the new profile', () => {
    const { appData, next } = fixture();
    fs.mkdirSync(path.join(next, 'data'), { recursive: true });
    fs.writeFileSync(path.join(next, 'data', 'app.db'), 'NEWER');

    const result = resolveUserDataDir(appData);
    expect(result.dir).toBe(next);
    expect(fs.readFileSync(path.join(next, 'data', 'app.db'), 'utf8')).toBe('NEWER');
  });
});

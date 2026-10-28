/**
 * Profile (user-data) directory resolution and the pre-rename migration.
 *
 * Kept out of `index.ts` and free of any `electron` import so that the migration
 * — the one piece of startup logic that can lose a user's history if it is wrong
 * — can be tested against real directories.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Current product folder name. Dev and the installed app share one profile. */
export const USER_DATA_FOLDER = 'Grenjo AI Tool';
/** The previous product name. Its profile is migrated forward once. */
export const LEGACY_USER_DATA_FOLDER = 'Personal AI Desk';
/** Written into a profile once it has been selected, so migration runs exactly once. */
export const PROFILE_MARKER = 'profile.json';

export type ProfileMigration = 'none' | 'renamed' | 'copied' | 'kept-legacy';

export interface ProfileResolution {
  dir: string;
  migration: ProfileMigration;
}

/** Entries carried from the legacy profile when a rename is not possible. */
const MIGRATED_ENTRIES = ['data', 'logs', 'credentials.bin'] as const;

function exists(target: string): boolean {
  try {
    return fs.existsSync(target);
  } catch {
    return false;
  }
}

/**
 * Chooses the profile directory, carrying the pre-rename profile forward so a
 * rebrand never costs the owner their chats, settings, agents or keys.
 *
 * This must run **before** `requestSingleInstanceLock()`, because that call
 * creates the default profile folder as a side effect; a check made after it
 * would always see a "new" folder and skip the migration. That ordering is
 * load-bearing and is asserted by the caller's module layout.
 *
 * A marker file — not the presence of the folder — decides whether a profile has
 * already been claimed, so an empty folder left behind by a failed launch cannot
 * shadow the real data.
 *
 * Fallbacks, in order:
 *   1. marker present, or no legacy profile -> use the new folder;
 *   2. new folder absent -> rename legacy to new (the normal upgrade path);
 *   3. new folder present without a marker -> copy the legacy entries in, because
 *      deleting the legacy folder risks the owner's data;
 *   4. anything fails -> keep using the legacy folder and report it.
 */
export function resolveUserDataDir(appDataDir: string): ProfileResolution {
  const next = path.join(appDataDir, USER_DATA_FOLDER);
  const legacy = path.join(appDataDir, LEGACY_USER_DATA_FOLDER);
  const marked = exists(path.join(next, PROFILE_MARKER));
  const legacyDb = exists(path.join(legacy, 'data', 'app.db'));

  const claim = (dir: string): void => {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, PROFILE_MARKER),
        JSON.stringify(
          {
            product: 'grenjo-ai-tool',
            migratedFrom: legacyDb ? LEGACY_USER_DATA_FOLDER : null,
            at: new Date().toISOString(),
          },
          null,
          2,
        ),
        'utf8',
      );
    } catch {
      /* a missing marker only means the migration check runs again next launch */
    }
  };

  if (marked || !exists(legacy)) {
    claim(next);
    return { dir: next, migration: 'none' };
  }

  if (!exists(next)) {
    try {
      fs.renameSync(legacy, next);
      claim(next);
      return { dir: next, migration: 'renamed' };
    } catch {
      return { dir: legacy, migration: 'kept-legacy' };
    }
  }

  try {
    for (const entry of MIGRATED_ENTRIES) {
      const from = path.join(legacy, entry);
      const to = path.join(next, entry);
      if (exists(from) && !exists(to)) {
        fs.cpSync(from, to, { recursive: true, errorOnExist: false, force: false });
      }
    }
    claim(next);
    return { dir: next, migration: 'copied' };
  } catch {
    return { dir: legacy, migration: 'kept-legacy' };
  }
}

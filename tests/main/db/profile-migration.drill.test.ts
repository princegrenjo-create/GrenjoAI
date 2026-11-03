/**
 * Migration drill on a real profile.
 *
 * Skipped unless `DRILL_DB` points at a **copy** of an existing database. The point
 * is not to test the migration runner (the suite does that on synthetic files); it is
 * to open a database this app has actually written, with the build that ships, and
 * confirm that what the owner has — conversations, messages, settings, provider rows
 * — survives a schema upgrade.
 *
 * Read-only on the source: the caller copies the file into the run sink and passes
 * the copy. This test never touches the profile in place.
 *
 *   $env:DRILL_DB='.work/<run>/raw/drill/app.db'
 *   npx vitest run --config vitest.node.config.ts tests/main/db/profile-migration.drill.test.ts
 */
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '@main/db/index';
import { LATEST_SCHEMA_VERSION } from './helpers';

const drillPath = process.env.DRILL_DB;

/** Row counts straight from SQLite, without going through the app's runner. */
function census(file: string): Record<string, number> {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as Array<{ name: string }>;
    const counts: Record<string, number> = {};
    for (const { name } of tables) {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number };
      counts[name] = Number(row.n);
    }
    const version = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as {
      v: number | null;
    };
    counts.schema_version = Number(version.v ?? 0);
    /*
     * Soft-deleted rows are still rows, but `list()` hides them, so comparing a
     * list against a raw count would fail on any profile that has ever deleted a
     * conversation — which a real one has.
     */
    for (const name of ['conversations', 'messages']) {
      const row = db
        .prepare(`SELECT COUNT(*) AS n FROM "${name}" WHERE deleted_at IS NULL`)
        .get() as { n: number };
      counts[`${name}_visible`] = Number(row.n);
    }
    return counts;
  } finally {
    db.close();
  }
}

describe.skipIf(!drillPath)('existing profile migration drill', () => {
  it('upgrades the copied profile without losing a row', () => {
    const file = drillPath as string;
    const before = census(file);
    expect(before.schema_version).toBeGreaterThan(0);
    // The copy must be an older schema for the drill to mean anything.
    expect(before.schema_version).toBeLessThanOrEqual(LATEST_SCHEMA_VERSION);

    const db = openDatabase(file);
    try {
      expect(db.migrations.version()).toBe(LATEST_SCHEMA_VERSION);
      const conversations = db.conversations.list({ limit: 500 });
      expect(conversations.length).toBe(before.conversations_visible ?? 0);
      for (const conversation of conversations) {
        const messages = db.messages.listByConversation(conversation.id);
        expect(db.messages.countByConversation(conversation.id)).toBe(messages.length);
      }
      expect(db.providers.list().length).toBe(before.providers ?? 0);
      expect(db.models.list().length).toBeGreaterThanOrEqual(0);
      // Credentials were never in here: the credential file is separate.
      const settings = db.settings.get();
      expect(settings).toBeTruthy();
    } finally {
      db.close();
    }

    const after = census(file);
    expect(after.schema_version).toBe(LATEST_SCHEMA_VERSION);
    // Every table that existed before still has at least as many rows, and the two
    // media tables now exist.
    for (const [table, count] of Object.entries(before)) {
      if (table === 'schema_version') continue;
      expect(after[table] ?? 0, `${table} lost rows`).toBeGreaterThanOrEqual(count);
    }
    expect(after.media).toBe(0);
    expect(after.generation_jobs).toBe(0);

    // The numbers a reader needs, printed so the log is the evidence.
    process.stdout.write(
      `[drill] before=${JSON.stringify(before)}\n[drill] after=${JSON.stringify(after)}\n`,
    );
  });
});

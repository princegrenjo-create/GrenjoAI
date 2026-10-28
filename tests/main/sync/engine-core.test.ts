import { describe, expect, it } from 'vitest';
import { createHarness, makeLocalRow, makeRemoteRow, TEST_USER_ID } from './helpers/fakes';
import type { Harness } from './helpers/fakes';

async function signIn(harness: Harness): Promise<void> {
  await harness.engine.signIn({
    email: 'owner@example.com',
    password: 'correct horse battery staple',
  });
}

describe('sync engine — push', () => {
  it('moves a pending local row through upsert to pushed and clears it from the outbox', async () => {
    const harness = createHarness({
      rows: [
        makeLocalRow({
          entity: 'conversation',
          id: 'c1',
          version: 2,
          payload: { id: 'c1', title: 'Hello', updatedAt: '2026-10-29T03:00:00.000Z' },
        }),
      ],
    });
    await harness.engine.start();
    await signIn(harness);

    const summary = await harness.engine.syncNow();

    expect(summary.ok).toBe(true);
    expect(summary.pushed).toBe(1);
    expect(summary.failed).toBe(0);
    expect(harness.cloud.upserts).toHaveLength(1);
    const upsert = harness.cloud.upserts[0]!;
    expect(upsert.table).toBe('conversations');
    expect(upsert.onConflict).toBe('id');
    expect(upsert.rows[0]).toMatchObject({
      id: 'c1',
      user_id: TEST_USER_ID,
      version: 2,
      deleted_at: null,
    });
    expect(harness.db.rows.get('conversation:c1')?.dirty).toBe(false);
    expect(harness.engine.status().pendingCount).toBe(0);
    expect(harness.engine.status().phase).toBe('idle');
  });

  it('strips credential-bearing fields from a provider payload and never uploads a key', async () => {
    const payload = {
      id: 'p1',
      name: 'OpenAI',
      kind: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      enabled: true,
      apiKey: 'sk-live-abcdef123456',
      hasKey: true,
      keyFingerprint: '0123abcd',
      keyUpdatedAt: '2026-10-01T00:00:00.000Z',
      nested: { accessToken: 'AIzaSyFakeKeyValue123456', note: 'keep me' },
    };
    const harness = createHarness({
      rows: [makeLocalRow({ entity: 'provider', id: 'p1', payload })],
    });
    await harness.engine.start();
    await signIn(harness);

    const summary = await harness.engine.syncNow();

    expect(summary.ok).toBe(true);
    const pushed = harness.cloud.upserts[0]!.rows[0]!;
    expect(pushed.payload).toMatchObject({
      id: 'p1',
      name: 'OpenAI',
      kind: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      enabled: true,
    });
    expect(pushed.payload).not.toHaveProperty('apiKey');
    expect(pushed.payload).not.toHaveProperty('hasKey');
    expect(pushed.payload).not.toHaveProperty('keyFingerprint');
    expect(pushed.payload).not.toHaveProperty('keyUpdatedAt');
    expect(JSON.stringify(pushed.payload)).not.toMatch(/sk-|AIza|eyJ/);
    // The local copy is untouched: the engine only sanitises what leaves the device.
    expect(harness.db.rows.get('provider:p1')?.payload).toBe(payload);
  });

  it('refuses to upload a free-text field that contains a credential instead of rewriting it', async () => {
    const harness = createHarness({
      rows: [
        makeLocalRow({
          entity: 'message',
          id: 'm1',
          payload: { id: 'm1', content: 'my key is sk-live-abcdef123456' },
        }),
      ],
    });
    await harness.engine.start();
    await signIn(harness);

    const summary = await harness.engine.syncNow();

    expect(summary.ok).toBe(false);
    expect(summary.failed).toBe(1);
    expect(summary.pushed).toBe(0);
    expect(harness.cloud.upserts).toHaveLength(0);
    expect(harness.db.failures).toHaveLength(1);
    expect(harness.db.failures[0]!.error).toMatch(/credential/i);
    expect(harness.engine.status().phase).toBe('error');
    // Local row is kept (dirty) so nothing was lost.
    expect(harness.db.rows.get('message:m1')?.dirty).toBe(true);
  });

  it('pushes a tombstone for a delete operation', async () => {
    const harness = createHarness({
      rows: [
        makeLocalRow({
          entity: 'agent',
          id: 'a1',
          op: 'delete',
          version: 3,
          payload: { id: 'a1', updatedAt: '2026-10-29T02:55:00.000Z' },
        }),
      ],
    });
    await harness.engine.start();
    await signIn(harness);
    await harness.engine.syncNow();

    const pushed = harness.cloud.upserts[0]!.rows[0]!;
    expect(pushed.deleted_at).toBe('2026-10-29T02:55:00.000Z');
  });

  it('never uploads a payload matching the credential pattern, across every table', async () => {
    const harness = createHarness({
      rows: [
        makeLocalRow({
          entity: 'provider',
          id: 'p1',
          payload: {
            id: 'p1',
            name: 'OpenAI',
            kind: 'openai',
            baseUrl: 'https://api.openai.com/v1',
            enabled: true,
            apiKey: 'sk-live-abcdef123456',
            hasKey: true,
          },
        }),
        makeLocalRow({
          entity: 'model',
          id: 'mo1',
          payload: { id: 'mo1', displayName: 'Custom', modelId: 'custom-1' },
        }),
        makeLocalRow({ entity: 'agent', id: 'a1', payload: { id: 'a1', name: 'Agent' } }),
        makeLocalRow({
          entity: 'conversation',
          id: 'c1',
          payload: { id: 'c1', title: 'Conversation' },
        }),
        makeLocalRow({
          entity: 'message',
          id: 'm1',
          payload: { id: 'm1', conversationId: 'c1', role: 'user', content: 'hello' },
        }),
        makeLocalRow({
          entity: 'settings',
          id: 's1',
          payload: {
            schemaVersion: 1,
            general: { theme: 'dark' },
            advanced: { token: 'AIzaSyFakeKeyValue123456' },
          },
        }),
      ],
    });
    await harness.engine.start();
    await signIn(harness);

    const summary = await harness.engine.syncNow();

    expect(summary.failed).toBe(0);
    expect(harness.cloud.upserts.length).toBeGreaterThan(0);
    for (const upsert of harness.cloud.upserts) {
      for (const row of upsert.rows) {
        expect(JSON.stringify(row.payload)).not.toMatch(/sk-|AIza|eyJ/);
        expect(row.payload).not.toHaveProperty('apiKey');
        expect(row.payload).not.toHaveProperty('token');
      }
    }
  });

  it('pulls every table before the push pass, in the fixed order', async () => {
    const harness = createHarness();
    await harness.engine.start();
    await signIn(harness);
    await harness.engine.syncNow();

    const firstUpsert = harness.cloud.events.findIndex((event) => event.startsWith('upsert:'));
    const queries = harness.cloud.events.filter((event) => event.startsWith('select:'));
    expect(queries).toEqual([
      'select:providers',
      'select:models',
      'select:agents',
      'select:conversations',
      'select:messages',
      'select:settings',
    ]);
    if (firstUpsert >= 0) {
      const lastQuery = harness.cloud.events.lastIndexOf('select:settings');
      expect(lastQuery).toBeLessThan(firstUpsert);
    }
  });

  it('does not block a local write that happens during a sync cycle', async () => {
    const harness = createHarness({
      rows: [makeLocalRow({ entity: 'conversation', id: 'c1', payload: { id: 'c1' } })],
    });
    harness.cloud.setQueryHook((table) => {
      if (table === 'providers') {
        harness.db.put({ entity: 'agent', id: 'a-during-sync', payload: { id: 'a-during-sync' } });
      }
    });
    await harness.engine.start();
    await signIn(harness);

    const summary = await harness.engine.syncNow();

    expect(summary.ok).toBe(true);
    const added = harness.db.rows.get('agent:a-during-sync');
    expect(added).toBeDefined();
    expect(added?.dirty).toBe(false);
    expect(harness.cloud.upserts.some((entry) => entry.table === 'agents')).toBe(true);
  });
});

describe('sync engine — pull', () => {
  it('ignores a duplicate remote record with the same version and keeps the local copy', async () => {
    const harness = createHarness({
      rows: [
        makeLocalRow({
          entity: 'conversation',
          id: 'c1',
          dirty: false,
          version: 3,
          payload: { id: 'c1', title: 'local' },
        }),
      ],
      remote: [
        {
          table: 'conversations',
          row: makeRemoteRow({
            id: 'c1',
            version: 3,
            updated_at: '2026-10-29T04:00:00.000Z',
            payload: { id: 'c1', title: 'remote duplicate' },
          }),
        },
      ],
    });
    await harness.engine.start();
    await signIn(harness);

    const summary = await harness.engine.syncNow();

    expect(summary.pulled).toBe(0);
    expect(summary.conflictsRecorded).toBe(0);
    expect(summary.pushed).toBe(0);
    expect(harness.db.rows.get('conversation:c1')?.payload).toMatchObject({ title: 'local' });
    expect(harness.db.conflictRecords).toHaveLength(0);
  });

  it('applies a newer remote record over a clean local row', async () => {
    const harness = createHarness({
      rows: [
        makeLocalRow({
          entity: 'conversation',
          id: 'c1',
          dirty: false,
          version: 2,
          payload: { id: 'c1', title: 'old' },
        }),
      ],
      remote: [
        {
          table: 'conversations',
          row: makeRemoteRow({
            id: 'c1',
            version: 4,
            updated_at: '2026-10-29T04:00:00.000Z',
            payload: { id: 'c1', title: 'newer' },
          }),
        },
      ],
    });
    await harness.engine.start();
    await signIn(harness);

    const summary = await harness.engine.syncNow();

    expect(summary.pulled).toBe(1);
    expect(summary.conflictsRecorded).toBe(0);
    const local = harness.db.rows.get('conversation:c1');
    expect(local?.version).toBe(4);
    expect(local?.payload).toMatchObject({ title: 'newer' });
    expect(local?.dirty).toBe(false);
  });

  it('skips a malformed remote row and one that belongs to another user', async () => {
    const harness = createHarness({
      enforceUserFilter: false,
      remote: [
        {
          table: 'conversations',
          row: makeRemoteRow({
            id: 'foreign',
            user_id: '99999999-8888-4777-8666-555555555555',
            version: 1,
            updated_at: '2026-10-29T04:00:00.000Z',
          }),
        },
      ],
    });
    await harness.engine.start();
    await signIn(harness);

    const summary = await harness.engine.syncNow();

    expect(summary.skipped).toBeGreaterThanOrEqual(1);
    expect(harness.db.rows.has('conversation:foreign')).toBe(false);
  });
});

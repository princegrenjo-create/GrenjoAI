/**
 * Attachment metadata through the sync path.
 *
 * A message pulled from another device used to arrive with an empty attachment
 * list because the remote column mapping ignored the field. This pins the fix:
 * metadata travels, and it survives as `[]` when the payload has none.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '@main/db';
import { createNullLogger } from '@main/logger';
import type { Database } from '@shared/repository-contract';
import type { MessageAttachment } from '@shared/attachments';
import { scratchDir, type ScratchDir } from '../../helpers/tmp';

let scratch: ScratchDir | null = null;
let db: Database | null = null;

afterEach(() => {
  db?.close();
  db = null;
  scratch?.cleanup();
  scratch = null;
});

function open(): Database {
  scratch = scratchDir('sync-attachments');
  db = openDatabase(`${scratch.path}/app.db`, { logger: createNullLogger() });
  return db;
}

const attachment: MessageAttachment = {
  id: 'att-remote',
  kind: 'text',
  name: 'brief.md',
  mimeType: 'text/markdown',
  sizeBytes: 2048,
  contentStatus: 'extracted',
  contentNote: null,
  extractedChars: 120,
  sentToProvider: false,
  imageWidth: null,
  imageHeight: null,
  durationMs: null,
  createdAt: '2026-10-29T00:00:00.000Z',
};

describe('attachments through sync apply', () => {
  it('keeps the attachment metadata of a message pulled from another device', () => {
    const store = open();
    const conversation = store.conversations.create({
      title: 'From another device',
      providerId: null,
      modelId: null,
    });

    const applied = store.sync.applyRemote('message', {
      id: 'remote-message-1',
      version: 3,
      updatedAt: '2026-10-29T01:00:00.000Z',
      deletedAt: null,
      payload: {
        conversationId: conversation.id,
        role: 'user',
        content: 'here is the brief',
        seq: 1,
        status: 'complete',
        attachments: [attachment],
        createdAt: '2026-10-29T01:00:00.000Z',
        updatedAt: '2026-10-29T01:00:00.000Z',
      },
    });

    expect(applied).toBe('applied');
    const stored = store.messages.listByConversation(conversation.id);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.content).toBe('here is the brief');
    expect(stored[0]?.attachments).toHaveLength(1);
    expect(stored[0]?.attachments[0]?.name).toBe('brief.md');
    expect(stored[0]?.attachments[0]?.contentStatus).toBe('extracted');
  });

  it('applies a message with no attachments as an empty list, not as an error', () => {
    const store = open();
    const conversation = store.conversations.create({
      title: 'Plain',
      providerId: null,
      modelId: null,
    });

    store.sync.applyRemote('message', {
      id: 'remote-message-2',
      version: 1,
      updatedAt: '2026-10-29T01:00:00.000Z',
      deletedAt: null,
      payload: {
        conversationId: conversation.id,
        role: 'user',
        content: 'no files here',
        seq: 1,
        status: 'complete',
        createdAt: '2026-10-29T01:00:00.000Z',
        updatedAt: '2026-10-29T01:00:00.000Z',
      },
    });

    const stored = store.messages.listByConversation(conversation.id);
    expect(stored[0]?.attachments).toEqual([]);
  });
});

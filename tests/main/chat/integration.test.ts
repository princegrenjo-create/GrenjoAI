/**
 * Integration: the real SQLite database + the real provider registry + the chat
 * service, with only the network replaced.
 *
 * The other chat tests use an in-memory fake repository, which proves the
 * orchestration logic but not the SQL mapping. This suite proves that a turn
 * actually lands in the database, that the numbers and ordering come out right,
 * and that the conversation survives a close/reopen (an app restart).
 */
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '@main/db';
import { createChatService } from '@main/chat/service';
import { createMemoryCredentialStore } from '@main/credentials';
import { bindProviderKey } from '@main/models/endpoint-policy';
import { createNullLogger } from '@main/logger';
import { createRegistry } from '@main/providers/registry';
import { AppError, appError } from '@shared/errors';
import type {
  ChatCompletionRequest,
  ChatRunHooks,
  ChatRunResult,
  ProviderTransport,
  TransportResponse,
} from '@shared/provider-contract';
import type { ChatStreamEvent } from '@shared/types';
import type { Database } from '@shared/repository-contract';
import { scratchDir, type ScratchDir } from '../../helpers/tmp';

let scratch: ScratchDir | null = null;
let db: Database | null = null;

afterEach(() => {
  try {
    db?.close();
  } catch {
    /* already closed */
  }
  db = null;
  scratch?.cleanup();
  scratch = null;
});

function open(): Database {
  scratch = scratchDir('chat-integration');
  db = openDatabase(path.join(scratch.path, 'app.db'), { logger: createNullLogger() });
  return db;
}

function harness(store: Database) {
  const credentials = createMemoryCredentialStore();
  const provider = store.providers.create({
    kind: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
  });
  bindProviderKey(credentials, provider.id, provider.baseUrl, 'sk-integration-0123456789');

  const events: ChatStreamEvent[] = [];
  const requests: ChatCompletionRequest[] = [];
  const transport: ProviderTransport = {
    async send(): Promise<TransportResponse> {
      return { status: 200, body: '{}', headers: {} };
    },
    async run(_runtime, _adapter, request, hooks: ChatRunHooks): Promise<ChatRunResult> {
      requests.push(request);
      const parts = ['Hello', ', ', 'world'];
      for (const part of parts) hooks.onText?.(part);
      hooks.onUsage?.({ promptTokens: 5, completionTokens: 3, totalTokens: 8 });
      hooks.onFinish?.('stop');
      return { text: parts.join(''), usage: { totalTokens: 8 }, finishReason: 'stop' };
    },
  };

  const service = createChatService({
    db: store,
    credentials,
    registry: createRegistry(),
    transport,
    settings: () => store.settings.get(),
    emit: (event) => events.push(event),
    logger: createNullLogger(),
    isOnline: () => true,
    flushIntervalMs: 0,
    attachments: { resolve: () => [], release: () => undefined },
  });

  return { credentials, provider, service, events, requests };
}

async function settle(events: ChatStreamEvent[], timeoutMs = 3000): Promise<ChatStreamEvent> {
  const started = Date.now();
  for (;;) {
    const terminal = events.find((event) => event.type === 'done' || event.type === 'error');
    if (terminal) return terminal;
    if (Date.now() - started > timeoutMs) throw new Error('chat turn did not settle');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('chat service against the real database', () => {
  it('persists a completed turn and the data survives a reopen', async () => {
    const store = open();
    const { provider, service, events } = harness(store);
    const conversation = store.conversations.create({
      title: 'Integration',
      providerId: provider.id,
      modelId: 'deepseek-chat',
    });

    const { assistantMessageId } = service.send({
      conversationId: conversation.id,
      content: 'Say hello world',
    });
    const terminal = await settle(events);
    expect(terminal.type).toBe('done');

    const messages = store.messages.listByConversation(conversation.id);
    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe('user');
    expect(messages[0]?.content).toBe('Say hello world');
    expect(messages[1]?.id).toBe(assistantMessageId);
    expect(messages[1]?.content).toBe('Hello, world');
    expect(messages[1]?.status).toBe('complete');
    expect(messages[1]?.seq).toBeGreaterThan(messages[0]?.seq ?? 0);
    expect(messages[1]?.modelRef).toEqual({
      providerId: provider.id,
      modelId: 'deepseek-chat',
    });

    // Simulate an application restart against the same file.
    const file = store.filePath;
    store.checkpoint();
    store.close();
    const reopened = openDatabase(file, { logger: createNullLogger() });
    db = reopened;
    const afterRestart = reopened.messages.listByConversation(conversation.id);
    expect(afterRestart).toHaveLength(2);
    expect(afterRestart[1]?.content).toBe('Hello, world');
    expect(reopened.conversations.get(conversation.id)?.title).toBe('Integration');
  });

  it('replays prior turns as context on the next message', async () => {
    const store = open();
    const { provider, service, events, requests } = harness(store);
    const conversation = store.conversations.create({
      title: 'Context',
      providerId: provider.id,
      modelId: 'deepseek-chat',
    });

    service.send({ conversationId: conversation.id, content: 'first question' });
    await settle(events);

    service.send({ conversationId: conversation.id, content: 'second question' });
    await settle(events);

    expect(requests).toHaveLength(2);
    const second = requests[1];
    expect(second?.turns.map((turn) => turn.content)).toEqual([
      'first question',
      'Hello, world',
      'second question',
    ]);
    expect(second?.turns.map((turn) => turn.role)).toEqual(['user', 'assistant', 'user']);
  });

  it('marks the turn as failed in the database when the provider rejects the key', async () => {
    const store = open();
    const credentials = createMemoryCredentialStore();
    const provider = store.providers.create({
      kind: 'deepseek',
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com/v1',
    });
    bindProviderKey(credentials, provider.id, provider.baseUrl, 'sk-integration-0123456789');
    const events: ChatStreamEvent[] = [];
    const transport: ProviderTransport = {
      async send(): Promise<TransportResponse> {
        return { status: 401, body: '{"error":"invalid key"}', headers: {} };
      },
      async run(): Promise<ChatRunResult> {
        throw new AppError(appError('invalid_key', 'The provider rejected the API key.', { status: 401 }));
      },
    };
    const service = createChatService({
      db: store,
      credentials,
      registry: createRegistry(),
      transport,
      settings: () => store.settings.get(),
      emit: (event) => events.push(event),
      logger: createNullLogger(),
      isOnline: () => true,
      flushIntervalMs: 0,
      attachments: { resolve: () => [], release: () => undefined },
    });
    const conversation = store.conversations.create({
      title: 'Failure',
      providerId: provider.id,
      modelId: 'deepseek-chat',
    });

    service.send({ conversationId: conversation.id, content: 'hello' });
    const terminal = await settle(events);
    expect(terminal.type).toBe('error');

    const messages = store.messages.listByConversation(conversation.id);
    const assistant = messages.at(-1);
    expect(assistant?.status).toBe('error');
    expect(assistant?.error?.code).toBe('invalid_key');
    // The user's message is kept so they can retry without retyping.
    expect(messages[0]?.role).toBe('user');
  });
});

/** Emits are collected by `harness`; nothing global is used. */

import { describe, expect, it } from 'vitest';
import { appError, AppError } from '@shared/errors';
import type {
  ChatStreamEvent,
  GenerationParams,
  ProviderKind,
} from '@shared/types';
import type {
  ChatCompletionRequest,
  ChatRunHooks,
  ChatRunResult,
  ProviderAdapter,
  ProviderRegistry,
  ProviderRuntime,
  ProviderTransport,
  TransportOptions,
  TransportResponse,
  HttpRequestSpec,
} from '@shared/provider-contract';
import { createMemoryCredentialStore } from '@main/credentials';
import { bindProviderKey } from '@main/models/endpoint-policy';
import { createNullLogger } from '@main/logger';
import { createChatService } from '@main/chat/service';
import { createFakeDatabase, type FakeDatabase } from '../../helpers/fake-database';

interface Captured {
  requests: ChatCompletionRequest[];
  runtimes: ProviderRuntime[];
}

function stubAdapter(kind: ProviderKind): ProviderAdapter {
  const spec = (): HttpRequestSpec => ({ url: 'https://example.test', method: 'POST', headers: {}, body: null });
  return {
    kind,
    label: 'Stub',
    supportedParams: ['temperature', 'topP', 'maxOutputTokens', 'stop'],
    supportsModelDiscovery: true,
    buildTestRequest: spec,
    buildListModelsRequest: spec,
    parseListModels: () => ({ models: [], error: null }),
    parseTestResponse: () => ({ ok: true, latencyMs: 1, message: 'ok', modelsFound: 0, error: null }),
    buildChatRequest: (_runtime, request) => ({ ...spec(), body: JSON.stringify(request) }),
    createResponseParser: () => ({ push: () => [], end: () => [] }),
    parseError: (status) => appError('provider_error', `status ${status}`),
  };
}

interface HarnessOptions {
  kind?: ProviderKind;
  modelId?: string;
  run?: (
    runtime: ProviderRuntime,
    request: ChatCompletionRequest,
    hooks: ChatRunHooks,
    options?: TransportOptions,
  ) => Promise<ChatRunResult>;
  appParams?: GenerationParams;
  weirdnessMode?: 'off' | 'creativityBias';
  withKey?: boolean;
}

function createHarness(options: HarnessOptions = {}) {
  const kind = options.kind ?? 'deepseek';
  const modelId = options.modelId ?? 'deepseek-chat';
  const db: FakeDatabase = createFakeDatabase();
  const credentials = createMemoryCredentialStore();
  const provider = db.providers.create({
    kind,
    name: 'Test provider',
    baseUrl: 'https://api.example.test/v1',
  });
  if (options.withKey !== false) {
    // A key is only usable while bound to the provider's base URL.
    bindProviderKey(credentials, provider.id, provider.baseUrl, 'sk-test-0123456789abcdef');
  }

  if (options.appParams) {
    db.settings.patch({ defaults: { params: options.appParams } });
  }
  if (options.weirdnessMode) {
    db.settings.patch({ weirdness: { mode: options.weirdnessMode, bias: 0.6 } });
  }

  const conversation = db.conversations.create({
    title: 'New conversation',
    providerId: provider.id,
    modelId,
  });

  const captured: Captured = { requests: [], runtimes: [] };
  const events: ChatStreamEvent[] = [];

  const defaultRun = async (
    runtime: ProviderRuntime,
    request: ChatCompletionRequest,
    hooks: ChatRunHooks,
  ): Promise<ChatRunResult> => {
    hooks.onText?.('Hel');
    hooks.onText?.('lo');
    hooks.onUsage?.({ totalTokens: 3 });
    hooks.onFinish?.('stop');
    return { text: 'Hello', usage: { totalTokens: 3 }, finishReason: 'stop' };
  };

  const transport: ProviderTransport = {
    async send(): Promise<TransportResponse> {
      return { status: 200, body: '{}', headers: {} };
    },
    async run(runtime, _adapter, request, hooks, opts) {
      captured.runtimes.push(runtime);
      captured.requests.push(request);
      return (options.run ?? defaultRun)(runtime, request, hooks, opts);
    },
  };

  const adapter = stubAdapter(kind);
  const registry: ProviderRegistry = {
    get: () => adapter,
    all: () => [adapter],
  };

  const service = createChatService({
    db,
    credentials,
    registry,
    transport,
    settings: () => db.settings.get(),
    emit: (event) => events.push(event),
    logger: createNullLogger(),
    isOnline: () => true,
    flushIntervalMs: 0,
  });

  function waitForTerminal(timeoutMs = 2000): Promise<ChatStreamEvent> {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const timer = setInterval(() => {
        const terminal = events.find((event) => event.type === 'done' || event.type === 'error');
        if (terminal) {
          clearInterval(timer);
          resolve(terminal);
        } else if (Date.now() - started > timeoutMs) {
          clearInterval(timer);
          reject(new Error('no terminal chat event within the timeout'));
        }
      }, 5);
    });
  }

  return { db, credentials, provider, conversation, captured, events, service, waitForTerminal };
}

describe('chat service', () => {
  it('streams deltas in order and persists the concatenated assistant message', async () => {
    const harness = createHarness();
    const result = harness.service.send({
      conversationId: harness.conversation.id,
      content: 'Say hello',
    });

    const terminal = await harness.waitForTerminal();
    expect(terminal.type).toBe('done');

    const deltas = harness.events.filter((event) => event.type === 'delta');
    expect(deltas.map((event) => (event.type === 'delta' ? event.text : ''))).toEqual(['Hel', 'lo']);

    const messages = harness.db.messages.listByConversation(harness.conversation.id);
    expect(messages).toHaveLength(2);
    const assistant = messages[1];
    expect(assistant?.role).toBe('assistant');
    expect(assistant?.content).toBe('Hello');
    expect(assistant?.status).toBe('complete');
    expect(assistant?.usage).toEqual({ totalTokens: 3 });
    expect(assistant?.id).toBe(result.assistantMessageId);
  });

  it('sends the system prompt and the resolved parameters in the provider request', async () => {
    const harness = createHarness({ appParams: { temperature: 0.7, maxOutputTokens: 512 } });
    harness.service.send({ conversationId: harness.conversation.id, content: 'hi' });
    await harness.waitForTerminal();

    const request = harness.captured.requests[0];
    expect(request).toBeDefined();
    expect(request?.modelId).toBe('deepseek-chat');
    expect(request?.turns.at(-1)).toEqual({ role: 'user', content: 'hi' });
    expect(request?.params.temperature).toBe(0.7);
    expect(request?.params.maxOutputTokens).toBe(512);
    expect(request?.stream).toBe(true);
  });

  it('applies agent parameters, then lets a conversation override win', async () => {
    const harness = createHarness({ appParams: { temperature: 0.7 } });
    const agent = harness.db.agents.create({
      name: 'Precise',
      systemPrompt: 'You are terse.',
      params: { temperature: 0.1 },
    });
    harness.db.conversations.update(harness.conversation.id, {
      agentId: agent.id,
      paramsOverride: { temperature: 0.9 },
    });

    harness.service.send({ conversationId: harness.conversation.id, content: 'hi' });
    await harness.waitForTerminal();

    const request = harness.captured.requests[0];
    expect(request?.params.temperature).toBe(0.9);
    expect(request?.system).toBe('You are terse.');
  });

  it('drops weirdness for a model without native support and does not send it', async () => {
    const harness = createHarness({ weirdnessMode: 'off' });
    harness.db.conversations.update(harness.conversation.id, {
      paramsOverride: { weirdness: 0.8 },
    });

    harness.service.send({ conversationId: harness.conversation.id, content: 'hi' });
    await harness.waitForTerminal();

    const request = harness.captured.requests[0];
    expect(request?.params.weirdness).toBeUndefined();
  });

  it('marks the assistant message as stopped when the user stops generation', async () => {
    const harness = createHarness({
      run: (runtime, _request, hooks) =>
        new Promise<ChatRunResult>((_resolve, reject) => {
          hooks.onText?.('partial');
          runtime.signal?.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
        }),
    });

    const { requestId } = harness.service.send({
      conversationId: harness.conversation.id,
      content: 'long answer please',
    });
    await harness.service.stop(requestId);

    const messages = harness.db.messages.listByConversation(harness.conversation.id);
    const assistant = messages.at(-1);
    expect(assistant?.status).toBe('stopped');
    expect(assistant?.content).toBe('partial');
    expect(assistant?.error).toBeNull();
    const terminal = harness.events.at(-1);
    expect(terminal?.type).toBe('done');
    expect(terminal?.type === 'done' ? terminal.finishReason : null).toBe('aborted');
  });

  it('persists a failure as an error and never as a successful reply', async () => {
    const harness = createHarness({
      run: async () => {
        throw new AppError(appError('invalid_key', 'The provider rejected the API key.', { status: 401 }));
      },
    });

    harness.service.send({ conversationId: harness.conversation.id, content: 'hi' });
    const terminal = await harness.waitForTerminal();
    expect(terminal.type).toBe('error');
    expect(terminal.type === 'error' ? terminal.error.code : null).toBe('invalid_key');

    const messages = harness.db.messages.listByConversation(harness.conversation.id);
    const assistant = messages.at(-1);
    expect(assistant?.status).toBe('error');
    expect(assistant?.error?.code).toBe('invalid_key');
    expect(assistant?.content).toBe('');
  });

  it('refuses a second concurrent send in the same conversation', async () => {
    const harness = createHarness({
      run: (runtime, _request, hooks) =>
        new Promise<ChatRunResult>((_resolve, reject) => {
          hooks.onText?.('x');
          runtime.signal?.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
        }),
    });

    const first = harness.service.send({
      conversationId: harness.conversation.id,
      content: 'first',
    });
    expect(() =>
      harness.service.send({ conversationId: harness.conversation.id, content: 'second' }),
    ).toThrowError(/already being generated/i);

    await harness.service.stop(first.requestId);
    const messages = harness.db.messages.listByConversation(harness.conversation.id);
    expect(messages).toHaveLength(2);
  });

  it('fails before writing anything when no API key is stored', () => {
    const harness = createHarness({ withKey: false });
    expect(() =>
      harness.service.send({ conversationId: harness.conversation.id, content: 'hi' }),
    ).toThrowError(/no api key is stored/i);
    expect(harness.db.messages.listByConversation(harness.conversation.id)).toHaveLength(0);
  });

  it('reports a model that is not registered instead of substituting another', () => {
    const harness = createHarness({ modelId: 'definitely-not-a-model' });
    expect(() =>
      harness.service.send({ conversationId: harness.conversation.id, content: 'hi' }),
    ).toThrowError(/not registered/i);
    expect(harness.db.messages.listByConversation(harness.conversation.id)).toHaveLength(0);
  });

  it('titles a new conversation from the first user message', async () => {
    const harness = createHarness();
    harness.service.send({ conversationId: harness.conversation.id, content: 'Explain SQLite WAL mode' });
    await harness.waitForTerminal();
    const conversation = harness.db.conversations.get(harness.conversation.id);
    expect(conversation?.title).toBe('Explain SQLite WAL mode');
  });

  it('trims the replayed history to the configured maximum', async () => {
    const harness = createHarness();
    harness.db.settings.patch({ generation: { maxHistoryMessages: 3 } });
    for (let index = 0; index < 6; index += 1) {
      harness.db.messages.append({
        conversationId: harness.conversation.id,
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `turn ${index}`,
      });
    }

    harness.service.send({ conversationId: harness.conversation.id, content: 'latest' });
    await harness.waitForTerminal();

    const request = harness.captured.requests[0];
    expect(request?.turns.length).toBeLessThanOrEqual(3);
    expect(request?.turns.at(-1)?.content).toBe('latest');
  });
});

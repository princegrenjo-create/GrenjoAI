/**
 * Chat orchestration.
 *
 * One turn is: resolve what to send (precedence), persist the user message,
 * create the assistant placeholder, stream from the provider, persist the final
 * assistant message, and report the outcome.
 *
 * Failure policy, which is the point of this file:
 *  - Every failure is persisted on the assistant message with `status: 'error'`
 *    and a mapped code. The renderer therefore has no way to present a failed
 *    call as a successful reply.
 *  - A cancellation persists `status: 'stopped'` and keeps the partial text.
 *  - Validation failures happen *before* anything is written, so the user keeps
 *    their draft in the composer.
 */
import crypto from 'node:crypto';
import { AppError, appError, toAppError } from '@shared/errors';
import { resolveGenerationParams, trimHistory, type HistoryMessage } from '@shared/params';
import type {
  AppSettings,
  ChatMessage,
  ChatSendInput,
  ChatSendResult,
  ChatStreamEvent,
  GenerationParams,
  ModelDescriptor,
  ProviderConfig,
  TokenUsage,
} from '@shared/types';
import type { Database } from '@shared/repository-contract';
import type {
  ChatCompletionRequest,
  ProviderRegistry,
  ProviderRuntime,
  ProviderTransport,
} from '@shared/provider-contract';
import type { CredentialStore } from '../credentials';
import type { Logger } from '../logger';
import { resolveModel } from '../models/catalog';
import { readProviderKey, resolveRequestEndpoint } from '../models/endpoint-policy';
import {
  ATTACHMENT_LIMITS,
  formatBytes,
  toMessageAttachment,
  type AttachmentPayload,
  type MessageAttachment,
  type PendingAttachmentResolver,
} from '@shared/attachments';
import type { ChatContentPart } from '@shared/provider-contract';

export interface ChatServiceDeps {
  db: Database;
  credentials: CredentialStore;
  registry: ProviderRegistry;
  transport: ProviderTransport;
  settings: () => AppSettings;
  emit: (event: ChatStreamEvent) => void;
  logger: Logger;
  isOnline: () => boolean;
  /** Resolves the opaque ids the renderer sends into bytes and extracted text. */
  attachments: PendingAttachmentResolver;
  /** Overridable for tests. */
  flushIntervalMs?: number;
  retryBackoffMs?: number;
}

export interface ChatService {
  send(input: ChatSendInput): ChatSendResult;
  stop(requestId: string): Promise<void>;
  /** Abort everything; used on app quit. */
  dispose(): void;
  activeCount(): number;
  isConversationBusy(conversationId: string): boolean;
}

interface ActiveRun {
  requestId: string;
  conversationId: string;
  assistantMessageId: string;
  controller: AbortController;
  settled: Promise<void>;
}

const TITLE_MAX = 60;

/**
 * Turns the user's text plus extracted document text into the single text part
 * that is sent to the model.
 *
 * Document text is fenced with an explicit header naming the file, so the model —
 * and a person reading the request — can tell what came from the user and what
 * came from a file. A file whose contents were not extracted is named with the
 * reason instead of being silently dropped: an attachment the model never saw
 * must never look like one it did.
 */
export function composeUserText(base: string, payloads: readonly AttachmentPayload[]): string {
  const parts: string[] = [];
  const trimmed = base.trim();
  if (trimmed.length > 0) parts.push(trimmed);

  for (const payload of payloads) {
    const { meta } = payload;
    if (meta.kind === 'image') {
      // Images travel as their own content part, not as text.
      continue;
    }
    if (payload.text !== null && payload.text.trim().length > 0) {
      parts.push(
        [
          `--- Attached file: ${meta.name} (${meta.mimeType || 'unknown type'}, ${formatBytes(meta.sizeBytes)}) ---`,
          payload.text.trim(),
          `--- End of ${meta.name} ---`,
        ].join('\n'),
      );
      continue;
    }
    parts.push(
      `[Attached file: ${meta.name} (${meta.mimeType || 'unknown type'}, ${formatBytes(
        meta.sizeBytes,
      )}) — contents not included${meta.contentNote ? `: ${meta.contentNote}` : '.'}]`,
    );
  }

  return parts.join('\n\n');
}

/** The image parts for a turn, bounded by the per-message limit. */
function imageParts(payloads: readonly AttachmentPayload[]): ChatContentPart[] {
  return payloads
    .filter((payload) => payload.meta.kind === 'image' && payload.image !== null)
    .slice(0, ATTACHMENT_LIMITS.maxPerMessage)
    .map((payload) => ({
      type: 'image' as const,
      mimeType: payload.image?.mimeType ?? payload.meta.mimeType,
      dataBase64: payload.image?.dataBase64 ?? '',
    }))
    .filter((part) => part.dataBase64.length > 0);
}

function deriveTitle(content: string): string {
  const flat = content.replace(/\s+/g, ' ').trim();
  if (flat.length <= TITLE_MAX) return flat;
  return `${flat.slice(0, TITLE_MAX - 1).trimEnd()}…`;
}

function normaliseFinish(reason: string | null): string {
  return reason ?? 'stop';
}

export function createChatService(deps: ChatServiceDeps): ChatService {
  const { db, credentials, registry, transport, settings, emit, logger, isOnline } = deps;
  const log = logger.child('chat');
  const flushIntervalMs = deps.flushIntervalMs ?? 750;
  const active = new Map<string, ActiveRun>();
  const byConversation = new Map<string, string>();

  function requireConversation(conversationId: string) {
    const conversation = db.conversations.get(conversationId);
    if (!conversation) {
      throw new AppError(
        appError('not_found', 'That conversation no longer exists. Refresh the conversation list.'),
      );
    }
    return conversation;
  }

  function readSettings(): AppSettings {
    return settings();
  }

  function resolveSendContext(input: ChatSendInput) {
    const conversation = requireConversation(input.conversationId);
    const agent = conversation.agentId ? db.agents.get(conversation.agentId) : null;
    const current = readSettings();

    const providerId =
      input.modelRef?.providerId ??
      conversation.providerId ??
      agent?.providerId ??
      current.defaults.providerId;
    const modelId =
      input.modelRef?.modelId ?? conversation.modelId ?? agent?.modelId ?? current.defaults.modelId;

    if (!providerId || !modelId) {
      throw new AppError(
        appError('validation', 'Choose a model before sending a message.'),
      );
    }

    const provider = db.providers.get(providerId);
    if (!provider) {
      throw new AppError(
        appError('model_not_found', 'The provider for the selected model no longer exists.'),
      );
    }
    if (!provider.enabled) {
      throw new AppError(
        appError('bad_request', `${provider.name} is disabled. Enable it in Models & Providers.`),
      );
    }

    const resolved = resolveModel(db, providerId, modelId);
    if (!resolved) {
      throw new AppError(
        appError(
          'model_not_found',
          `"${modelId}" is not registered for ${provider.name}. Discover models or add it under Others / Custom Models. No substitute model is used.`,
        ),
      );
    }

    const apiKey = readProviderKey(credentials, provider.id, provider.baseUrl);
    if (!apiKey) {
      throw new AppError(
        appError(
          'missing_key',
          `No API key is stored for ${provider.name}. Add one in Models & Providers, then send again.`,
        ),
      );
    }

    // Refuse before any write when a model override would move the key to a
    // different origin than the one the owner entered it for.
    const endpoint = resolveRequestEndpoint(provider.baseUrl, resolved.model.baseUrlOverride);

    if (current.advanced.blockRequestsWhenOffline && !isOnline()) {
      throw new AppError(
        appError(
          'offline',
          'This device appears to be offline. The message was not sent because the provider is unreachable.',
        ),
      );
    }

    const conversationLayer: GenerationParams = {
      ...(conversation.paramsOverride ?? {}),
      ...(input.paramsOverride ?? {}),
    };
    const resolvedParams = resolveGenerationParams({
      model: resolved.model,
      weirdness: current.weirdness,
      layers: [
        { source: 'model-default', params: null },
        { source: 'app-default', params: current.defaults.params },
        { source: 'agent', params: agent?.params ?? null },
        { source: 'conversation', params: Object.keys(conversationLayer).length > 0 ? conversationLayer : null },
      ],
    });

    const systemPrompt =
      input.systemPromptOverride ?? conversation.systemPrompt ?? agent?.systemPrompt ?? null;

    // Attachments are resolved before anything is written, so an unknown id
    // fails the send cleanly instead of leaving a half-sent message. The count
    // check matters: a resolver that silently drops an id would otherwise send a
    // message that looks like it had an attachment when it did not.
    const requestedIds = input.attachmentIds ?? [];
    const payloads = requestedIds.length > 0 ? deps.attachments.resolve(requestedIds) : [];
    if (payloads.length !== requestedIds.length) {
      throw new AppError(
        appError(
          'not_found',
          'One of the attachments is no longer available. Remove it and attach the file again.',
        ),
      );
    }
    const images = imageParts(payloads);
    if (images.length > 0 && !resolved.model.capabilities.imageInput) {
      throw new AppError(
        appError(
          'bad_request',
          `${resolved.model.displayName} cannot read images. Choose a model that accepts image input, or remove the image before sending.`,
        ),
      );
    }

    return {
      conversation,
      agent,
      provider,
      model: resolved.model as ModelDescriptor,
      apiKey,
      endpoint,
      settings: current,
      params: resolvedParams,
      systemPrompt,
      payloads,
      images,
      attachments: payloads.map((payload) => toMessageAttachment(payload.meta)),
    };
  }

  function buildHistory(conversationId: string, current: AppSettings): HistoryMessage[] {
    const rows = db.messages.listByConversation(conversationId);
    const usable = rows
      .filter((row) => row.role !== 'system' && row.content.trim().length > 0)
      .filter((row) => row.status !== 'error')
      .slice(-Math.max(1, current.generation.maxHistoryMessages))
      .map<HistoryMessage>((row) => ({
        role: row.role === 'assistant' ? 'assistant' : 'user',
        content: row.content,
      }));
    const trimmed = trimHistory(usable, current.generation.historyTokenBudget);
    if (trimmed.dropped > 0) {
      log.debug('History trimmed to fit the context budget', {
        conversationId,
        dropped: trimmed.dropped,
      });
    }
    return trimmed.kept;
  }

  async function execute(run: ActiveRun, context: ReturnType<typeof resolveSendContext>, turns: HistoryMessage[]) {
    const { conversation, provider, model, apiKey, endpoint, settings: current, params, systemPrompt } = context;
    let text = '';
    let usage: TokenUsage | null = null;
    let finishReason: string | null = null;
    let lastPersisted = '';
    let timer: NodeJS.Timeout | null = null;

    const persistPartial = (): void => {
      if (text === lastPersisted) return;
      lastPersisted = text;
      try {
        db.messages.update(run.assistantMessageId, { content: text });
      } catch (error) {
        log.warn('Could not persist streaming content', {
          messageId: run.assistantMessageId,
          error,
        });
      }
    };

    try {
      if (flushIntervalMs > 0) {
        timer = setInterval(persistPartial, flushIntervalMs);
        timer.unref?.();
      }

      const runtime: ProviderRuntime = {
        providerId: provider.id,
        baseUrl: endpoint,
        apiKey,
        timeoutMs: current.generation.requestTimeoutMs,
        signal: run.controller.signal,
      };
      const adapter = registry.get(provider.kind);
      const request: ChatCompletionRequest = {
        modelId: model.modelId,
        system: systemPrompt && systemPrompt.trim().length > 0 ? systemPrompt : null,
        turns: turns.map((turn, index) => {
          const isLast = index === turns.length - 1;
          const withImages = isLast && turn.role === 'user' && context.images.length > 0;
          if (!withImages) {
            return { role: turn.role === 'assistant' ? 'assistant' : 'user', content: turn.content };
          }
          // Only the turn being sent carries image bytes. Older turns are
          // replayed as the text that was persisted, so a long conversation does
          // not re-upload every image it ever contained.
          const parts: ChatContentPart[] = [{ type: 'text', text: turn.content }, ...context.images];
          return { role: 'user' as const, content: parts };
        }),
        params: params.values,
        stream: current.chat.streaming,
        baseUrlOverride: model.baseUrlOverride,
      };

      const result = await transport.run(
        runtime,
        adapter,
        request,
        {
          onText: (delta) => {
            if (!delta) return;
            text += delta;
            emit({
              type: 'delta',
              requestId: run.requestId,
              assistantMessageId: run.assistantMessageId,
              text: delta,
            });
          },
          onUsage: (reported) => {
            usage = reported;
            emit({
              type: 'usage',
              requestId: run.requestId,
              assistantMessageId: run.assistantMessageId,
              usage: reported,
            });
          },
          onFinish: (reason) => {
            finishReason = reason;
          },
        },
        {
          timeoutMs: current.generation.requestTimeoutMs,
          maxRetries: current.generation.maxRetries,
          retryBackoffMs: current.generation.retryBackoffMs,
          signal: run.controller.signal,
        },
      );

      const finalText = text.length > 0 ? text : result.text;
      usage = usage ?? result.usage;
      finishReason = finishReason ?? result.finishReason;

      if (finalText.trim().length === 0) {
        throw new AppError(
          appError(
            'provider_error',
            'The provider returned an empty response. Nothing was generated, so no reply was saved.',
          ),
        );
      }

      const message = db.messages.update(run.assistantMessageId, {
        content: finalText,
        status: 'complete',
        usage,
      });
      db.conversations.touch(conversation.id);
      const mapped = finishReason === 'length' ? 'length' : finishReason === 'content_filter' ? 'content_filter' : 'stop';
      emit({
        type: 'done',
        requestId: run.requestId,
        assistantMessageId: run.assistantMessageId,
        finishReason: mapped,
        message,
      });
      log.info('Chat turn completed', {
        conversationId: conversation.id,
        providerId: provider.id,
        modelId: model.modelId,
        chars: finalText.length,
        finishReason: normaliseFinish(finishReason),
      });
      // The turn is persisted and delivered, so the pending payloads (and their
      // on-disk mirror) are no longer needed. Released only on success: after a
      // failure the composer keeps its chips and a retry must still resolve them.
      if (context.payloads.length > 0) {
        try {
          deps.attachments.release(context.payloads.map((payload) => payload.meta.id));
        } catch (error) {
          log.warn('Could not release the attachment payloads', { error });
        }
      }
    } catch (error) {
      const aborted = run.controller.signal.aborted;
      const shape = aborted ? appError('cancelled', 'Generation stopped.') : toAppError(error, 'provider_error');
      const status = aborted || shape.code === 'cancelled' ? 'stopped' : 'error';
      let message: ChatMessage;
      try {
        message = db.messages.update(run.assistantMessageId, {
          content: text,
          status,
          error: status === 'error' ? shape : null,
          usage,
        });
      } catch (persistError) {
        log.error('Could not persist the failed assistant message', { error: persistError });
        throw error;
      }

      if (status === 'stopped') {
        emit({
          type: 'done',
          requestId: run.requestId,
          assistantMessageId: run.assistantMessageId,
          finishReason: 'aborted',
          message,
        });
        log.info('Chat turn stopped by the user', { conversationId: conversation.id });
      } else {
        emit({
          type: 'error',
          requestId: run.requestId,
          assistantMessageId: run.assistantMessageId,
          error: shape,
          message,
        });
        log.warn('Chat turn failed', {
          conversationId: conversation.id,
          providerId: provider.id,
          code: shape.code,
          status: shape.status,
        });
      }
    } finally {
      if (timer) clearInterval(timer);
      persistPartial();
      active.delete(run.requestId);
      byConversation.delete(run.conversationId);
    }
  }

  return {
    send(input: ChatSendInput): ChatSendResult {
      const conversationId = input.conversationId;
      if (byConversation.has(conversationId)) {
        throw new AppError(
          appError(
            'bad_request',
            'A reply is already being generated for this conversation. Stop it or wait for it to finish.',
          ),
        );
      }

      const content = input.content.trim();
      if (content.length === 0 && (input.attachmentIds?.length ?? 0) === 0) {
        throw new AppError(appError('validation', 'The message is empty.'));
      }

      // Everything that can fail validation fails before the first write, so a
      // rejected send leaves no orphan user message behind.
      const context = resolveSendContext(input);
      const composedText = composeUserText(content, context.payloads);
      if (composedText.trim().length === 0) {
        throw new AppError(appError('validation', 'The message is empty.'));
      }

      const requestId = crypto.randomUUID();
      const userMessage = db.messages.append({
        conversationId,
        role: 'user',
        content: composedText,
        attachments: context.attachments as MessageAttachment[],
        status: 'complete',
      });

      const history = buildHistory(conversationId, context.settings);

      const assistantMessage = db.messages.append({
        conversationId,
        role: 'assistant',
        content: '',
        status: 'streaming',
        modelRef: { providerId: context.provider.id, modelId: context.model.modelId },
      });

      if (
        context.settings.chat.autoTitleFromFirstMessage &&
        db.messages.countByConversation(conversationId) <= 2
      ) {
        const title = deriveTitle(content.length > 0 ? content : composedText);
        // `autoTitle` only writes when the conversation still carries the default
        // title, so a name the user typed is never clobbered by the first message.
        if (title.length > 0) db.conversations.autoTitle(conversationId, title);
      }
      db.conversations.touch(conversationId);

      const run: ActiveRun = {
        requestId,
        conversationId,
        assistantMessageId: assistantMessage.id,
        controller: new AbortController(),
        settled: Promise.resolve(),
      };
      active.set(requestId, run);
      byConversation.set(conversationId, requestId);

      emit({
        type: 'start',
        requestId,
        conversationId,
        userMessageId: userMessage.id,
        assistantMessageId: assistantMessage.id,
        providerId: context.provider.id,
        modelId: context.model.modelId,
      });

      run.settled = execute(run, context, history).catch((error: unknown) => {
        // `execute` handles its own errors; this is the last-resort guard so an
        // unexpected throw cannot leave a phantom entry in `active`.
        active.delete(requestId);
        byConversation.delete(conversationId);
        log.error('Chat turn crashed outside the error path', { error });
        try {
          const message = db.messages.update(assistantMessage.id, {
            status: 'error',
            error: toAppError(error, 'unknown'),
          });
          emit({
            type: 'error',
            requestId,
            assistantMessageId: assistantMessage.id,
            error: toAppError(error, 'unknown'),
            message,
          });
        } catch {
          /* nothing further can be reported */
        }
      });

      return {
        requestId,
        userMessageId: userMessage.id,
        assistantMessageId: assistantMessage.id,
      };
    },

    async stop(requestId: string) {
      const run = active.get(requestId);
      if (!run) return;
      run.controller.abort();
      await run.settled;
    },

    dispose() {
      for (const run of active.values()) {
        run.controller.abort();
      }
      active.clear();
      byConversation.clear();
    },

    activeCount() {
      return active.size;
    },

    isConversationBusy(conversationId: string) {
      return byConversation.has(conversationId);
    },
  };
}

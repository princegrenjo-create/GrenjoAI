/**
 * Audio transcription.
 *
 * OpenAI is the only provider in this release that documents a transcription
 * endpoint, so this service looks for an enabled OpenAI provider with a bound
 * key. When there is none it refuses with a sentence naming exactly what to
 * configure — it never returns invented text, and it never silently drops the
 * recording.
 *
 * The audio goes to the provider the owner configured, over the same hardened
 * transport as every chat request (redirect refused, timeout, bounded retry,
 * key in a header only).
 */
import type { TranscriptionStatus } from '@shared/api';
import { ATTACHMENT_LIMITS, type TranscriptionResult } from '@shared/attachments';
import { AppError, appError, toAppError } from '@shared/errors';
import type { ProviderRuntime, TranscriptionRequest } from '@shared/provider-contract';
import type { Database } from '@shared/repository-contract';
import type { ProviderRegistry, ProviderTransport } from '@shared/provider-contract';
import type { CredentialStore } from '../credentials';
import { readProviderKey, resolveRequestEndpoint } from '../models/endpoint-policy';
import type { Logger } from '../logger';

/** Audio types the transcription endpoint accepts, mapped to a filename extension. */
const AUDIO_EXTENSIONS: Record<string, string> = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/m4a': 'm4a',
  'audio/flac': 'flac',
};

const NOT_CONFIGURED_REASON =
  'Transcription needs an OpenAI API key. Add OpenAI under Models & Providers, paste your key, then record again — the audio never leaves this machine until you press Transcribe.';

export interface TranscriptionInput {
  dataBase64: string;
  mimeType: string;
  durationMs: number;
}

export interface TranscriptionService {
  status(): TranscriptionStatus;
  transcribe(input: TranscriptionInput): Promise<TranscriptionResult>;
}

export interface TranscriptionDeps {
  db: Database;
  credentials: CredentialStore;
  registry: ProviderRegistry;
  transport: ProviderTransport;
  logger: Logger;
}

interface EligibleProvider {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
}

export function createTranscriptionService(deps: TranscriptionDeps): TranscriptionService {
  const { db, credentials, registry, transport, logger } = deps;
  const log = logger.child('transcription');

  /** Enabled OpenAI-compatible providers that implement transcription. */
  function eligibleProviders(): EligibleProvider[] {
    const found: EligibleProvider[] = [];
    for (const provider of db.providers.list()) {
      if (!provider.enabled) continue;
      const adapter = registry.get(provider.kind);
      if (!adapter.transcription) continue;
      const apiKey = readProviderKey(credentials, provider.id, provider.baseUrl);
      if (!apiKey) continue;
      found.push({ id: provider.id, name: provider.name, baseUrl: provider.baseUrl, apiKey });
    }
    return found;
  }

  return {
    status(): TranscriptionStatus {
      const [first] = eligibleProviders();
      if (!first) {
        return { available: false, providerName: null, reason: NOT_CONFIGURED_REASON };
      }
      return { available: true, providerName: first.name, reason: null };
    },

    async transcribe(input: TranscriptionInput): Promise<TranscriptionResult> {
      const mimeType = input.mimeType.toLowerCase().split(';')[0]?.trim() ?? '';
      const extension = AUDIO_EXTENSIONS[mimeType];
      if (!extension) {
        throw new AppError(
          appError(
            'bad_request',
            `The recording format "${input.mimeType || 'unknown'}" cannot be transcribed. Supported formats are webm, ogg, wav, mp3, m4a and flac.`,
          ),
        );
      }
      if (input.durationMs > ATTACHMENT_LIMITS.maxAudioSeconds * 1000) {
        throw new AppError(
          appError(
            'bad_request',
            `The recording is longer than ${Math.round(ATTACHMENT_LIMITS.maxAudioSeconds / 60)} minutes. Record a shorter clip and try again.`,
          ),
        );
      }

      const audio = Buffer.from(input.dataBase64, 'base64');
      if (audio.length === 0) {
        throw new AppError(appError('bad_request', 'The recording is empty — nothing was captured.'));
      }
      if (audio.length > ATTACHMENT_LIMITS.maxAudioBytes) {
        throw new AppError(
          appError(
            'bad_request',
            `The recording is larger than ${Math.round(ATTACHMENT_LIMITS.maxAudioBytes / (1024 * 1024))} MB and was not uploaded.`,
          ),
        );
      }

      const provider = eligibleProviders()[0];
      if (!provider) {
        throw new AppError(appError('missing_key', NOT_CONFIGURED_REASON));
      }

      const adapter = registry.get('openai');
      const transcription = adapter.transcription;
      if (!transcription) {
        throw new AppError(
          appError('sync_config', 'This build has no transcription adapter configured.'),
        );
      }

      const endpoint = resolveRequestEndpoint(provider.baseUrl, null);
      const runtime: ProviderRuntime = {
        providerId: provider.id,
        baseUrl: endpoint,
        apiKey: provider.apiKey,
        timeoutMs: 120_000,
      };
      const request: TranscriptionRequest = {
        audio: new Uint8Array(audio),
        mimeType,
        filename: `recording.${extension}`,
        model: transcription.defaultModel,
      };

      try {
        const response = await transport.send(
          transcription.buildTranscriptionRequest(runtime, request),
          { timeoutMs: 120_000, maxRetries: 1 },
        );
        const parsed = transcription.parseTranscriptionResponse(
          response.status,
          response.body,
          provider.id,
        );
        if (parsed.error || parsed.text === null) {
          throw new AppError(
            parsed.error ??
              appError('provider_error', 'The transcription service returned no text.'),
          );
        }
        log.info('Transcription completed', {
          providerId: provider.id,
          modelId: transcription.defaultModel,
          audioBytes: audio.length,
          chars: parsed.text.length,
        });
        return {
          text: parsed.text,
          providerId: provider.id,
          modelId: transcription.defaultModel,
          durationMs: input.durationMs > 0 ? input.durationMs : null,
        };
      } catch (error) {
        if (error instanceof AppError) throw error;
        const shape = toAppError(error, 'provider_error');
        log.warn('Transcription failed', {
          providerId: provider.id,
          code: shape.code,
          status: shape.status,
        });
        throw new AppError(shape);
      }
    },
  };
}

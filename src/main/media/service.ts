/**
 * The media service: the only thing that turns "generate an image" into rows,
 * files and a running job.
 *
 * It owns four things the engine deliberately does not know about:
 *  - **eligibility** — which provider and model may run this task, resolved from
 *    declared capabilities rather than from a list someone maintains by hand;
 *  - **storage** — bytes go through the content-addressed store, and the row is
 *    written only after the file is durable;
 *  - **the conversation link** — a generation may be attached to a chat, and the
 *    link is a row update, not a second pipeline;
 *  - **the scheduler** — `start()` drives the engine's tick on an interval, and
 *    `resume()` runs one tick at startup so a job interrupted by a restart is
 *    picked up rather than lost.
 */
import { copyFileSync } from 'node:fs';
import path from 'node:path';
import type { AppSettings } from '@shared/types';
import type { GenerationJob, GenerationMedia, MediaKind, MediaParams } from '@shared/media';
import { MEDIA_LIMITS } from '@shared/media';
import { supportsTask } from '@shared/capabilities';
import type { MediaJobAdapter } from '@shared/media-job';
import type { Database } from '@shared/repository-contract';
import { MediaStore } from './store';
import { listAllModels, resolveModel } from '../models/catalog';
import { JobEngine, mediaInputFor, type TickSummary } from './jobs';

export interface MediaLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/** OS-facing operations, injected so the service is testable without Electron. */
export interface MediaDialogs {
  /** Ask where to save an export; returns null when the user cancels. */
  chooseExportPath(suggestedName: string): Promise<string | null>;
  /** Reveal a file in the OS file manager. */
  revealInFolder(absolutePath: string): void;
}

export interface GenerateInput {
  task: MediaKind;
  prompt: string;
  negativePrompt?: string | null;
  params?: MediaParams;
  /** Explicit choice; when omitted the default settings decide. */
  providerId?: string;
  modelId?: string;
  conversationId?: string | null;
  messageId?: string | null;
  /**
   * Media rows to use as references: image-to-image, or image-to-video.
   *
   * Ids, not bytes, so the IPC payload stays small and the file on disk is the
   * authority at submit time.
   */
  referenceMediaIds?: string[];
  /** Optional inpainting mask, where the model documents one. */
  maskMediaId?: string | null;
}

export interface MediaServiceOptions {
  db: Database;
  store: MediaStore;
  /** Resolve an adapter for a provider, or null when none is registered yet. */
  adapterFor(providerId: string): MediaJobAdapter | null;
  settings(): AppSettings;
  dialogs: MediaDialogs;
  logger: MediaLogger;
  /** Called on every job change, for the renderer's progress channel. */
  onJobChange?(job: GenerationJob): void;
  now?(): Date;
  tickIntervalMs?: number;
}

export interface MediaService {
  list(filter?: { kind?: MediaKind; conversationId?: string }): GenerationMedia[];
  get(id: string): GenerationMedia | null;
  jobs(limit?: number): GenerationJob[];
  generate(input: GenerateInput): Promise<{ jobId: string }>;
  cancel(jobId: string): Promise<boolean>;
  remove(id: string): boolean;
  /** Copy a stored file to a user-chosen path. Returns the path, or null if cancelled. */
  exportTo(id: string): Promise<string | null>;
  reveal(id: string): boolean;
  tick(): Promise<TickSummary>;
  resume(): Promise<TickSummary>;
  start(): void;
  stop(): void;
  dispose(): void;
}

export class MediaServiceError extends Error {
  constructor(
    message: string,
    readonly code: 'validation' | 'not_found' | 'storage' | 'provider_error',
  ) {
    super(message);
    this.name = 'MediaServiceError';
  }
}

export function createMediaService(options: MediaServiceOptions): MediaService {
  const { db, store, logger } = options;
  const engine = new JobEngine({
    jobs: db.generationJobs,
    adapterFor: (providerId) => options.adapterFor(providerId),
    persist: async (job, output) => {
      // Bytes first, row second: a row that points at no file is worse than no row.
      const stored = store.save(output.bytes, output.mime, job.task);
      /*
       * The store dedupes by content and media.relative_path is unique, so the
       * same bytes arriving twice — a crash between saving and recording, or two
       * identical outputs — is one file, not a constraint violation. Reuse the row
       * that already points at it instead of failing a generation whose image is
       * already on disk.
       */
      const existing = db.media.getByRelativePath(stored.relativePath);
      if (existing) {
        logger.info('Generated media already stored; reusing the existing row', {
          mediaId: existing.id,
          jobId: job.id,
        });
        return existing.id;
      }
      const row = db.media.insert(
        mediaInputFor(job, output, stored, {
          conversationId: job.conversationId,
          messageId: job.messageId,
        }),
      );
      logger.info('Generated media stored', {
        mediaId: row.id,
        jobId: job.id,
        bytes: row.bytes,
        mime: row.mime,
      });
      return row.id;
    },
    logger,
    clock: options.now,
    /*
     * References are read at submit time, not stored on the job: the row keeps
     * ids, and the file on disk stays the authority. A reference whose file was
     * deleted is skipped rather than failing the whole job, and the count is
     * capped at the smallest documented limit across providers.
     */
    references: async (job) => {
      const read = (id: string): { bytes: Uint8Array; mime: string } | null => {
        const row = db.media.get(id);
        if (!row) {
          logger.warn('A reference media row is missing; skipping it', { jobId: job.id, mediaId: id });
          return null;
        }
        try {
          return { bytes: new Uint8Array(store.read(row.relativePath)), mime: row.mime };
        } catch (error) {
          logger.warn('A reference file could not be read; skipping it', {
            jobId: job.id,
            mediaId: id,
            message: error instanceof Error ? error.message : String(error),
          });
          return null;
        }
      };

      const references = job.referenceMediaIds
        .slice(0, MEDIA_LIMITS.maxReferenceImages)
        .map(read)
        .filter((entry): entry is { bytes: Uint8Array; mime: string } => entry !== null);
      const mask = job.maskMediaId ? read(job.maskMediaId) : null;
      return { references, mask };
    },
    onChange: (job) => options.onJobChange?.(job),
  });

  let timer: ReturnType<typeof setInterval> | null = null;
  let ticking = false;

  /**
   * One tick, never overlapping. Two concurrent ticks would both see the same
   * queued job and submit it twice — the single most expensive bug this service
   * could have.
   */
  const tickSafely = async (): Promise<TickSummary> => {
    const empty: TickSummary = {
      submitted: 0,
      polled: 0,
      succeeded: 0,
      failed: 0,
      expired: 0,
      throttled: 0,
      skipped: 0,
    };
    if (ticking) return empty;
    ticking = true;
    try {
      return await engine.tick();
    } catch (error) {
      logger.error('The media engine tick failed', {
        message: error instanceof Error ? error.message : String(error),
      });
      return empty;
    } finally {
      ticking = false;
    }
  };

  /**
   * The model a generation will use, or a sentence explaining why none can.
   *
   * Resolution order is explicit choice, then the configured default, then the
   * first eligible model. Every candidate is checked against its declared
   * capabilities, so a chat model can never be handed an image job.
   */
  const resolveTarget = (
    input: GenerateInput,
  ): { providerId: string; modelId: string } => {
    const settings = options.settings();
    const providerId = input.providerId ?? settings.defaults.providerId ?? undefined;
    const modelId = input.modelId ?? settings.defaults.modelId ?? undefined;

    if (providerId && modelId) {
      const providers = db.providers.list();
      const provider = providers.find((entry) => entry.id === providerId);
      if (!provider) {
        throw new MediaServiceError(
          'That provider is not configured any more. Choose another one on the Models & Providers page.',
          'not_found',
        );
      }
      // resolveModel consults a stored row first and the dated hint list second,
      // so a built-in image model works without the user re-declaring it.
      const resolved = resolveModel(db, providerId, modelId);
      const model = resolved?.model ?? null;
      if (!model) {
        throw new MediaServiceError(
          `The model ${modelId} is not registered for this provider. Add it under Others / Custom Models.`,
          'not_found',
        );
      }
      if (!supportsTask(model.capabilities, input.task)) {
        throw new MediaServiceError(
          `${model.displayName} does not declare ${input.task === 'image' ? 'image generation' : 'video generation'}. Pick a model that does, or declare the capability on this one.`,
          'validation',
        );
      }
      return { providerId, modelId };
    }

    // No explicit choice: find the first registered model that can do the job.
    for (const model of listAllModels(db)) {
      if (supportsTask(model.capabilities, input.task)) {
        return { providerId: model.providerId, modelId: model.modelId };
      }
    }

    throw new MediaServiceError(
      input.task === 'image'
        ? 'No model is registered for image generation yet. Add one on the Models & Providers page.'
        : 'No model is registered for video generation yet. Add one on the Models & Providers page.',
      'validation',
    );
  };

  return {
    list(filter) {
      return db.media.list(filter);
    },

    get(id) {
      return db.media.get(id);
    },

    jobs(limit) {
      return db.generationJobs.listRecent(limit);
    },

    async generate(input) {
      const prompt = input.prompt.trim();
      if (prompt.length === 0) {
        throw new MediaServiceError('A prompt is required.', 'validation');
      }
      if (prompt.length > MEDIA_LIMITS.maxPromptChars) {
        throw new MediaServiceError(
          `That prompt is longer than the ${MEDIA_LIMITS.maxPromptChars} characters providers accept.`,
          'validation',
        );
      }

      const target = resolveTarget(input);
      const adapter = options.adapterFor(target.providerId);
      if (!adapter) {
        throw new MediaServiceError(
          'That provider does not have a generation adapter in this build. Add one from a supported provider.',
          'validation',
        );
      }

      const stored = db.media.totalBytes();
      if (stored >= MEDIA_LIMITS.maxTotalBytes) {
        throw new MediaServiceError(
          'The media folder is full for this app’s budget. Delete some generated media before generating more.',
          'storage',
        );
      }

      const referenceMediaIds = validateReferences(input, db);
      const job = engine.enqueue({
        task: input.task,
        providerId: target.providerId,
        modelId: target.modelId,
        prompt,
        params: input.params ?? {},
        referenceMediaIds,
        maskMediaId: input.maskMediaId ?? null,
        conversationId: input.conversationId ?? null,
        messageId: input.messageId ?? null,
      });

      logger.info('Generation queued', {
        jobId: job.id,
        task: input.task,
        providerId: target.providerId,
        modelId: target.modelId,
      });

      // Drive one tick immediately so a fast provider completes without waiting
      // for the interval; the caller does not block on it.
      void tickSafely();

      return { jobId: job.id };
    },

    async cancel(jobId) {
      return engine.cancel(jobId);
    },

    remove(id) {
      const row = db.media.get(id);
      if (!row) return false;
      /*
       * File first, row second — the reverse of what the ordering comment used to
       * claim. A file with no row is unreachable garbage that the next sweep can
       * reclaim; a row with no file is an item the UI keeps offering to open and
       * cannot. If the file delete fails the row is still removed, and the warning
       * above says so.
       */
      try {
        store.remove(row.relativePath);
      } catch (error) {
        logger.warn('Could not delete a media file; the row was removed anyway', {
          mediaId: id,
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return db.media.remove(id);
    },

    async exportTo(id) {
      const row = db.media.get(id);
      if (!row) throw new MediaServiceError('That media item no longer exists.', 'not_found');
      const absolute = store.resolve(row.relativePath);
      const chosen = await options.dialogs.chooseExportPath(path.basename(absolute));
      if (!chosen) return null;
      try {
        copyFileSync(absolute, chosen);
      } catch (error) {
        throw new MediaServiceError(
          `The file could not be saved: ${error instanceof Error ? error.message : 'unknown error'}`,
          'storage',
        );
      }
      return chosen;
    },

    reveal(id) {
      const row = db.media.get(id);
      if (!row) return false;
      try {
        options.dialogs.revealInFolder(store.resolve(row.relativePath));
        return true;
      } catch (error) {
        logger.warn('Could not reveal a media file', {
          mediaId: id,
          message: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
    },

    tick: tickSafely,

    async resume() {
      const active = db.generationJobs.listActive();
      if (active.length === 0) {
        return await tickSafely();
      }
      logger.info('Resuming generation jobs after a restart', { count: active.length });
      return await tickSafely();
    },

    start() {
      if (timer) return;
      timer = setInterval(() => {
        void tickSafely();
      }, options.tickIntervalMs ?? 2_000);
      // Do not hold the process open just to poll a provider.
      timer.unref?.();
    },

    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },

    dispose() {
      this.stop();
    },
  };
}

/**
 * Checks the reference ids a caller supplied, and returns the ones that will be
 * used.
 *
 * A reference must exist, be an image, and fit the documented count. The mask is
 * optional but only meaningful alongside a reference — a mask with nothing to mask
 * is silently ignored by every provider, so it is refused here rather than sent.
 */
function validateReferences(
  input: GenerateInput,
  db: Database,
): string[] {
  const ids = input.referenceMediaIds ?? [];
  if (ids.length === 0) {
    if (input.maskMediaId) {
      throw new MediaServiceError(
        'A mask needs at least one reference image to apply to.',
        'validation',
      );
    }
    return [];
  }
  if (ids.length > MEDIA_LIMITS.maxReferenceImages) {
    throw new MediaServiceError(
      `At most ${MEDIA_LIMITS.maxReferenceImages} reference images can be used at once.`,
      'validation',
    );
  }

  for (const id of [...ids, ...(input.maskMediaId ? [input.maskMediaId] : [])]) {
    const row = db.media.get(id);
    if (!row) {
      throw new MediaServiceError(
        'A reference image you selected no longer exists. Pick another one.',
        'not_found',
      );
    }
    if (row.kind !== 'image') {
      throw new MediaServiceError(
        'Only images can be used as references. A video cannot be one.',
        'validation',
      );
    }
  }
  return [...ids];
}
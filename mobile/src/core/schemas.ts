/**
 * Zod schemas for every value that crosses the IPC boundary.
 *
 * The renderer is not trusted: it is a web page, and a compromised or buggy
 * renderer must not be able to write an arbitrary row, inject an arbitrary URL
 * or bypass a range check. Every handler validates its input here before any
 * repository or network call happens.
 */
import { z } from 'zod';
import { GEN_PARAM_KEYS, PROVIDER_KINDS } from './types';
import type { GenerationParams } from './types';
import { ATTACHMENT_LIMITS } from './attachments';
import { MAX_API_KEY_LENGTH, MAX_MESSAGE_CHARS } from './defaults';

const idString = z.string().trim().min(1).max(128);

const optionalString = (max: number) => z.string().max(max).nullish();

/**
 * Wire format: every numeric control may arrive as `null` to mean "clear this
 * override". `GenerationParams` deliberately uses `undefined` for the same
 * meaning, so the schema compacts nulls away instead of widening the domain type
 * with a second spelling of "unset".
 */
const rawParamsSchema = z
  .object({
    temperature: z.number().min(0).max(2).nullish(),
    topP: z.number().min(0).max(1).nullish(),
    topK: z.number().int().min(1).max(500).nullish(),
    frequencyPenalty: z.number().min(-2).max(2).nullish(),
    presencePenalty: z.number().min(-2).max(2).nullish(),
    maxOutputTokens: z.number().int().min(1).max(200000).nullish(),
    stop: z.array(z.string().max(200)).max(4).nullish(),
    seed: z.number().int().min(0).max(2147483647).nullish(),
    weirdness: z.number().min(0).max(1).nullish(),
    reasoningEffort: z.enum(['low', 'medium', 'high']).nullish(),
  })
  .strict();

type RawParams = z.infer<typeof rawParamsSchema>;

function compactParams(raw: RawParams): GenerationParams {
  const out: GenerationParams = {};
  if (typeof raw.temperature === 'number') out.temperature = raw.temperature;
  if (typeof raw.topP === 'number') out.topP = raw.topP;
  if (typeof raw.topK === 'number') out.topK = raw.topK;
  if (typeof raw.frequencyPenalty === 'number') out.frequencyPenalty = raw.frequencyPenalty;
  if (typeof raw.presencePenalty === 'number') out.presencePenalty = raw.presencePenalty;
  if (typeof raw.maxOutputTokens === 'number') out.maxOutputTokens = raw.maxOutputTokens;
  if (Array.isArray(raw.stop) && raw.stop.length > 0) out.stop = raw.stop;
  if (typeof raw.seed === 'number') out.seed = raw.seed;
  if (typeof raw.weirdness === 'number') out.weirdness = raw.weirdness;
  if (raw.reasoningEffort === 'low' || raw.reasoningEffort === 'medium' || raw.reasoningEffort === 'high') {
    out.reasoningEffort = raw.reasoningEffort;
  }
  return out;
}

export const generationParamsSchema = rawParamsSchema.transform(compactParams);

export const paramKeySchema = z.enum(GEN_PARAM_KEYS);

export const capabilitiesSchema = z
  .object({
    chat: z.boolean(),
    streaming: z.boolean(),
    imageInput: z.boolean(),
    toolCalling: z.boolean(),
  })
  .strict();

export const limitsSchema = z
  .object({
    contextWindow: z.number().int().min(1).max(50_000_000).optional(),
    maxOutputTokens: z.number().int().min(1).max(50_000_000).optional(),
  })
  .strict();

export const providerKindSchema = z.enum(PROVIDER_KINDS);

export const providerInputSchema = z
  .object({
    id: idString.optional(),
    kind: providerKindSchema,
    name: z.string().trim().min(1).max(80),
    baseUrl: z.string().trim().min(1).max(2048),
    enabled: z.boolean().optional(),
  })
  .strict();

export const setKeyInputSchema = z
  .object({
    providerId: idString,
    apiKey: z.string().min(1).max(MAX_API_KEY_LENGTH),
  })
  .strict();

export const customModelInputSchema = z
  .object({
    id: idString.optional(),
    providerId: idString,
    displayName: z.string().trim().min(1).max(120),
    modelId: z.string().trim().min(1).max(200),
    baseUrlOverride: z.string().trim().max(2048).nullish(),
    description: z.string().max(2000).optional(),
    capabilities: capabilitiesSchema,
    limits: limitsSchema.optional(),
    supportedParams: z.array(paramKeySchema).max(GEN_PARAM_KEYS.length).optional(),
    weirdnessSupported: z.boolean().optional(),
  })
  .strict();

export const modelRefSchema = z
  .object({
    providerId: idString,
    modelId: z.string().trim().min(1).max(200),
  })
  .strict();

export const conversationCreateSchema = z
  .object({
    title: z.string().trim().max(200).optional(),
    agentId: idString.nullish(),
    providerId: idString.nullish(),
    modelId: z.string().trim().max(200).nullish(),
    systemPrompt: optionalString(32000),
  })
  .strict();

export const conversationPatchSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    agentId: idString.nullish(),
    providerId: idString.nullish(),
    modelId: z.string().trim().max(200).nullish(),
    systemPrompt: optionalString(32000),
    paramsOverride: generationParamsSchema.nullish(),
  })
  .strict();

export const conversationListSchema = z
  .object({
    search: z.string().max(200).optional(),
    limit: z.number().int().min(1).max(500).optional(),
  })
  .strict();

export const chatSendSchema = z
  .object({
    conversationId: idString,
    content: z.string().max(MAX_MESSAGE_CHARS),
    attachmentIds: z.array(idString).max(ATTACHMENT_LIMITS.maxPerMessage).optional(),
    modelRef: modelRefSchema.optional(),
    paramsOverride: generationParamsSchema.optional(),
    systemPromptOverride: z.string().max(32000).optional(),
  })
  .strict()
  .refine(
    (value) => value.content.trim().length > 0 || (value.attachmentIds?.length ?? 0) > 0,
    { message: 'A message needs text or at least one attachment.', path: ['content'] },
  );

export const attachmentIngestSchema = z
  .object({
    name: z.string().trim().min(1).max(255),
    mimeType: z.string().trim().max(200),
    dataBase64: z.string().min(1),
    kindHint: z.enum(['image', 'file']).optional(),
  })
  .strict();

export const transcriptionInputSchema = z
  .object({
    dataBase64: z.string().min(1),
    mimeType: z.string().trim().min(1).max(120),
    durationMs: z.number().int().min(0).max(ATTACHMENT_LIMITS.maxAudioSeconds * 1000),
  })
  .strict();

export const agentInputSchema = z
  .object({
    id: idString.optional(),
    name: z.string().trim().min(1).max(80),
    description: z.string().max(2000).optional(),
    providerId: idString.nullish(),
    modelId: z.string().trim().max(200).nullish(),
    systemPrompt: z.string().max(32000),
    params: generationParamsSchema.optional(),
  })
  .strict();

export const generalPatchSchema = z
  .object({
    theme: z.enum(['dark', 'light', 'system']).optional(),
    sendOnEnter: z.boolean().optional(),
    reduceMotion: z.boolean().optional(),
  })
  .strict();

export const chatPatchSchema = z
  .object({
    streaming: z.boolean().optional(),
    showTokenUsage: z.boolean().optional(),
    autoTitleFromFirstMessage: z.boolean().optional(),
    defaultAgentId: idString.nullish(),
  })
  .strict();

export const defaultsPatchSchema = z
  .object({
    providerId: idString.nullish(),
    modelId: z.string().trim().max(200).nullish(),
    params: generationParamsSchema.optional(),
  })
  .strict();

export const generationPatchSchema = z
  .object({
    requestTimeoutMs: z.number().int().min(1000).max(600000).optional(),
    maxRetries: z.number().int().min(0).max(5).optional(),
    retryBackoffMs: z.number().int().min(0).max(60000).optional(),
    maxHistoryMessages: z.number().int().min(1).max(500).optional(),
    historyTokenBudget: z.number().int().min(1000).max(2000000).optional(),
    includeReasoning: z.boolean().optional(),
  })
  .strict();

export const weirdnessPatchSchema = z
  .object({
    mode: z.enum(['off', 'creativityBias']).optional(),
    bias: z.number().min(0).max(1).optional(),
  })
  .strict();

export const advancedPatchSchema = z
  .object({
    logLevel: z.enum(['error', 'warn', 'info', 'debug']).optional(),
    requireHttpsForCustomEndpoints: z.boolean().optional(),
    allowInsecureLocalhost: z.boolean().optional(),
    blockRequestsWhenOffline: z.boolean().optional(),
    streamIdleTimeoutMs: z.number().int().min(5000).max(600000).optional(),
  })
  .strict();

export const syncSettingsPatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    supabaseUrl: z.string().trim().max(2048).optional(),
    autoSync: z.boolean().optional(),
    syncIntervalMs: z.number().int().min(15000).max(3600000).optional(),
  })
  .strict();

export const settingsPatchSchema = z
  .object({
    general: generalPatchSchema.optional(),
    chat: chatPatchSchema.optional(),
    defaults: defaultsPatchSchema.optional(),
    generation: generationPatchSchema.optional(),
    weirdness: weirdnessPatchSchema.optional(),
    advanced: advancedPatchSchema.optional(),
    sync: syncSettingsPatchSchema.optional(),
  })
  .strict();

export const syncConfigSchema = z
  .object({
    supabaseUrl: z.string().trim().min(1).max(2048),
    anonKey: z.string().min(1).max(8192),
  })
  .strict();

export const syncAuthSchema = z
  .object({
    email: z.string().trim().email().max(320),
    password: z.string().min(8).max(200),
  })
  .strict();

export const syncResolveSchema = z
  .object({
    id: z.number().int().min(1),
    resolution: z.enum(['kept_local', 'kept_remote']),
  })
  .strict();

export const discoveredModelsSchema = z
  .object({
    providerId: idString,
    models: z
      .array(
        z
          .object({
            modelId: z.string().trim().min(1).max(200),
            displayName: z.string().trim().min(1).max(200),
            description: z.string().max(2000),
            capabilities: capabilitiesSchema,
            limits: limitsSchema,
            supportedParams: z.array(paramKeySchema),
            weirdnessSupported: z.boolean(),
          })
          .strict(),
      )
      .max(2000),
  })
  .strict();

export const modelTestSchema = z
  .object({
    ref: modelRefSchema,
    prompt: z.string().max(2000).optional(),
  })
  .strict();

export const configImportSchema = z
  .object({
    json: z.string().min(2).max(5_000_000),
  })
  .strict();

/** Channel -> payload schema, used by the generic validated IPC registrar. */
export const IPC_SCHEMAS = {
  conversationList: conversationListSchema.nullish(),
  conversationCreate: conversationCreateSchema,
  conversationPatch: conversationPatchSchema,
  chatSend: chatSendSchema,
  providerInput: providerInputSchema,
  setKey: setKeyInputSchema,
  customModel: customModelInputSchema,
  agentInput: agentInputSchema,
  settingsPatch: settingsPatchSchema,
  syncConfig: syncConfigSchema,
  syncAuth: syncAuthSchema,
  syncResolve: syncResolveSchema,
  discoveredModels: discoveredModelsSchema,
  modelTest: modelTestSchema,
  configImport: configImportSchema,
} as const;

export type Validators = typeof IPC_SCHEMAS;

/** Format a zod failure into one short, user-safe sentence. */
export function formatZodError(error: z.ZodError): string {
  const first = error.issues[0];
  if (!first) return 'The input is not valid.';
  const path = first.path.length > 0 ? `${first.path.join('.')}: ` : '';
  return `${path}${first.message}`;
}

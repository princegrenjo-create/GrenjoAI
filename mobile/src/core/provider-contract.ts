/**
 * Provider adapter contract.
 *
 * Every provider gets its own adapter behind this interface. Adapters are pure
 * with respect to the network: they *build* an immutable request spec and
 * *parse* bytes. The shared executor performs the fetch. That split is what
 * makes request formatting, SSE parsing and error mapping testable without a
 * live key.
 *
 * Nothing here may assume two providers share a wire format — DeepSeek and
 * OpenAI happen to, Gemini and Anthropic do not.
 */
import type {
  AppErrorShape,
  ConnectionTestResult,
  GenParamKey,
  GenerationParams,
  ModelCapabilities,
  ModelLimits,
  ProviderKind,
  TokenUsage,
} from './types';

export interface HttpRequestSpec {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body: string | null;
  /**
   * Raw bytes for non-JSON bodies (multipart audio). When set, `body` is null
   * and the transport sends these bytes with the headers given above.
   */
  bodyBytes?: Uint8Array | null;
}

export interface HttpResponseHeaders {
  get(name: string): string | null;
}

export interface HttpResponseLike {
  ok: boolean;
  status: number;
  headers: HttpResponseHeaders;
  text(): Promise<string>;
  body: ReadableStream<Uint8Array> | null;
}

export interface FetchInitLike {
  method: string;
  headers: Record<string, string>;
  /** UTF-8 request bodies and raw byte bodies (multipart audio) both go here. */
  body?: string | Uint8Array;
  signal?: AbortSignal;
  /**
   * Always `'error'`: a provider endpoint that redirects is refused rather than
   * followed, so a compromised third party cannot bounce the request (and its
   * Authorization header) to another host.
   */
  redirect?: 'error';
}

export type FetchLike = (url: string, init: FetchInitLike) => Promise<HttpResponseLike>;

/** Everything an adapter needs to sign a request. Never logged, never returned. */
export interface ProviderRuntime {
  providerId: string;
  baseUrl: string;
  /** Empty string means "no credential configured" — adapters must not guess. */
  apiKey: string;
  timeoutMs: number;
  /**
   * Optional transport override, used only by tests that inject a fake. The
   * production path resolves its own fetch inside `ProviderTransport`, which is
   * the single place that performs I/O.
   */
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
}

/**
 * One piece of a user turn. Text-only conversations keep sending a plain string,
 * so every existing adapter path and stored message is unchanged; a turn becomes
 * an array only when an image is attached.
 */
export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; dataBase64: string };

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string | ChatContentPart[];
}

/** True when any turn carries non-text content. */
export function turnHasImages(turn: ChatTurn): boolean {
  return Array.isArray(turn.content) && turn.content.some((part) => part.type === 'image');
}

export interface ChatCompletionRequest {
  modelId: string;
  /** Provider-native system instruction (top-level for Anthropic/Gemini). */
  system: string | null;
  turns: ChatTurn[];
  params: GenerationParams;
  stream: boolean;
  /** Only set for custom models that override the endpoint. */
  baseUrlOverride?: string | null;
}

export type ChatStreamChunk =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'finish'; reason: string };

/**
 * Incremental parser. `push` is called with decoded body text as it arrives —
 * adapters must buffer partial frames themselves. `end` is called once when the
 * body closes and may emit trailing usage/finish chunks.
 */
export interface ResponseParser {
  push(chunk: string): ChatStreamChunk[];
  end(): ChatStreamChunk[];
}

export interface DiscoveredModel {  modelId: string;
  displayName: string;
  description: string;
  capabilities: ModelCapabilities;
  limits: ModelLimits;
  supportedParams: GenParamKey[];
  weirdnessSupported: boolean;
}

/* ------------------------------------------------------- transcription ----- */

export interface TranscriptionRequest {
  /** Recorded audio bytes. */
  audio: Uint8Array;
  /** MIME type of the recording, e.g. `audio/webm`. */
  mimeType: string;
  /** Filename used in the multipart part; providers use the extension. */
  filename: string;
  model: string;
}

export interface TranscriptionParseResult {
  text: string | null;
  error: AppErrorShape | null;
}

/**
 * Optional capability: a provider that can turn recorded audio into text.
 *
 * Only OpenAI documents a transcription endpoint in this release, so only that
 * adapter implements this. A missing `transcription` is a fact the UI reports
 * ("configure an OpenAI key for transcription"), never a silent no-op.
 */
export interface TranscriptionAdapter {
  /** Model id sent to the endpoint. */
  readonly defaultModel: string;
  buildTranscriptionRequest(runtime: ProviderRuntime, request: TranscriptionRequest): HttpRequestSpec;
  parseTranscriptionResponse(status: number, body: string, providerId: string): TranscriptionParseResult;
}

export interface ProviderAdapter {
  readonly kind: ProviderKind;
  readonly label: string;
  /** Parameters this provider family can carry. */
  readonly supportedParams: readonly GenParamKey[];
  readonly supportsModelDiscovery: boolean;
  /** Present only when the provider can transcribe recorded audio. */
  readonly transcription?: TranscriptionAdapter;

  /** Cheap authenticated probe, e.g. GET /models with a one-model limit. */
  buildTestRequest(runtime: ProviderRuntime): HttpRequestSpec;
  /** Model enumeration request, or null when the provider has no such API. */
  buildListModelsRequest(runtime: ProviderRuntime): HttpRequestSpec | null;
  /** Parse a discovery response into normalised model descriptors. */
  parseListModels(status: number, body: string): {
    models: DiscoveredModel[];
    error: AppErrorShape | null;
  };
  /** Evaluate a connection-test response without a second round trip. */
  parseTestResponse(status: number, body: string): ConnectionTestResult;

  /** Build the chat request for either streaming or non-streaming mode. */
  buildChatRequest(runtime: ProviderRuntime, request: ChatCompletionRequest): HttpRequestSpec;

  /** Parser for the corresponding chat response body. */
  createResponseParser(stream: boolean): ResponseParser;

  /** Map a non-2xx response to the shared error vocabulary. */
  parseError(status: number, body: string, providerId: string): AppErrorShape;
}

export interface ProviderRegistry {
  get(kind: ProviderKind): ProviderAdapter;
  all(): ProviderAdapter[];
}

/** Result of one buffered (non-streaming) provider call. */
export interface BufferedCompletion {
  text: string;
  usage: TokenUsage | null;
  finishReason: string | null;
}

/* ------------------------------------------------------------- transport --- */

/**
 * A raw HTTP outcome. Network-level failures throw; an HTTP error status is
 * returned normally so the caller can map it through `adapter.parseError` and
 * keep the adapter's provider-specific message.
 */
export interface TransportResponse {
  status: number;
  body: string;
  headers: Record<string, string>;
}

export interface TransportOptions {
  timeoutMs?: number;
  /** Never retried once any byte has been delivered. */
  maxRetries?: number;
  retryBackoffMs?: number;
  signal?: AbortSignal;
}

export interface ChatRunHooks {
  onText?(text: string): void;
  onReasoning?(text: string): void;
  onUsage?(usage: TokenUsage): void;
  onFinish?(reason: string): void;
}

export interface ChatRunResult {
  text: string;
  usage: TokenUsage | null;
  finishReason: string | null;
}

/**
 * The single place the application performs provider I/O.
 *
 * `transport.send` performs one request and returns the body regardless of HTTP
 * status (throwing only on transport failure, abort, or a refused redirect).
 * `transport.run` drives a chat completion end to end: build -> send -> feed the
 * adapter's parser -> invoke hooks -> return the assembled result.
 */
export interface ProviderTransport {
  send(spec: HttpRequestSpec, options?: TransportOptions): Promise<TransportResponse>;
  run(
    runtime: ProviderRuntime,
    adapter: ProviderAdapter,
    request: ChatCompletionRequest,
    hooks: ChatRunHooks,
    options?: TransportOptions,
  ): Promise<ChatRunResult>;
}

/** Implemented in `src/main/providers/transport.ts`. */
export type CreateTransport = () => ProviderTransport;

/**
 * Public surface of the provider layer for `src/main` consumers.
 *
 * Import from `@main/providers` (or the specific module) — never construct a
 * request by hand and never call `fetch` directly: `createProviderTransport()`
 * is the only place provider I/O happens.
 */
export { createProviderTransport, createProviderTransportWith } from './transport';
export { createRegistry } from './registry';
export { createFetch } from './http';
export type { CreateFetchOptions } from './http';
export { inferCapabilities, findModelHint, capabilityNote } from './capabilities';
export type { CapabilityProfile, CapabilitySource } from './capabilities';
export { SseFramer, DONE_SENTINEL, isDoneFrame } from './sse';
export type { SseFrame } from './sse';
export { createDeepSeekAdapter } from './deepseek';
export { createOpenAiAdapter } from './openai';
export { createGeminiAdapter } from './gemini';
export { createAnthropicAdapter } from './anthropic';
export { createOpenAiCompatibleAdapter } from './openaiCompatible';
export { ANTHROPIC_API_VERSION } from './anthropic';

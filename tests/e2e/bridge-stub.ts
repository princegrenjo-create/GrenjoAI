/**
 * The bridge double for the browser run.
 *
 * A plain, serialisable object installed before the bundle runs. It answers the
 * calls the shell makes at boot (settings, conversations, the chat event
 * subscription) and the calls the Image Studio makes, with just enough data for
 * the page to render its real states.
 *
 * Nothing here asserts behaviour — that is the jsdom suite's job. This exists so
 * the real page can be laid out and scanned.
 */
import type { Page } from '@playwright/test';

export interface BridgeStubOptions {
  imageModels?: number;
  imageItems?: number;
  /** Adds a video model and serves video items, for the Video Studio spec. */
  video?: boolean;
}

export async function installBridgeStub(page: Page, options: BridgeStubOptions = {}): Promise<void> {
  const imageModels = options.imageModels ?? 1;
  const imageItems = options.imageItems ?? 0;
  const video = options.video === true;

  await page.addInitScript(
    ({ models: imageModelCount, items: imageItemCount, video: withVideo }) => {
      const imageCapabilities = {
        chat: false,
        streaming: false,
        imageInput: true,
        imageOutput: true,
        imageEditing: true,
        videoInput: false,
        videoOutput: false,
        audioInput: false,
        audioOutput: false,
        embeddings: false,
        toolCalling: false,
      };
      const chatCapabilities = {
        chat: true,
        streaming: true,
        imageInput: false,
        imageOutput: false,
        imageEditing: false,
        videoInput: false,
        videoOutput: false,
        audioInput: false,
        audioOutput: false,
        embeddings: false,
        toolCalling: false,
      };

      const descriptor = (id, modelId, displayName, capabilities) => ({
        id: `m-${modelId}`,
        providerId: 'p-openai',
        modelId,
        displayName,
        source: 'custom',
        capabilities,
        limits: {},
        description: '',
        supportedParams: [],
        weirdnessSupported: false,
        baseUrlOverride: null,
        createdAt: '2026-11-03T00:00:00.000Z',
        updatedAt: '2026-11-03T00:00:00.000Z',
      });

      const providers = [
        {
          id: 'p-openai',
          kind: withVideo ? 'gemini' : 'openai',
          name: 'OpenAI',
          baseUrl: 'https://api.openai.com/v1',
          enabled: true,
          hasKey: true,
          keyFingerprint: 'abcd1234',
          keyUpdatedAt: '2026-11-03T00:00:00.000Z',
          supportsModelDiscovery: true,
          supportedParams: [],
          transcription: false,
          createdAt: '2026-11-03T00:00:00.000Z',
          updatedAt: '2026-11-03T00:00:00.000Z',
        },
      ];

      const modelList = [
        ...Array.from({ length: imageModelCount }, (_, index) =>
          descriptor(index, index === 0 ? 'gpt-image-2' : `gpt-image-2-${index}`, index === 0 ? 'GPT Image 2' : `GPT Image 2 (${index})`, imageCapabilities),
        ),
        ...(withVideo
          ? [descriptor(50, 'gemini-omni-1.1-flash', 'Gemini Omni Flash', { ...imageCapabilities, imageOutput: false, videoOutput: true, imageEditing: false })]
          : []),
        descriptor(99, 'chat-model', 'Chat model', chatCapabilities),
      ];

      const mediaItems = Array.from({ length: imageItemCount }, (_, index) => ({
        id: `media-${index}`,
        kind: withVideo ? 'video' : 'image',
        providerId: 'p-openai',
        modelId: 'gpt-image-2',
        prompt: `A heron at dawn, study ${index + 1}`,
        negativePrompt: null,
        params: {},
        width: 1024,
        height: 1024,
        durationMs: null,
        bytes: 2048 + index,
        sha256: 'a'.repeat(64),
        mime: 'image/png',
        relativePath: `${'a'.repeat(2)}/${'a'.repeat(64)}.png`,
        conversationId: null,
        messageId: null,
        jobId: null,
        providerJobId: null,
        createdAt: '2026-11-03T00:00:00.000Z',
      }));

      const settings = {
        general: { theme: 'dark', reduceMotion: false, sendOnEnter: true, density: 'comfortable' },
        defaults: { providerId: 'p-openai', modelId: 'gpt-image-2' },
        generation: {},
        advanced: {},
      };

      const api = {
        conversations: {
          list: async () => [],
          get: async () => ({ conversation: null, messages: [] }),
          create: async () => ({ id: 'c-1' }),
          update: async () => ({ id: 'c-1' }),
          remove: async () => undefined,
        },
        messages: { list: async () => [] },
        attachments: {
          pick: async () => ({ attachments: [], rejected: [], cancelled: true }),
          ingestBytes: async () => ({ attachments: [], rejected: [], cancelled: false }),
          get: async () => null,
          remove: async () => undefined,
          readImage: async () => ({ dataUrl: '' }),
          transcribe: async () => ({ text: null, error: null }),
          transcriptionStatus: async () => ({ available: false, reason: 'no key' }),
        },
        chat: {
          send: async () => ({ requestId: 'r' }),
          stop: async () => undefined,
          onEvent: () => () => undefined,
        },
        providers: { list: async () => providers },
        models: { list: async () => modelList },
        agents: { list: async () => [] },
        settings: {
          get: async () => settings,
          patch: async () => settings,
          reset: async () => settings,
          exportConfig: async () => ({ app: 'x', exportedAt: '', credentials: 'excluded' }),
          importConfig: async () => ({ applied: [] }),
        },
        sync: { status: async () => ({ configured: false }), onStatus: () => () => undefined },
        media: {
          list: async () => mediaItems,
          get: async () => null,
          jobs: async () => [],
          generate: async () => ({ jobId: 'job-1' }),
          cancel: async () => true,
          remove: async () => true,
          export: async () => null,
          reveal: async () => true,
          onEvent: () => () => undefined,
        },
        app: {
          info: async () => ({
            version: '0.1.0',
            electronVersion: '44.10.0',
            chromeVersion: '152',
            nodeVersion: '24.22.1',
            packaged: false,
            platform: 'win32',
          }),
          paths: async () => ({
            userData: 'C:/Users/owner/AppData/Roaming/Grenjo AI Tool',
            database: 'C:/Users/owner/AppData/Roaming/Grenjo AI Tool/data/app.db',
            logs: 'C:/Users/owner/AppData/Roaming/Grenjo AI Tool/logs/main.log',
            credentials: 'C:/Users/owner/AppData/Roaming/Grenjo AI Tool/credentials.bin',
          }),
          openExternal: async () => undefined,
          quit: async () => undefined,
        },
      };

      window.api = api;
    },
    { models: imageModels, items: imageItems, video },
  );
}

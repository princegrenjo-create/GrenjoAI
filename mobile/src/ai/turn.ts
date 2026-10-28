/**
 * Turn assembly: document text into the message, and parameters by precedence.
 *
 * Mirrors the desktop `composeUserText` / `resolveGenerationParams` behaviour using
 * the same shared core, so a mobile turn carries the same contract as a desktop
 * turn: precedence is app defaults → agent → conversation, and a parameter the
 * model does not document is dropped rather than sent.
 */
import { formatBytes } from '@core/attachments';
import { resolveGenerationParams } from '@core/params';
import type { GenerationParams, ModelDescriptor, WeirdnessSettings } from '@core/types';
import type { IngestedAttachment } from '@/attachments/ingest';

/** Appends extracted document text, fenced and named, to the user's message. */
export function composeHistory(base: string, attachments: ReadonlyArray<IngestedAttachment>): string {
  const parts: string[] = [];
  if (base.trim().length > 0) parts.push(base.trim());

  for (const item of attachments) {
    if (item.meta.kind === 'image') continue; // images travel as their own part
    if (item.text !== null && item.text.trim().length > 0) {
      parts.push(
        [
          `--- Attached file: ${item.meta.name} (${item.meta.mimeType}, ${formatBytes(item.meta.sizeBytes)}) ---`,
          item.text.trim(),
          `--- End of ${item.meta.name} ---`,
        ].join('\n'),
      );
      continue;
    }
    parts.push(
      `[Attached file: ${item.meta.name} (${item.meta.mimeType}, ${formatBytes(item.meta.sizeBytes)}) — contents not included${item.meta.contentNote ? `: ${item.meta.contentNote}` : '.'}]`,
    );
  }
  return parts.join('\n\n');
}

export function resolveParamsForTurn(input: {
  model: ModelDescriptor;
  appDefaults: GenerationParams;
  agentParams: GenerationParams | null;
  conversationParams: GenerationParams | null;
  weirdness: WeirdnessSettings;
}): GenerationParams {
  const resolved = resolveGenerationParams({
    model: input.model,
    weirdness: input.weirdness,
    layers: [
      { source: 'model-default', params: null },
      { source: 'app-default', params: input.appDefaults },
      { source: 'agent', params: input.agentParams },
      { source: 'conversation', params: input.conversationParams },
    ],
  });
  return resolved.values;
}

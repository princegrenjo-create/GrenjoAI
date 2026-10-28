/**
 * Display helpers for the models screen: how a source, a capability and a limit
 * are labelled. One implementation so a badge cannot mean two things on the
 * provider list and on the model list.
 */
import type { BadgeTone } from '@renderer/components/ui';
import { PARAM_SPECS } from '@shared/defaults';
import type {
  GenParamKey,
  ModelCapabilities,
  ModelLimits,
  ModelSource,
} from '@shared/types';

export const SOURCE_LABEL: Record<ModelSource, string> = {
  catalog: 'Built-in hint',
  discovered: 'Discovered',
  custom: 'Custom',
};

export const SOURCE_TONE: Record<ModelSource, BadgeTone> = {
  catalog: 'neutral',
  discovered: 'info',
  custom: 'accent',
};

export interface CapabilityEntry {
  key: keyof ModelCapabilities;
  label: string;
}

export const CAPABILITIES: CapabilityEntry[] = [
  { key: 'chat', label: 'Chat' },
  { key: 'streaming', label: 'Streaming' },
  { key: 'imageInput', label: 'Image input' },
  { key: 'toolCalling', label: 'Tools' },
];

export function tokenCount(value: number | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString() : '—';
}

/** "128,000 context · 8,192 max output", never an invented number. */
export function limitSummary(limits: ModelLimits): string {
  const parts: string[] = [];
  if (typeof limits.contextWindow === 'number') {
    parts.push(`${tokenCount(limits.contextWindow)} context`);
  }
  if (typeof limits.maxOutputTokens === 'number') {
    parts.push(`${tokenCount(limits.maxOutputTokens)} max output`);
  }
  return parts.length > 0 ? parts.join(' · ') : 'No limits declared for this model.';
}

export function paramLabel(key: GenParamKey): string {
  return PARAM_SPECS[key].label;
}

/** The parameters this model is declared to honour, in the shared spec order. */
export function paramSummary(keys: GenParamKey[]): string {
  if (keys.length === 0) return 'No parameters declared.';
  return keys.map(paramLabel).join(', ');
}

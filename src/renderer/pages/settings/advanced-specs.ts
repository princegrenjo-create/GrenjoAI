/**
 * The declared advanced settings, as data.
 *
 * The Advanced editor is a table generated from this list, so a key added to
 * `AdvancedSettings` either appears here with a type, a range and a description,
 * or it is visibly missing — it cannot be half-documented. The key unions below
 * are the reason the table can patch a value without a single type assertion.
 */
import { DEFAULT_SETTINGS } from '@shared/defaults';
import type { AdvancedSettings, AppLogLevel } from '@shared/types';

export type AdvancedBooleanKey =
  | 'requireHttpsForCustomEndpoints'
  | 'allowInsecureLocalhost'
  | 'blockRequestsWhenOffline';

export type AdvancedNumberKey = 'streamIdleTimeoutMs';

export type AdvancedSelectKey = 'logLevel';

interface AdvancedSpecBase {
  label: string;
  /** Human type label for the table, e.g. "Switch" or "Number". */
  type: string;
  /** Human range, e.g. "5,000 – 600,000 ms". */
  range: string;
  description: string;
}

export interface SwitchAdvancedSpec extends AdvancedSpecBase {
  control: 'switch';
  key: AdvancedBooleanKey;
}

export interface NumberAdvancedSpec extends AdvancedSpecBase {
  control: 'number';
  key: AdvancedNumberKey;
  min: number;
  max: number;
  step: number;
}

export interface SelectAdvancedSpec extends AdvancedSpecBase {
  control: 'select';
  key: AdvancedSelectKey;
  options: Array<{ value: AppLogLevel; label: string }>;
}

export type AdvancedSpec = SwitchAdvancedSpec | NumberAdvancedSpec | SelectAdvancedSpec;

export const LOG_LEVEL_OPTIONS: Array<{ value: AppLogLevel; label: string }> = [
  { value: 'error', label: 'Error' },
  { value: 'warn', label: 'Warning' },
  { value: 'info', label: 'Info' },
  { value: 'debug', label: 'Debug' },
];

export const ADVANCED_SPECS: AdvancedSpec[] = [
  {
    key: 'logLevel',
    label: 'Log level',
    control: 'select',
    type: 'Select',
    range: 'error · warn · info · debug',
    description:
      'How much the application writes to its log file. Applied immediately; a restart is not required.',
    options: LOG_LEVEL_OPTIONS,
  },
  {
    key: 'requireHttpsForCustomEndpoints',
    label: 'Require HTTPS',
    control: 'switch',
    type: 'Switch',
    range: 'On / Off',
    description:
      'Refuse a plain-HTTP endpoint for a provider or a custom model, even when it resolves to this machine.',
  },
  {
    key: 'allowInsecureLocalhost',
    label: 'Allow insecure localhost',
    control: 'switch',
    type: 'Switch',
    range: 'On / Off',
    description:
      'Permit plain HTTP only for a loopback address (localhost / 127.0.0.1), so a gateway running on this machine can be used.',
  },
  {
    key: 'blockRequestsWhenOffline',
    label: 'Block requests when offline',
    control: 'switch',
    type: 'Switch',
    range: 'On / Off',
    description:
      'Refuse to send a request while the app detects no network, instead of waiting for a timeout.',
  },
  {
    key: 'streamIdleTimeoutMs',
    label: 'Stream idle timeout',
    control: 'number',
    type: 'Number',
    range: '5,000 – 600,000 ms',
    min: 5000,
    max: 600000,
    step: 1000,
    description: 'Abort a streamed reply that delivered no bytes for this long.',
  },
];

/** The documented default for one advanced key. */
export function advancedDefault<K extends keyof AdvancedSettings>(key: K): AdvancedSettings[K] {
  return DEFAULT_SETTINGS.advanced[key];
}

/** Switch labels read as "On"/"Off", everything else as the raw documented value. */
export function formatDefaultValue(value: boolean | number | string): string {
  if (typeof value === 'boolean') return value ? 'On' : 'Off';
  if (typeof value === 'number') return value.toLocaleString();
  return value;
}

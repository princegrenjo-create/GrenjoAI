/**
 * Error copy. The shared error model gives each failure a code; the UI decides
 * what that code means to a person, which action clears it, and whether a retry
 * is honest. A raw stack trace or "Error: undefined" is never rendered.
 */
import type { AppErrorShape } from '@shared/types';

export type ErrorAction = 'retry' | 'configure' | 'dismiss';

export interface ErrorPresentation {
  title: string;
  description: string;
  /** Only shown when retrying is a sensible thing to do. */
  retryable: boolean;
  action: ErrorAction;
  /** Short label for the clearing action. */
  actionLabel: string;
}

/** The provider acknowledged nothing usable; the fix lives in Models & Providers. */
function needsConfiguration(error: AppErrorShape): ErrorPresentation {
  return {
    title: error.code === 'missing_key' ? 'No API key saved' : 'The provider rejected the key',
    description:
      error.code === 'missing_key'
        ? 'Add an API key for the provider in Models & Providers, then send the message again.'
        : 'The key for this provider was rejected. Replace it in Models & Providers, then retry.',
    retryable: false,
    action: 'configure',
    actionLabel: 'Open Models & Providers',
  };
}

export function presentChatError(error: AppErrorShape): ErrorPresentation {
  switch (error.code) {
    case 'missing_key':
    case 'invalid_key':
      return needsConfiguration(error);
    case 'rate_limited':
      return {
        title: 'The provider is rate limiting this app',
        description:
          'Too many requests in a short window. Wait a few seconds, then try again. The conversation is saved.',
        retryable: true,
        action: 'retry',
        actionLabel: 'Retry',
      };
    case 'timeout':
      return {
        title: 'The request timed out',
        description:
          'The provider did not finish in time. Your message is saved — retry it, or raise the timeout in Settings → Generation.',
        retryable: true,
        action: 'retry',
        actionLabel: 'Retry',
      };
    case 'offline':
      return {
        title: 'You are offline',
        description:
          'This app talks to the provider over the internet. Reconnect, then retry — nothing was sent and your message is still here.',
        retryable: true,
        action: 'retry',
        actionLabel: 'Retry',
      };
    case 'context_length':
      return {
        title: 'The conversation is longer than the model allows',
        description:
          'Start a new conversation or trim earlier messages. Reducing the history budget in Settings → Generation also helps.',
        retryable: false,
        action: 'dismiss',
        actionLabel: 'Dismiss',
      };
    case 'model_not_found':
      return {
        title: 'That model is not available',
        description:
          'The provider does not know this model id. Pick another model in the chat header, or refresh the model list under Models & Providers.',
        retryable: false,
        action: 'configure',
        actionLabel: 'Open Models & Providers',
      };
    case 'bad_request':
      return {
        title: 'The provider rejected the request',
        description: error.message,
        retryable: false,
        action: 'dismiss',
        actionLabel: 'Dismiss',
      };
    case 'provider_error':
      return {
        title: 'The provider failed to answer',
        description: `${error.message} This is on the provider side; retrying usually works.`,
        retryable: true,
        action: 'retry',
        actionLabel: 'Retry',
      };
    case 'cancelled':
      return {
        title: 'Stopped',
        description: 'The request was cancelled before the model finished.',
        retryable: true,
        action: 'retry',
        actionLabel: 'Retry',
      };
    case 'storage':
      return {
        title: 'The local database could not be read',
        description:
          'Personal AI Desk stores conversations on this machine. Check the log under Settings → About, then restart the app.',
        retryable: true,
        action: 'retry',
        actionLabel: 'Try again',
      };
    case 'not_found':
      return {
        title: 'That item no longer exists',
        description: 'It may have been deleted on another machine. Reload to see the current list.',
        retryable: true,
        action: 'retry',
        actionLabel: 'Reload',
      };
    case 'sync_auth':
    case 'sync_config':
      return {
        title: 'Cloud sync is not configured',
        description: error.message,
        retryable: false,
        action: 'configure',
        actionLabel: 'Open Cloud Sync',
      };
    case 'validation':
      return {
        title: 'Some values need a fix',
        description: error.message,
        retryable: false,
        action: 'dismiss',
        actionLabel: 'Dismiss',
      };
    case 'unknown':
    default:
      return {
        title: 'Something went wrong',
        description: error.message || 'The request could not be completed. Try again.',
        retryable: error.retryable,
        action: error.retryable ? 'retry' : 'dismiss',
        actionLabel: error.retryable ? 'Try again' : 'Dismiss',
      };
  }
}

/** Short human label for a generic failure, used in banners and toasts. */
export function errorSummary(error: AppErrorShape): string {
  return error.message || 'The request could not be completed.';
}

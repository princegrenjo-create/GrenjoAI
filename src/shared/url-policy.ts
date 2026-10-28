/**
 * Endpoint URL policy.
 *
 * Shared by the settings UI (inline validation), the IPC layer (server-side
 * validation) and the request executor (defence in depth). One implementation
 * so the three cannot disagree.
 */

export interface UrlPolicyOptions {
  requireHttps: boolean;
  /** Permit plain HTTP only for loopback development endpoints. */
  allowInsecureLocalhost: boolean;
}

export type UrlCheck = { ok: true; url: string } | { ok: false; reason: string };

const LOOPBACK_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  '[::1]',
  '0.0.0.0',
  'host.docker.internal',
]);

export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (LOOPBACK_HOSTS.has(host)) return true;
  // 127.0.0.0/8
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  return false;
}

/**
 * Validates a base URL the user typed. Rejects embedded credentials, non-HTTP
 * schemes, fragments and query strings — a base URL with a query string is a
 * sign the user pasted a full request URL by mistake.
 */
export function validateEndpointUrl(input: string, options: UrlPolicyOptions): UrlCheck {
  const raw = (input ?? '').trim();
  if (!raw) return { ok: false, reason: 'A base URL is required.' };
  if (raw.length > 2048) return { ok: false, reason: 'The URL is too long (2048 characters max).' };

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, reason: 'That is not a valid absolute URL. Include the scheme, e.g. https://host/v1' };
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, reason: `Unsupported scheme "${parsed.protocol}". Only http and https are allowed.` };
  }
  if (parsed.username || parsed.password) {
    return {
      ok: false,
      reason: 'Remove the credentials from the URL. Keys belong in the API key field, not in the URL.',
    };
  }
  if (parsed.hash || parsed.search) {
    return { ok: false, reason: 'A base URL must not contain a query string or a fragment.' };
  }
  if (!parsed.hostname) {
    return { ok: false, reason: 'The URL has no host.' };
  }

  const loopback = isLoopbackHost(parsed.hostname);
  if (parsed.protocol === 'http:') {
    if (!(options.allowInsecureLocalhost && loopback)) {
      return {
        ok: false,
        reason:
          'Plain HTTP is only allowed for a loopback address (localhost / 127.0.0.1) while "Allow insecure localhost" is enabled. Use HTTPS for anything else.',
      };
    }
  } else if (options.requireHttps === false) {
    // HTTPS is always acceptable; this branch exists so the option has a meaning.
  }

  const normalised = `${parsed.protocol}//${parsed.host}${parsed.pathname}`.replace(/\/+$/, '');
  return { ok: true, url: normalised };
}

/** Links opened in the system browser must be plain HTTPS pages. */
export function isExternalLinkAllowed(input: string): boolean {
  try {
    const parsed = new URL(input);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

/** Join a base URL and a path without producing a double slash. */
export function joinUrl(base: string, path: string): string {
  const left = base.replace(/\/+$/, '');
  const right = path.replace(/^\/+/, '');
  return `${left}/${right}`;
}

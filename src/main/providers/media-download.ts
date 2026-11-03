/**
 * Binary download for provider results that arrive as a URL.
 *
 * Black Forest Labs hands back a **signed URL valid for ten minutes**; Replicate
 * purges its output after about an hour. Both mean the file must be fetched now,
 * by the main process, and stored before anything is reported as finished.
 *
 * Three constraints, because the URL comes from a third party:
 *  - HTTPS only, no exceptions;
 *  - `redirect: 'error'` — a redirect would let a compromised endpoint move the
 *    request (and its Authorization header) to another host;
 *  - an allowlist of hosts, because the provider's delivery host is documented and
 *    a different one is not ours to trust;
 *  - a byte ceiling, so a "video" cannot fill the disk before the store ever sees it.
 *
 * The response body is read as bytes, never as text: text decoding would corrupt
 * an mp4.
 */
const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;

export class DownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DownloadError';
  }
}

export interface DownloadOptions {
  headers?: Record<string, string>;
  allowedHosts: readonly string[];
  maxBytes?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * True when `url` is HTTPS and its host is one of `allowedHosts`.
 *
 * A suffix match is deliberate for entries written as `example.com`: the
 * provider's delivery is served from subdomains. The match is on a dot boundary,
 * so `evil-example.com` does not pass.
 */
export function isAllowedDownloadUrl(url: string, allowedHosts: readonly string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  return allowedHosts.some((allowed) => {
    const candidate = allowed.toLowerCase();
    return host === candidate || host.endsWith(`.${candidate}`);
  });
}

export async function downloadBytes(url: string, options: DownloadOptions): Promise<Uint8Array> {
  if (!isAllowedDownloadUrl(url, options.allowedHosts)) {
    throw new DownloadError(
      `Refusing to download from ${new URL(url, 'https://invalid').host}: it is not an HTTPS host this provider is documented to serve results from.`,
    );
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: options.headers ?? {},
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new DownloadError(`The provider returned ${response.status} for its own result file.`);
    }

    const declared = Number(response.headers.get('content-length') ?? '0');
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new DownloadError(
        `That result is larger than the ${Math.round(maxBytes / (1024 * 1024))} MB this app will store.`,
      );
    }

    const body = response.body;
    if (!body) {
      const buffer = new Uint8Array(await response.arrayBuffer());
      if (buffer.byteLength > maxBytes) throw new DownloadError('That result is larger than this app will store.');
      return buffer;
    }

    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new DownloadError('That result is larger than this app will store.');
      }
      chunks.push(value);
    }

    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return merged;
  } finally {
    clearTimeout(timer);
  }
}

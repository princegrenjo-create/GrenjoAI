/**
 * The `media://` protocol.
 *
 * Generated media is displayed by the renderer, and the renderer performs no
 * network I/O (`connect-src 'none'`). Passing bytes through IPC as base64 would
 * mean a ≈55 MB string for a 40 MB video, held three times over in the renderer's
 * heap. A protocol handler turns the same file into an ordinary resource load that
 * Chromium can stream, range-request and cache.
 *
 * Security rules, in order of importance:
 *  - the scheme is registered as **standard and secure**, never as `bypassCSP`, so
 *    the renderer's `img-src`/`media-src` still decide what may load;
 *  - the host is fixed (`media://local/…`), so an attacker-controlled page cannot
 *    address another host on this scheme;
 *  - the path is handed to `MediaStore.resolve`, which accepts only the
 *    content-addressed shape this app wrote and refuses anything that escapes the
 *    media root — the handler never concatenates a URL into a filesystem path.
 */
import { net, protocol } from 'electron';
import { MEDIA_HOST, MEDIA_SCHEME, mediaUrl } from '@shared/media';
import { pathToFileURL } from 'node:url';
import type { MediaStore } from './store';

const CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  mp4: 'video/mp4',
  webm: 'video/webm',
};

/**
 * A URL the renderer can use for a stored file.
 *
 * Only the relative path is embedded; the absolute path never reaches the
 * renderer, which is why a moved profile folder still works.
 */
export function mediaUrlFor(relativePath: string): string {
  return `${MEDIA_SCHEME}://${MEDIA_HOST}/${relativePath.replace(/^\/+/, '')}`;
}

/**
 * The stored path a `media://` URL refers to, or null when the URL is not one this
 * app would produce. Pure, so it is testable without Electron.
 */
export function relativePathFromMediaUrl(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== `${MEDIA_SCHEME}:`) return null;
  if (url.host !== MEDIA_HOST) return null;
  const path = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  return path.length > 0 ? path : null;
}

/** Content type from the extension we chose when storing the file. */
export function contentTypeFor(relativePath: string): string {
  const extension = relativePath.slice(relativePath.lastIndexOf('.') + 1).toLowerCase();
  return CONTENT_TYPE_BY_EXTENSION[extension] ?? 'application/octet-stream';
}

/**
 * Must run before `app.whenReady()`: Chromium fixes its scheme table at startup,
 * so a later registration is silently ignored.
 */
export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MEDIA_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: false,
        // Video needs range requests to seek; the file itself is a local resource.
        stream: true,
        // Never bypass the page's CSP: the renderer's policy must still decide.
        bypassCSP: false,
      },
    },
  ]);
}

/**
 * Installs the handler. Every failure is a 404 with no detail, so a guessable URL
 * cannot be used to probe which files exist outside the media root.
 */
export function installMediaProtocol(store: MediaStore): void {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    const relativePath = relativePathFromMediaUrl(request.url);
    if (!relativePath) return new Response('Not found', { status: 404 });

    let absolute: string;
    try {
      absolute = store.resolve(relativePath);
    } catch {
      return new Response('Not found', { status: 404 });
    }

    // Streaming via net.fetch keeps a large video out of the main process's heap.
    const fileResponse = await net.fetch(pathToFileURL(absolute).toString());
    if (!fileResponse.ok) return new Response('Not found', { status: 404 });

    const headers = new Headers(fileResponse.headers);
    headers.set('Content-Type', contentTypeFor(relativePath));
    headers.set('Cache-Control', 'no-store');
    return new Response(fileResponse.body, { status: 200, headers });
  });
}

/**
 * Session and renderer hardening.
 *
 * The renderer is treated as untrusted: it displays text produced by a remote
 * model, and Markdown is a rendering surface for hostile input. These controls
 * are applied to every web contents the app creates, not just the first window.
 *
 * Deliberate choices worth knowing when reading the rest of the code:
 *  - `redirect: 'error'` on provider requests means no HTTP redirect is followed.
 *  - The renderer's CSP sets `connect-src 'none'`: it performs no network I/O at
 *    all, so a successful prompt-injection cannot exfiltrate a transcript.
 *  - Every permission (camera, microphone, geolocation, notifications, clipboard
 *    read, MIDI, serial, USB …) is denied by default. The app needs none.
 */
import { app, session, shell, type Session, type WebContents } from 'electron';
import { isExternalLinkAllowed } from '@shared/url-policy';
import type { Logger } from './logger';

export const PROD_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'none'",
  // `blob:` is required to preview a just-recorded voice memo; no remote media.
  "media-src 'self' blob:",
  "object-src 'none'",
  "frame-src 'none'",
  "worker-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

export interface HardeningOptions {
  isDev: boolean;
  allowedOrigin: string;
  logger: Logger;
}

/** Applies the CSP response header for http(s) responses (dev server, previews). */
export function applyContentSecurityPolicy(target: Session, options: HardeningOptions): void {
  const { isDev, allowedOrigin, logger } = options;
  const devCsp = [
    "default-src 'none'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self' ${allowedOrigin} ${allowedOrigin.replace('http://', 'ws://')}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');

  target.webRequest.onHeadersReceived((details, callback) => {
    const headers = { ...(details.responseHeaders ?? {}) };
    headers['Content-Security-Policy'] = [isDev ? devCsp : PROD_CSP];
    headers['X-Content-Type-Options'] = ['nosniff'];
    headers['Referrer-Policy'] = ['no-referrer'];
    callback({ responseHeaders: headers });
  });

  /*
   * Permissions: everything is denied except the microphone, and the microphone
   * only for the app's own origin and only for audio.
   *
   * This is the minimum carve-out voice recording needs. It is deliberately not
   * `callback(true)` for `media` in general: a `media` grant that includes
   * `video` would hand the renderer the camera, and this application never needs
   * one. `getUserMedia({video:true})` is therefore still refused.
   */
  const isOwnOrigin = (url: string | undefined): boolean =>
    typeof url === 'string' && url.startsWith(options.allowedOrigin);

  target.setPermissionRequestHandler((contents, permission, callback, details) => {
    const requestingUrl = details?.requestingUrl ?? contents.getURL();
    // `mediaTypes` only exists on a media permission request; the union type
    // covers several request shapes, so it is read defensively.
    const rawMediaTypes =
      permission === 'media' && details && 'mediaTypes' in details
        ? (details as { mediaTypes?: unknown }).mediaTypes
        : undefined;
    const mediaTypes: string[] = Array.isArray(rawMediaTypes)
      ? rawMediaTypes.filter((entry): entry is string => typeof entry === 'string')
      : [];
    const audioOnly =
      mediaTypes.length === 0 ||
      (mediaTypes.includes('audio') && !mediaTypes.includes('video'));

    if (permission === 'media' && audioOnly && isOwnOrigin(requestingUrl)) {
      logger.info('Granted the microphone permission for a recording', {
        mediaTypes: mediaTypes.join(',') || 'audio',
      });
      callback(true);
      return;
    }
    logger.warn('Denied a renderer permission request', {
      permission,
      mediaTypes: mediaTypes.join(','),
      ownOrigin: isOwnOrigin(requestingUrl),
    });
    callback(false);
  });

  target.setPermissionCheckHandler((_contents, permission, requestingOrigin, details) => {
    const mediaType = details?.mediaType;
    if (permission === 'media' && mediaType !== 'video' && isOwnOrigin(requestingOrigin)) {
      return true;
    }
    logger.debug('Denied a renderer permission check', { permission, mediaType });
    return false;
  });

  // Device (HID/serial/USB) access is not needed anywhere in this application.
  try {
    target.setDevicePermissionHandler(() => false);
  } catch {
    /* older Electron builds do not expose this handler */
  }
}

/**
 * Applies navigation and popup restrictions to one web contents. Called for the
 * main window and again for every web contents the app ever creates, so a
 * renderer cannot spawn a second, less-restricted surface.
 */
export function hardenWebContents(contents: WebContents, options: HardeningOptions): void {
  const { allowedOrigin, logger } = options;

  contents.on('will-navigate', (event, url) => {
    if (!url.startsWith(allowedOrigin)) {
      event.preventDefault();
      logger.warn('Blocked an in-app navigation', { url: url.slice(0, 200) });
    }
  });

  contents.on('will-redirect', (event, url) => {
    if (!url.startsWith(allowedOrigin)) {
      event.preventDefault();
      logger.warn('Blocked an in-app redirect', { url: url.slice(0, 200) });
    }
  });

  contents.setWindowOpenHandler(({ url }) => {
    if (isExternalLinkAllowed(url)) {
      void shell.openExternal(url);
      logger.info('Opened an approved external link in the system browser', {
        host: safeHost(url),
      });
    } else {
      logger.warn('Blocked a non-HTTPS window open request', { url: url.slice(0, 200) });
    }
    return { action: 'deny' };
  });

  contents.on('will-attach-webview', (event) => {
    event.preventDefault();
    logger.warn('Blocked a webview attachment');
  });
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'invalid-url';
  }
}

/**
 * Installs the process-wide web-contents policy. Must run before the first
 * window is created so no surface exists without it.
 */
export function installGlobalHardening(options: HardeningOptions): void {
  app.on('web-contents-created', (_event, contents) => {
    hardenWebContents(contents, options);
  });
  applyContentSecurityPolicy(session.defaultSession, options);
}

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
  "media-src 'none'",
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

  target.setPermissionRequestHandler((_contents, permission, callback) => {
    logger.warn('Denied a renderer permission request', { permission });
    callback(false);
  });

  target.setPermissionCheckHandler((_contents, permission) => {
    logger.debug('Denied a renderer permission check', { permission });
    return false;
  });

  // No device access is needed anywhere in this application.
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

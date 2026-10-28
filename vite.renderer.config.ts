import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));

/**
 * Renderer build. `base: './'` keeps asset URLs relative so the bundle loads
 * correctly from `file://` inside the packaged application.
 *
 * CSP is injected as a <meta> tag per mode by the inline plugin below because
 * `file://` responses never pass through `webRequest.onHeadersReceived`, so a
 * header-only policy would be silently absent in the installed app.
 */
const PROD_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'none'",
  // Previewing a just-recorded voice memo needs blob:; there is no remote media.
  "media-src 'self' blob:",
  "object-src 'none'",
  "frame-src 'none'",
  "worker-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

// Dev needs the Vite HMR websocket and React Refresh's inline preamble.
const DEV_CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' ws://localhost:* ws://127.0.0.1:* http://localhost:* http://127.0.0.1:*",
  "media-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

export default defineConfig(({ command }) => {
  const isDev = command === 'serve';
  return {
    root: path.join(root, 'src/renderer'),
    base: './',
    plugins: [
      react(),
      {
        name: 'inject-csp',
        transformIndexHtml(html) {
          const csp = isDev ? DEV_CSP : PROD_CSP;
          return html.replace(
            '<!-- CSP -->',
            `<meta http-equiv="Content-Security-Policy" content="${csp}" />`,
          );
        },
      },
    ],
    resolve: {
      alias: {
        '@shared': path.join(root, 'src/shared'),
        '@renderer': path.join(root, 'src/renderer'),
      },
    },
    server: {
      port: 5273,
      strictPort: true,
      host: '127.0.0.1',
    },
    build: {
      outDir: path.join(root, 'dist/renderer'),
      emptyOutDir: true,
      sourcemap: false,
      target: 'chrome130',
      chunkSizeWarningLimit: 900,
    },
  };
});

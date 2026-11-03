#!/usr/bin/env node
/**
 * Static server for the built renderer, used only by the Playwright run.
 *
 * The packaged app loads the renderer from `file://`, where Chromium refuses to
 * load module scripts. Serving the same `dist/renderer` over HTTP lets a browser
 * test the real page — the same bundle, the same CSS, the same router — without
 * launching Electron and without a second build.
 *
 * It is a test fixture, not a product surface: no caching headers, no directory
 * listing, and it refuses any path that resolves outside the directory.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'dist', 'renderer');
const port = Number(process.env.RENDERER_PORT ?? 4373);

const CONTENT_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.svg', 'image/svg+xml'],
  ['.woff2', 'font/woff2'],
]);

const server = createServer(async (request, response) => {
  const requested = decodeURIComponent((request.url ?? '/').split('?')[0] ?? '/');
  const relative = requested === '/' ? 'index.html' : requested.replace(/^\/+/, '');
  const target = path.resolve(root, relative);

  if (!target.startsWith(root)) {
    response.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const info = await stat(target);
    const file = info.isDirectory() ? path.join(target, 'index.html') : target;
    const body = await readFile(file);
    response.writeHead(200, {
      'Content-Type': CONTENT_TYPES.get(path.extname(file)) ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    response.end(body);
  } catch {
    // A hash route is a client concern; anything without a file is a 404.
    response.writeHead(404).end('Not found');
  }
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`[serve-renderer] http://127.0.0.1:${port} -> ${root}\n`);
});

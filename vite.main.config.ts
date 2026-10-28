import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));

/**
 * Main-process bundle. CommonJS because Electron's main entry is loaded with
 * `require` and the package is not marked as ESM.
 */
export default defineConfig({
  build: {
    outDir: 'dist/main',
    emptyOutDir: true,
    sourcemap: false,
    target: 'node22',
    minify: false,
    lib: {
      entry: path.join(root, 'src/main/index.ts'),
      formats: ['cjs'],
      fileName: () => 'index.cjs',
    },
    rollupOptions: {
      external: [
        'electron',
        // Document parsers stay external and are loaded lazily, so a chat-only
        // session never pays for pdfjs or the OOXML reader. electron-builder
        // ships them inside the asar because they are production dependencies.
        'mammoth',
        'unpdf',
        'node:sqlite',
        'node:crypto',
        'node:fs',
        'node:fs/promises',
        'node:path',
        'node:os',
        'node:url',
        'node:net',
        'node:tls',
        'node:https',
        'node:http',
        'node:util',
        'node:events',
        'node:stream',
        'node:string_decoder',
        'node:zlib',
        'node:child_process',
      ],
    },
  },
  resolve: {
    alias: {
      '@shared': path.join(root, 'src/shared'),
      '@main': path.join(root, 'src/main'),
    },
  },
});

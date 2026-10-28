import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));

/**
 * Preload bundle. Must be a single CommonJS file: the renderer runs sandboxed
 * (`sandbox: true`), which supports only CommonJS preload scripts.
 */
export default defineConfig({
  build: {
    outDir: 'dist/preload',
    emptyOutDir: true,
    sourcemap: false,
    target: 'node22',
    minify: false,
    lib: {
      entry: path.join(root, 'src/preload/index.ts'),
      formats: ['cjs'],
      fileName: () => 'index.cjs',
    },
    rollupOptions: {
      external: ['electron'],
    },
  },
  resolve: {
    alias: {
      '@shared': path.join(root, 'src/shared'),
    },
  },
});

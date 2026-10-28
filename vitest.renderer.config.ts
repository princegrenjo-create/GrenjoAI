import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));

/** Renderer suites: React components and UI logic under jsdom. */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': path.join(root, 'src/shared'),
      '@renderer': path.join(root, 'src/renderer'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: [path.join(root, 'tests/renderer/setup.ts')],
    include: ['tests/renderer/**/*.test.{ts,tsx}'],
    exclude: ['node_modules', 'dist', 'release'],
    css: true,
    reporters: ['default'],
  },
});

import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));

/** Node-side suites: database, repositories, providers, sync, credentials, chat. */
export default defineConfig({
  resolve: {
    alias: {
      '@shared': path.join(root, 'src/shared'),
      '@main': path.join(root, 'src/main'),
    },
  },
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/main/**/*.test.ts', 'tests/node/**/*.test.ts'],
    exclude: ['node_modules', 'dist', 'release'],
    testTimeout: 20000,
    hookTimeout: 20000,
    reporters: ['default'],
  },
});

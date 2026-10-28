import { defineConfig } from 'vitest/config';
import path from 'node:path';

/**
 * Mobile unit tests.
 *
 * They cover the pure layer only — shared-core logic, the copied provider
 * adapters, the SQLite mapping and the chat orchestration — because there is no
 * React Native runtime in Node. Nothing here renders a native view; screens are
 * verified by typechecking plus the Metro bundle in `expo export`.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@core': path.resolve(__dirname, 'src/core'),
      '@ai': path.resolve(__dirname, 'src/ai'),
      '@': path.resolve(__dirname, 'src'),
    },
  },
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/**/*.test.ts'],
    exclude: ['node_modules', 'dist', '.expo'],
    testTimeout: 20000,
  },
});

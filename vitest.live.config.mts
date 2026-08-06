import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Live checks that call real external APIs. Kept out of `npm test` so the
 * default suite stays offline and deterministic.
 * Run: npm run test:live
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.check.ts'],
    env: { ...loadEnvLocal() },
  },
  resolve: {
    tsconfigPaths: true,
    alias: {
      'server-only': fileURLToPath(new URL('./src/test/server-only-stub.ts', import.meta.url)),
    },
  },
});

function loadEnvLocal(): Record<string, string> {
  try {
    const path = fileURLToPath(new URL('./.env.local', import.meta.url));
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const contents = require('node:fs').readFileSync(path, 'utf8') as string;
    return Object.fromEntries(
      contents
        .split(/\r?\n/)
        .filter((line) => line.includes('=') && !line.trim().startsWith('#'))
        .map((line) => {
          const index = line.indexOf('=');
          return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
        }),
    );
  } catch {
    return {};
  }
}

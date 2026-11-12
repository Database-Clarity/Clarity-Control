import { defineConfig, mergeConfig } from 'vite';
import base from '../vite.config';

// Test-only origin injection. This config is never loaded by the default build.
export default mergeConfig(
  base,
  defineConfig({
    plugins: [
      {
        name: 'migrate-test-origins',
        enforce: 'pre',
        transform(code, id) {
          if (!id.replaceAll('\\', '/').endsWith('/features/migrate/protocol.ts')) return;
          const oldOrigin = process.env.MIGRATE_TEST_OLD_ORIGIN;
          const newOrigin = process.env.MIGRATE_TEST_NEW_ORIGIN;
          if (!oldOrigin || !newOrigin)
            throw new Error('Both MIGRATE_TEST origin variables are required.');
          for (const origin of [oldOrigin, newOrigin]) {
            const parsed = new URL(origin);
            if (
              parsed.protocol !== 'http:' ||
              !['localhost', '127.0.0.1'].includes(parsed.hostname) ||
              parsed.origin !== origin
            )
              throw new Error('Migration tests require exact local HTTP origins.');
          }
          return code
            .replace("'https://control.d2clarity.com'", JSON.stringify(newOrigin))
            .replace("'https://database-clarity.github.io'", JSON.stringify(oldOrigin));
        },
      },
    ],
  }),
);

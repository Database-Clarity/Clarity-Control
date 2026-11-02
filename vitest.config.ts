import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'apps/**/*.{test,spec}.{ts,tsx}',
      'packages/**/*.{test,spec}.{ts,tsx}',
      'scripts/compendium/*.test.mjs',
      'scripts/weapon-section-inventory/*.test.mjs',
      'scripts/lost-text/*.test.mjs',
      'scripts/compendium/coverage/compare.test.ts',
    ],
    exclude: ['**/node_modules/**', '**/dist/**', 'legacy/**'],
  },
});

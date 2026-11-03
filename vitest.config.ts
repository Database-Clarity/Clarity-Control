import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // CI runners are slow under a full parallel run; cold dynamic imports exceed 5s.
    testTimeout: 20_000,
    include: [
      'apps/**/*.{test,spec}.{ts,tsx}',
      'packages/**/*.{test,spec}.{ts,tsx}',
      'scripts/compendium/*.test.mjs',
      'scripts/weapon-section-inventory/*.test.mjs',
      'scripts/lost-text/*.test.mjs',
      'scripts/publisher/*.test.ts',
      'scripts/compendium/coverage/compare.test.ts',
    ],
    exclude: ['**/node_modules/**', '**/dist/**', 'legacy/**'],
  },
});

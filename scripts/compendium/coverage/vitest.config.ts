import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['scripts/compendium/coverage/*.test.ts'],
    testTimeout: 240_000,
  },
});

import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { include: ['scripts/globals/*.test.{ts,mjs}'], testTimeout: 120_000 },
});

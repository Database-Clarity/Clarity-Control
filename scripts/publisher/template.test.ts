import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';
import * as z from 'zod';
import { langSchema } from '../../packages/core/src/languages.js';
import { verifyRuntime } from './pipeline.js';

it('ships the reviewed v2 template with a matching integrity pin and documentation', () => {
  const root = 'scripts/publisher/template/.publisher';
  const pin = verifyRuntime(root);
  expect(pin).toEqual({
    sourceSha: 'df5025dfb4184ad8b8d3d63b2ddd9677288ccdb3',
    sha256: 'cdad752606f64329cd2603e2e684a918b232dae725f48ce0d4c0adda3a084a6d',
    capabilities: ['elementTags'],
  });
  expect(
    createHash('sha256')
      .update(readFileSync(`${root}/publisher.mjs`))
      .digest('hex'),
  ).toBe(pin.sha256);
  for (const file of ['README.md', 'E2-RUNBOOK.md']) {
    const doc = readFileSync(`scripts/publisher/${file}`, 'utf8');
    expect(doc).toContain(pin.sourceSha);
    expect(doc).toContain(pin.sha256);
  }
});

it('initializes bundled report schemas without reading globals or performing I/O', () => {
  const runtime = readFileSync('scripts/publisher/template/.publisher/publisher.mjs', 'utf8');
  const start = runtime.indexOf('// packages/core/src/reports/schemas.ts\n');
  const end = runtime.indexOf('// apps/worker/src/stamp.ts\n', start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const globals: Record<string, unknown> = { external_exports: z, langSchema };
  const context = new Proxy(globals, {
    get(target, key) {
      if (typeof key === 'string' && Object.hasOwn(target, key)) return target[key];
      throw new Error(`Unexpected global read: ${String(key)}`);
    },
  });
  // Only the report section is executed; the CLI entrypoint is deliberately excluded.
  expect(() =>
    runInNewContext(runtime.slice(start, end), context, { timeout: 1000 }),
  ).not.toThrow();
});

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { verifyRuntime } from './pipeline.js';

it('ships the reviewed v2 template with a matching integrity pin and documentation', () => {
  const root = 'scripts/publisher/template/.publisher';
  const pin = verifyRuntime(root);
  expect(pin).toEqual({
    sourceSha: 'eacb1d73c97b7d14a3b0c0bedea9dc01c457381e',
    sha256: '74c136fc998c9850c326c650c1a36467bf6000b9f53122c8a67af29933b3e16a',
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

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { verifyRuntime } from './pipeline.js';

it('ships the reviewed v2 template with a matching integrity pin and documentation', () => {
  const root = 'scripts/publisher/template/.publisher';
  const pin = verifyRuntime(root);
  expect(pin).toEqual({
    sourceSha: 'cac0b1e95824a3ab3b0c93c3bc13c808dcb76277',
    sha256: 'e2fe19cd0c5376167a16b3e83d2eb4fc875931abcf3cca5986425234bb6a3dec',
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

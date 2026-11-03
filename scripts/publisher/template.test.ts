import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { verifyRuntime } from './pipeline.js';

it('ships the reviewed v2 template with a matching integrity pin and documentation', () => {
  const root = 'scripts/publisher/template/.publisher';
  const pin = verifyRuntime(root);
  expect(pin).toEqual({
    sourceSha: '461477045a6e89cb06159d2718438fa4ebc7a2ae',
    sha256: '062eb9de0eb6e9ea636d604403b92e61050cc81ec2fd79a08618626ef1009a1d',
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

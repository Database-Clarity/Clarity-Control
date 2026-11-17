import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parity } from './parity.mjs';

it('requires all 12 installed outputs and blocks a single byte difference with retained evidence', async () => {
  mkdirSync('.agents/globals-bootstrap/tests', { recursive: true });
  const root = mkdtempSync(resolve('.agents/globals-bootstrap/tests/parity-'));
  const legacy = [
    'braytech',
    'clarity',
    'crayon',
    'dim',
    'foundry',
    'lightGG',
    'vaultZero',
    'clarityV2',
  ];
  const adapters = ['installed', 'held'].map((role) => {
    const files = (
      role === 'held' ? legacy : [...legacy, 'structured', 'markdown', 'discord', 'plain']
    ).map((f) => `${f}.json`);
    const source = `export function convert(input) { return Object.fromEntries(${JSON.stringify(files)}.filter(f => f !== input.omit).map(f=>[f, input.text])); }\n`;
    const path = join(root, `${role}.mjs`);
    writeFileSync(path, source);
    return {
      role,
      path,
      dependencies: [],
      sourceCommits: ['a'.repeat(40)],
      sha256: createHash('sha256').update(source).digest('hex'),
    };
  });
  const spec = { now: 0, planSha256: 'b'.repeat(64), context: {}, adapters };
  expect((await parity(spec, { text: 'x' }, { text: 'x' }, join(root, 'pass'))).identical).toBe(
    true,
  );
  await expect(parity(spec, { text: 'x' }, { text: 'y' }, join(root, 'different'))).rejects.toThrow(
    'STOP',
  );
  const report = JSON.parse(readFileSync(join(root, 'different/parity.json'), 'utf8'));
  expect(
    report.reports[0].files.every(
      (file) => file.differingBytes === 1 && file.firstDifference === 0,
    ),
  ).toBe(true);
  await expect(
    parity(spec, { text: 'x', omit: 'plain.json' }, { text: 'x' }, join(root, 'missing')),
  ).rejects.toThrow('Incomplete');
  await expect(
    parity(
      { ...spec, adapters: [{ ...adapters[0], sha256: '0'.repeat(64) }, adapters[1]] },
      {},
      {},
      join(root, 'pin'),
    ),
  ).rejects.toThrow('pin mismatch');
});

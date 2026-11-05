import { expect, it } from 'vitest';
import { decodePrecomputed, encodePrecomputed, encodePrecomputedSteps } from './precomputedCodec';

it('round-trips rich data and interns repeated snapshots without losing array/primitive identity', () => {
  const cell = {
    plain: 'One\nTwo',
    runs: [{ text: 'One\nTwo', bold: true }],
    background: '#123456',
  };
  const input = { a: cell, b: structuredClone(cell), values: [0, 1, null, false, '', [0, 1]] };
  const encoded = encodePrecomputed(input);
  const output = decodePrecomputed(encoded.nodes, encoded.root) as typeof input;
  expect(output).toEqual(input);
  expect(output.a).toBe(output.b);
});

it('produces the identical value table when background encoding yields', () => {
  const shared = { plain: 'Styled', runs: [{ text: 'Styled', bold: true }] };
  const value = {
    matches: new Map([
      [100, shared],
      [101, structuredClone(shared)],
    ]),
    entries: Array.from({ length: 300 }, (_, hash) => ({ hash, shared })),
    optional: undefined,
    data: JSON.parse('{"__proto__":{"safe":true}}'),
  };
  const steps = encodePrecomputedSteps(value);
  let next = steps.next();
  while (!next.done) next = steps.next();
  expect(next.value).toEqual(encodePrecomputed(value));
});

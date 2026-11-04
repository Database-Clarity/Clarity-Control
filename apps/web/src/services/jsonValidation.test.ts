import { expect, it } from 'vitest';
import { validateJsonBytes } from './jsonValidation';
import { itemsSchema } from './generatorSchema';
import { bundleSchema } from './bundleSchema';

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).buffer;
const decode = (value: ArrayBuffer) => JSON.parse(new TextDecoder().decode(value));

it('preserves item schema output and rejects key/hash mismatches', () => {
  const item = {
    hash: 42,
    name: 'Test',
    icon: '',
    categoryId: 'weapon-perk',
    inGameDescription: '',
    extra: 'strip me',
  };
  expect(decode(validateJsonBytes('items', bytes({ 42: item })))).toEqual(
    itemsSchema.parse({ 42: item }),
  );
  expect(() => validateJsonBytes('items', bytes({ 43: item }))).toThrow(/keys must match/);
  expect(() => validateJsonBytes('items', bytes({ 42: { ...item, name: 1 } }))).toThrow();
});

it('preserves bundle schema output, including optional malformed queue handling', () => {
  const input = {
    sourceCommit: 'test',
    generatedAt: '2026-11-04T08:00:00Z',
    tooltips: {},
    permissions: { users: {} },
    pushed: {},
    publishQueue: 'bad',
    extra: true,
  };
  expect(decode(validateJsonBytes('bundle', bytes(input)))).toEqual(
    JSON.parse(JSON.stringify(bundleSchema.parse(input))),
  );
  expect(() => validateJsonBytes('bundle', bytes({ ...input, sourceCommit: '' }))).toThrow();
});

it('rejects malformed JSON before returning a validated payload', () => {
  expect(() => validateJsonBytes('items', new TextEncoder().encode('{bad').buffer)).toThrow();
});

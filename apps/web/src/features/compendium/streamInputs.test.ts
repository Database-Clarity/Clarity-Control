import { expect, it } from 'vitest';
import { streamInputs } from './streamInputs';

it('transfers bounded UTF-8 chunks without changing JSON model content', async () => {
  const value = {
    empty: undefined,
    rows: Array.from({ length: 2000 }, (_, index) => ({
      index,
      text: 'One\nTwo 😀',
      optional: undefined,
    })),
    values: [undefined, null, true],
  };
  const chunks: Uint8Array[] = [];
  await streamInputs(
    value,
    (bytes) => chunks.push(new Uint8Array(bytes)),
    () => false,
  );
  expect(chunks.length).toBeGreaterThan(1);
  expect(Math.max(...chunks.map((chunk) => chunk.byteLength))).toBeLessThan(34_000);
  const text = chunks.map((chunk) => new TextDecoder().decode(chunk)).join('');
  expect(JSON.parse(text)).toEqual(JSON.parse(JSON.stringify(value)));
});

it('stops a superseded input stream before transferring another chunk', async () => {
  let count = 0;
  await expect(
    streamInputs(
      Array.from({ length: 10000 }, () => 'row'.repeat(30)),
      () => count++,
      () => count > 0,
    ),
  ).rejects.toThrow('inputs changed');
  expect(count).toBe(1);
});

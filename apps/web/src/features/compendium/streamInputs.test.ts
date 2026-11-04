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
  const decoder = new TextDecoder();
  const text =
    chunks.map((chunk) => decoder.decode(chunk, { stream: true })).join('') + decoder.decode();
  expect(JSON.parse(text)).toEqual(JSON.parse(JSON.stringify(value)));
});

it('keeps oversized multilingual records in bounded byte transfers without corrupting Unicode', async () => {
  const value = { record: { text: '🠚日本語😀'.repeat(12000), optional: undefined } };
  const chunks: Uint8Array[] = [];
  await streamInputs(
    value,
    (buffer) => chunks.push(new Uint8Array(buffer)),
    () => false,
  );
  expect(Math.max(...chunks.map((chunk) => chunk.byteLength))).toBeLessThanOrEqual(32_768);
  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual(JSON.parse(JSON.stringify(value)));
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

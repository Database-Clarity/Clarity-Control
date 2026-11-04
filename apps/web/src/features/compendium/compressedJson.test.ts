import { gzipSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { compressedJson } from './compressedJson';

it('reads both raw gzip assets and responses already decoded by the HTTP stack', async () => {
  const value = { key: 'input-hash', nodes: ['styled source', { bold: true }] };
  const text = JSON.stringify(value);
  expect(await compressedJson(new Response(gzipSync(text)))).toEqual(value);
  expect(
    await compressedJson(new Response(text, { headers: { 'content-encoding': 'gzip' } })),
  ).toEqual(value);
});

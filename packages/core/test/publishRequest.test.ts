import { expect, it } from 'vitest';
import {
  classifyPublishIntent,
  publishBodySchema,
  publishMonth,
  publishIntentDigest,
  validatePublishBody,
} from '../src/publishRequest.js';

const opId = '01K95H00000000000000000001';
const body = { opId, hashes: [123], expected: { 123: 'a'.repeat(64) } };
const time = [...opId.slice(0, 10)].reduce(
  (n, c) => n * 32 + '0123456789ABCDEFGHJKMNPQRSTVWXYZ'.indexOf(c),
  0,
);
it('strictly bounds paths, body, mandatory expectations, and creation time', () => {
  expect(validatePublishBody(body, time)).toEqual(body);
  expect(publishMonth(opId)).toBe(new Date(time).toISOString().slice(0, 7));
  for (const invalid of [
    { ...body, opId: '../bad' },
    { ...body, hashes: [123, 123] },
    { ...body, hashes: [4294967296] },
    { ...body, expected: {} },
    { ...body, expected: { '0123': 'a'.repeat(64) } },
    { ...body, expected: { 123: 'a'.repeat(64), 456: 'a'.repeat(64) } },
    { ...body, repo: 'untrusted' },
    { ...body, hashes: Array.from({ length: 3001 }, (_, i) => i) },
  ])
    expect(publishBodySchema.safeParse(invalid).success).toBe(false);
  expect(() => validatePublishBody(body, time + 86400001)).toThrow('creation window');
  expect(() => validatePublishBody(body, time + 86400001, false)).not.toThrow();
  expect(() => validatePublishBody({ junk: 'x'.repeat(300 * 1024) }, time)).toThrow('300 KB');
});
it('intent digest excludes server clock/login and binds every intent field', async () => {
  const intent = {
    ...body,
    kind: 'push' as const,
    repo: 'owner/repo',
    dataBranch: 'data',
    liveBranch: 'live',
    requester: { id: 1, login: 'alice' },
  };
  const digest = await publishIntentDigest(intent);
  expect(await publishIntentDigest({ ...intent, requester: { id: 1, login: 'renamed' } })).toBe(
    digest,
  );
  for (const changed of [
    { repo: 'other/repo' },
    { dataBranch: 'other' },
    { liveBranch: 'other' },
    { requester: { id: 2, login: 'alice' } },
    { expected: { 123: 'b'.repeat(64) } },
    { opId: '01K95H00000000000000000002' },
    { hashes: [456] },
  ]) {
    expect(await publishIntentDigest({ ...intent, ...changed })).not.toBe(digest);
  }
  expect(
    classifyPublishIntent(
      digest,
      { intentDigest: digest },
      { intentDigest: digest, result: 'done' },
    ),
  ).toEqual({ status: 'complete', result: 'done' });
  expect(
    classifyPublishIntent(digest, undefined, { intentDigest: 'other', result: 'done' }),
  ).toEqual({ status: 'conflict' });
});

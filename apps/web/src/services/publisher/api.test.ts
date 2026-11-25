import { globalsInPlacePublishContract, translationPublishReasons } from '@clarity/core';
import { expect, it, vi } from 'vitest';
import { apiRequest } from '../api';
import { getPublishStatus, postPublish, postTranslations } from './api';

vi.mock('../api', () => ({ apiRequest: vi.fn() }));

it('keeps the switched contract on a tooltip-only request and checks its response identity', async () => {
  vi.mocked(apiRequest).mockResolvedValueOnce(
    Response.json({ opId: 'other', status: 'pending' }, { status: 202 }),
  );
  const body = { opId: 'op', hashes: [10], expected: { 10: 'digest' } };
  await expect(postPublish(body, true)).rejects.toMatchObject({ status: 502 });
  expect(apiRequest).toHaveBeenLastCalledWith(
    `/publish?contract=${globalsInPlacePublishContract}`,
    expect.objectContaining({ body: JSON.stringify(body) }),
  );
});

it('ignores receipt outcomes for a different selection', async () => {
  vi.mocked(apiRequest).mockResolvedValueOnce(
    Response.json({ opId: 'op', result: { status: 'done', globals: ['other'] } }),
  );
  const body = {
    opId: 'op',
    hashes: [],
    expected: {},
    globals: [{ id: 'selected', expected: 'digest' }],
  };
  await expect(postPublish(body)).resolves.toMatchObject({ status: 'done', globals: undefined });
});

it.each([
  ['ConsumerOutputRejected: Missing export Old', 'Missing export Old'],
  ['Requester revoked', undefined],
])('reads fail-closed refusals from a same-intent receipt (%s)', async (error, refusal) => {
  vi.mocked(apiRequest).mockResolvedValueOnce(
    Response.json({ opId: 'op', result: { status: 'rejected', error } }),
  );
  await expect(
    postPublish({ opId: 'op', hashes: [10], expected: { 10: 'digest' } }),
  ).resolves.toEqual(refusal ? { status: 'rejected', refusal } : { status: 'rejected' });
});

it('returns the named terminal reason for a changed selection', async () => {
  const reason = 'Saved text changed after review for Demo Perk.';
  vi.mocked(apiRequest).mockResolvedValueOnce(
    Response.json({
      opId: 'op',
      result: { status: 'rejected', code: 'selected-rows-changed', error: reason },
    }),
  );
  await expect(
    postPublish({ opId: 'op', hashes: [10], expected: { 10: 'digest' } }),
  ).resolves.toEqual({
    status: 'rejected',
    refusal: reason,
    regroupable: false,
  });
});

const translations = {
  opId: 'op',
  scope: 'translations' as const,
  rows: [],
};
it('reads a translators’ refusal by row, in the shared reason text only', async () => {
  const rows = [
    { kind: 'tooltip', hash: 10, lang: 'de', reason: 'english-pending', message: 'internal' },
    { kind: 'global', id: 'g_refill-0001', lang: 'de', reason: 'unknown-code' },
  ];
  const refused = [{ key: '10:de', error: translationPublishReasons['english-pending'] }];
  vi.mocked(apiRequest).mockResolvedValueOnce(
    Response.json({ opId: 'op', result: { status: 'rejected', rows } }),
  );
  await expect(postTranslations(translations)).resolves.toEqual({
    status: 'rejected',
    rows: refused,
  });
  expect(apiRequest).toHaveBeenLastCalledWith(
    '/publish?contract=translation-publish-v1',
    expect.objectContaining({ body: JSON.stringify(translations) }),
  );
  vi.mocked(apiRequest).mockResolvedValueOnce(
    Response.json({ error: 'Refused', details: { rows } }, { status: 409 }),
  );
  await expect(postTranslations(translations)).rejects.toMatchObject({
    status: 409,
    rows: refused,
  });
});

it('asks for a translators’ operation with its contract, and never adopts another one', async () => {
  vi.mocked(apiRequest).mockResolvedValueOnce(
    Response.json({ operations: [{ opId: 'op', status: 'unknown' }] }),
  );
  await expect(getPublishStatus('op', true)).resolves.toBe('unknown');
  expect(apiRequest).toHaveBeenLastCalledWith(
    '/publish/status?opId=op&contract=translation-publish-v1',
    expect.anything(),
  );
  vi.mocked(apiRequest).mockResolvedValueOnce(
    Response.json({ opId: 'other', status: 'pending' }, { status: 202 }),
  );
  await expect(postTranslations(translations)).rejects.toMatchObject({ status: 502 });
});

it.each([
  { status: 409, error: 'Tooltip 10 changed since review' },
  { status: 502, error: 'Upstream request failed' },
  { status: 409, error: 'Operation refused', details: { code: 'operation-refused' } },
])(
  'preserves Worker errors and optional retry details ($status $error)',
  async ({ status, error, details }) => {
    vi.mocked(apiRequest).mockResolvedValueOnce(
      Response.json(details ? { error, details } : { error }, { status }),
    );
    await expect(
      postPublish({ opId: 'op', hashes: [10], expected: { 10: 'digest' } }),
    ).rejects.toMatchObject({
      status,
      message: error,
      fromWorker: true,
      code: details?.code,
    });
  },
);

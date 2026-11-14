import { beforeEach, expect, it, vi } from 'vitest';
import { apiRequest } from './apiAuth';
import { getGlossary, postGlossary, GlossaryConflictError } from './glossary';
vi.mock('./apiAuth', async (original) => ({
  ...(await original<typeof import('./apiAuth')>()),
  apiRequest: vi.fn(),
}));
beforeEach(() => vi.resetAllMocks());
it('validates stored documents on the client, including the requested language', async () => {
  for (const glossary of [
    { v: 1, lang: 'fr', terms: {} },
    { v: 1, lang: 'de', terms: { jolt: { en: 'Jolt', term: 'Missing stamps' } } },
  ]) {
    vi.mocked(apiRequest).mockResolvedValueOnce(Response.json({ revision: null, glossary }));
    await expect(getGlossary('de')).rejects.toThrow();
  }
});
it('preserves structured conflicts for the form instead of retrying a write automatically', async () => {
  const head = {
    en: 'Jolt',
    term: 'Their term',
    updatedAt: '2026-11-14T00:00:00Z',
    updatedBy: 'alice',
  };
  vi.mocked(apiRequest).mockResolvedValueOnce(
    Response.json({ conflicts: [{ key: 'jolt', head }] }, { status: 409 }),
  );
  await expect(
    postGlossary('de', [{ key: 'jolt', base: null, next: { en: 'Jolt', term: 'Mine' } }]),
  ).rejects.toEqual(new GlossaryConflictError([{ key: 'jolt', head }]));
  expect(apiRequest).toHaveBeenCalledTimes(1);
});

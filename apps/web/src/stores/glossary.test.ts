import { beforeEach, expect, it, vi } from 'vitest';
import { useAuthStore } from './auth';
import { canEditGlossary, ensureGlossary, saveGlossary, useGlossaryStore } from './glossary';
import { getGlossary, postGlossary, GlossaryConflictError } from '../services/glossary';
import { sessionToken } from '../services/session';
vi.mock('../services/session', async (original) => ({
  ...(await original<typeof import('../services/session')>()),
  sessionToken: vi.fn(),
}));

vi.mock('../services/glossary', async (original) => ({
  ...(await original<typeof import('../services/glossary')>()),
  getGlossary: vi.fn(),
  postGlossary: vi.fn(),
}));
const empty = { revision: null, glossary: { v: 1 as const, lang: 'de' as const, terms: {} } };
const user = { id: 4, login: 'dan', role: 'translator' as const, languages: ['de' as const] };
const op = { key: 'jolt', base: null, next: { en: 'Jolt', term: 'Aufschrecken' } };
const flush = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(sessionToken).mockReturnValue('session');
  useAuthStore.setState({ user: null, token: null });
  useAuthStore.setState({ user, token: 'session' });
  vi.mocked(getGlossary).mockResolvedValue(empty);
  vi.mocked(postGlossary).mockResolvedValue(empty);
});
it('fetches once per language and session, and never for English or signed-out visitors', async () => {
  ensureGlossary('de');
  ensureGlossary('de');
  ensureGlossary('en');
  await flush();
  expect(getGlossary).toHaveBeenCalledTimes(1);
  useAuthStore.setState({ user: null, token: null });
  ensureGlossary('de');
  await flush();
  expect(getGlossary).toHaveBeenCalledTimes(1);
  expect(useGlossaryStore.getState().byLang).toEqual({});
});
it('permits explicit retries, and ignores an old session’s fetch response', async () => {
  vi.mocked(getGlossary).mockRejectedValueOnce(new Error('Offline'));
  ensureGlossary('de');
  await flush();
  expect(useGlossaryStore.getState().byLang.de?.error).toBe('Offline');
  ensureGlossary('de', true);
  await flush();
  expect(useGlossaryStore.getState().byLang.de?.remote).toEqual(empty);
  let resolve!: (remote: typeof empty) => void;
  vi.mocked(getGlossary).mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  ensureGlossary('de', true);
  await flush();
  useAuthStore.setState({ user: null, token: null });
  resolve(empty);
  await flush();
  expect(useGlossaryStore.getState().byLang).toEqual({});
});
it('mirrors assigned-language permissions, and rejects concurrent saves', async () => {
  expect(canEditGlossary('de')).toBe(true);
  expect(canEditGlossary('fr')).toBe(false);
  await expect(saveGlossary('fr', [op])).rejects.toThrow('cannot edit');
  ensureGlossary('de');
  await flush();
  let resolve!: (remote: typeof empty) => void;
  vi.mocked(postGlossary).mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const pending = saveGlossary('de', [op]);
  expect(useGlossaryStore.getState().byLang.de?.remote).toBe(empty);
  await expect(saveGlossary('de', [op])).rejects.toThrow('Wait');
  resolve(empty);
  await pending;
  expect(useGlossaryStore.getState().byLang.de?.pending).toBeUndefined();
});
it('refuses a save if the credential changed before the auth store refreshed', async () => {
  ensureGlossary('de');
  await flush();
  vi.mocked(sessionToken).mockReturnValue('other-account');
  await expect(saveGlossary('de', [op])).rejects.toThrow('sign-in changed');
  expect(postGlossary).not.toHaveBeenCalled();
});
it('clears loading and permits retry when the credential expires before auth refresh', async () => {
  let resolve!: (remote: typeof empty) => void;
  vi.mocked(getGlossary).mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  ensureGlossary('de');
  await flush();
  expect(useGlossaryStore.getState().byLang.de?.loading).toBe(true);
  vi.mocked(sessionToken).mockReturnValue(null);
  resolve(empty);
  await flush();
  expect(useGlossaryStore.getState().byLang.de?.loading).toBe(false);
  expect(useGlossaryStore.getState().byLang.de?.error).toContain('sign-in changed');
  vi.mocked(sessionToken).mockReturnValue('session');
  ensureGlossary('de');
  await flush();
  expect(getGlossary).toHaveBeenCalledTimes(2);
  expect(useGlossaryStore.getState().byLang.de?.remote).toEqual(empty);
});
it('preserves the committed list on save failure and conflict, and ignores sign-out responses', async () => {
  ensureGlossary('de');
  await flush();
  const error = new GlossaryConflictError([{ key: 'jolt', head: null }]);
  vi.mocked(postGlossary).mockRejectedValueOnce(error);
  await expect(saveGlossary('de', [op])).rejects.toBe(error);
  expect(useGlossaryStore.getState().byLang.de?.remote).toBe(empty);
  expect(useGlossaryStore.getState().byLang.de?.pending).not.toBe(true);
  let resolve!: (remote: typeof empty) => void;
  vi.mocked(postGlossary).mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const pending = saveGlossary('de', [op]);
  useAuthStore.setState({ user: null, token: null });
  resolve(empty);
  await expect(pending).rejects.toThrow('sign-in changed');
  expect(useGlossaryStore.getState().byLang).toEqual({});
});

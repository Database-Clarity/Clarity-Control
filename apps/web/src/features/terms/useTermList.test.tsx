// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { useTermList } from './useTermList';
import { useAuthStore } from '../../stores/auth';
import { useGlossaryStore } from '../../stores/glossary';
import { getGlossary } from '../../services/glossary';
import { sessionToken } from '../../services/session';

vi.mock('./names', () => ({ ensureNames: vi.fn(), useNamesStore: () => undefined }));
vi.mock('../../services/session', async (original) => ({
  ...(await original<typeof import('../../services/session')>()),
  sessionToken: vi.fn(),
}));
vi.mock('../../services/glossary', async (original) => ({
  ...(await original<typeof import('../../services/glossary')>()),
  getGlossary: vi.fn(),
}));

it('reloads the mounted glossary when the same account signs in with a new token', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const user = { id: 4, login: 'dan', role: 'translator' as const, languages: ['de' as const] };
  const remote = { revision: null, glossary: { v: 1 as const, lang: 'de' as const, terms: {} } };
  vi.mocked(sessionToken).mockReturnValue('token-1');
  vi.mocked(getGlossary).mockResolvedValue(remote);
  useAuthStore.setState({ user, token: 'token-1' });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const Probe = () => {
    useTermList('de', true);
    return null;
  };
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  try {
    await act(async () => {
      root.render(<Probe />);
      await flush();
    });
    expect(getGlossary).toHaveBeenCalledTimes(1);
    expect(useGlossaryStore.getState().byLang.de?.remote).toEqual(remote);
    await act(async () => {
      vi.mocked(sessionToken).mockReturnValue('token-2');
      useAuthStore.setState({ token: 'token-2' });
      await flush();
    });
    expect(useAuthStore.getState().user).toBe(user);
    expect(getGlossary).toHaveBeenCalledTimes(2);
    expect(useGlossaryStore.getState().byLang.de?.remote).toEqual(remote);
  } finally {
    act(() => root.unmount());
    host.remove();
    useAuthStore.setState({ user: null, token: null });
    vi.unstubAllGlobals();
    vi.resetAllMocks();
  }
});

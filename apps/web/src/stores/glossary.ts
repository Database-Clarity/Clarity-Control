import { create } from 'zustand';
import type { Lang } from '@clarity/core';
import { applyGlossary } from '../../../../packages/core/src/glossary/apply';
import {
  glossaryResponseSchema,
  getGlossary,
  postGlossary,
  type GlossaryResponse,
} from '../services/glossary';
import { errorMessage } from '../services/http';
import { useAuthStore } from './auth';
import { sessionToken } from '../services/session';
import type { GlossaryOp } from '../../../../packages/core/src/glossary/schema';

interface State {
  remote?: GlossaryResponse;
  loading?: boolean;
  pending?: boolean;
  pendingOps?: readonly GlossaryOp[];
  error?: string;
}
export const useGlossaryStore = create<{ byLang: Partial<Record<Lang, State>> }>(() => ({
  byLang: {},
}));
const update = (lang: Lang, state: State) =>
  useGlossaryStore.setState((store) => ({ byLang: { ...store.byLang, [lang]: state } }));
const requested = new Set<Lang>();
function sameSession(auth: ReturnType<typeof useAuthStore.getState>): boolean {
  try {
    const current = useAuthStore.getState();
    return (
      !!auth.token &&
      current.token === auth.token &&
      current.user === auth.user &&
      sessionToken() === auth.token
    );
  } catch {
    return false;
  }
}
const member = () =>
  ['maintainer', 'translator', 'editor', 'trial'].includes(
    useAuthStore.getState().user?.role ?? '',
  );
export const canEditGlossary = (lang: Lang) => {
  const user = useAuthStore.getState().user;
  return (
    lang !== 'en' &&
    (user?.role === 'maintainer' || (user?.role === 'translator' && user.languages?.includes(lang)))
  );
};

// Cache each language's last revision and document together; never trust it for authorization.
async function cache(lang: Lang, value?: GlossaryResponse): Promise<GlossaryResponse | undefined> {
  if (typeof indexedDB === 'undefined') return;
  let db: IDBDatabase | undefined;
  try {
    db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('clarity-glossary-v1', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('revisions');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const raw = await new Promise<unknown>((resolve, reject) => {
      const transaction = db!.transaction('revisions', value ? 'readwrite' : 'readonly');
      const store = transaction.objectStore('revisions');
      const request = value ? store.put(value, lang) : store.get(lang);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const result = glossaryResponseSchema.safeParse(raw);
    return result.success && result.data.glossary.lang === lang ? result.data : undefined;
  } catch {
    /* A blocked device cache must not prevent glossary use. */
  } finally {
    db?.close();
  }
}

export function ensureGlossary(lang: Lang, retry = false): void {
  if (lang === 'en' || !member() || (!retry && requested.has(lang))) return;
  const current = useGlossaryStore.getState().byLang[lang];
  if (current?.pending || current?.loading) return;
  const auth = useAuthStore.getState();
  if (!sameSession(auth)) return;
  requested.add(lang);
  const valid = () => sameSession(auth);
  const expired = () => {
    // Do not overwrite a new account's state; expose Retry while auth refresh catches up.
    const current = useAuthStore.getState();
    if (current.user !== auth.user || current.token !== auth.token) return;
    requested.delete(lang);
    update(lang, {
      ...useGlossaryStore.getState().byLang[lang],
      loading: false,
      error: 'Your sign-in changed. Sign in again, then retry the glossary.',
    });
  };
  update(lang, { ...useGlossaryStore.getState().byLang[lang], loading: true });
  void (async () => {
    const cached = await cache(lang);
    if (!valid()) {
      expired();
      return;
    }
    if (cached && !useGlossaryStore.getState().byLang[lang]?.remote)
      update(lang, { remote: cached, loading: true });
    try {
      const remote = await getGlossary(lang);
      if (!valid()) {
        expired();
        return;
      }
      update(lang, { remote });
      await cache(lang, remote);
    } catch (error) {
      if (!valid()) {
        expired();
        return;
      }
      if (valid())
        update(lang, {
          ...useGlossaryStore.getState().byLang[lang],
          loading: false,
          error: errorMessage(error),
        });
    }
  })();
}

export async function saveGlossary(lang: Lang, ops: GlossaryOp[]): Promise<void> {
  if (!canEditGlossary(lang)) throw new Error('You cannot edit this language’s glossary');
  const state = useGlossaryStore.getState().byLang[lang];
  if (!state?.remote || state.pending || state.loading)
    throw new Error('Wait for the glossary to finish loading');
  const auth = useAuthStore.getState();
  const valid = () => sameSession(auth);
  if (!valid()) throw new Error('Your sign-in changed; sign in again before saving');
  applyGlossary(state.remote.glossary, ops, new Date().toISOString(), auth.user!.login);
  // Keep the committed list stable while its anchored form saves; rebuilding marks would close it.
  update(lang, { ...state, pending: true, pendingOps: ops });
  try {
    const remote = await postGlossary(lang, ops);
    if (!valid()) throw new Error('Your sign-in changed during this save');
    update(lang, { remote });
    await cache(lang, remote);
  } catch (error) {
    if (valid()) update(lang, state);
    throw error;
  }
}

useAuthStore.subscribe((state, before) => {
  if (state.token === before.token && state.user === before.user) return;
  requested.clear();
  useGlossaryStore.setState({ byLang: {} });
});

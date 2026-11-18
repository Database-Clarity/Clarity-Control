import { createGlobalsService, type GlobalEntry } from '../services/globals';
import { createGlobalsHttpTransport, type GlobalsHttpTransport } from '../services/globalsHttp';
import { useAuthStore } from './auth';
import { useGlobalIdentities } from './globalIdentities';

let authGeneration = 0;

let session: {
  token: string | null;
  role: NonNullable<ReturnType<typeof useAuthStore.getState>['user']>['role'] | undefined;
  transport: GlobalsHttpTransport;
  service: ReturnType<typeof createGlobalsService>;
} | null = null;

/**
 * One authenticated service per session token, so its cache never outlives a sign-out. Called
 * while rendering, so it never updates a store; the identity index follows auth separately.
 */
export function globalsSession() {
  const { token, user } = useAuthStore.getState();
  const role = user?.role;
  const generation = authGeneration;
  if (session?.token !== token || session?.role !== role) {
    const transport = createGlobalsHttpTransport();
    session = {
      token,
      role,
      transport,
      // One configured publication destination (S4 contract v1); its sync header is the repository's.
      service: createGlobalsService(transport, {
        destinations: ['live'],
        lazyReviews: true,
        onCatalogPage(entries, complete) {
          const auth = useAuthStore.getState();
          if (authGeneration === generation && auth.token === token && auth.user?.role === role)
            rememberGlobalIdentities(entries, complete ? 'ready' : 'loading');
        },
      }),
    };
  }
  return session;
}

/** Records the live identities of an authoritative snapshot (catalogue order kept). */
export function rememberGlobalIdentities(
  entries: readonly GlobalEntry[],
  status: 'loading' | 'ready' = 'ready',
): void {
  useGlobalIdentities.setState({
    identities: Object.fromEntries(
      entries
        .filter((entry) => !entry.tombstone)
        .map((entry) => [
          entry.id,
          {
            kind: entry.kind,
            name: entry.name,
            definitions: Object.fromEntries(
              Object.entries(entry.definitions).map(([lang, value]) => [lang, value!.body]),
            ),
          },
        ]),
    ),
    status,
    error: '',
  });
}

let loading:
  | {
      token: string | null;
      role: NonNullable<ReturnType<typeof useAuthStore.getState>['user']>['role'];
      promise: Promise<void>;
    }
  | undefined;
useAuthStore.subscribe((state, previous) => {
  if (state.token !== previous.token || state.user?.role !== previous.user?.role) {
    authGeneration++;
    session = null;
    loading = undefined;
  }
});
/** Catalogue pages only (no review pages): enough to resolve names to stable IDs. */
export function loadGlobalIdentities(force = false): Promise<void> {
  const { token, user } = useAuthStore.getState();
  if (!user?.role) return Promise.resolve();
  const role = user.role;
  const generation = authGeneration;
  if (!force && useGlobalIdentities.getState().status === 'ready') return Promise.resolve();
  if (loading?.token === token && loading.role === role) return loading.promise;
  const current = () =>
    authGeneration === generation &&
    useAuthStore.getState().token === token &&
    useAuthStore.getState().user?.role === role;
  const promise = (async () => {
    const { service } = globalsSession();
    useGlobalIdentities.setState({ status: 'loading', error: '' });
    const result = await (force ? service.read() : service.readCatalog!());
    if (!current()) return;
    if (result.kind !== 'ok') {
      useGlobalIdentities.setState({ status: 'failed', error: result.message });
      return;
    }
    rememberGlobalIdentities(result.value.entries);
  })().finally(() => {
    if (loading?.promise === promise) loading = undefined;
  });
  loading = { token, role, promise };
  return promise;
}

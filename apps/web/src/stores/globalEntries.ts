import {
  createGlobalsService,
  type GlobalCatalog,
  type GlobalEntry,
  type GlobalResult,
  type GlobalSnapshot,
} from '../services/globals';
import { createGlobalsHttpTransport, type GlobalsHttpTransport } from '../services/globalsHttp';
import type { Bundle } from '../services/bundle';
import { useAuthStore } from './auth';
import { useDataStore } from './data';
import { useGlobalIdentities } from './globalIdentities';
import { applySavedGlobals, rememberSavedGlobal } from './savedOverlay';

let authGeneration = 0;

/** The editor data the tooltips load (one bundle fetch per tab); starts it if nothing has. */
function editorBundle(): Promise<Bundle | string> {
  const state = useDataStore.getState();
  if (state.data) return Promise.resolve(state.data.bundle);
  if (state.status !== 'loading') void state.load();
  return new Promise((resolve) => {
    const stop = useDataStore.subscribe((next) => {
      if (next.data) resolve(next.data.bundle);
      else if (next.status === 'error') resolve(next.error ?? 'Could not load editor data.');
      else return;
      stop();
    });
  });
}

/** The globals catalogue from the editor-data bundle, with this tab's saves on top. */
async function bundleCatalog(): Promise<GlobalResult<GlobalCatalog>> {
  const bundle = await editorBundle();
  if (typeof bundle === 'string') return { kind: 'retry', message: bundle };
  if (!bundle.globals)
    return { kind: 'retry', message: 'Sync pending: global metadata is incomplete' };
  return {
    kind: 'ok',
    value: {
      ...bundle.globals.sync,
      version: 1,
      head: bundle.sourceCommit,
      entries: applySavedGlobals(bundle, bundle.globals.entries),
    },
  };
}

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
    let catalogueRequest = 0;
    const current = () =>
      authGeneration === generation &&
      useAuthStore.getState().token === token &&
      useAuthStore.getState().user?.role === role;
    const service = createGlobalsService(transport, {
      destinations: ['live'],
      catalog: bundleCatalog,
      onCatalog(entries) {
        if (current()) rememberGlobalIdentities(entries);
      },
      onEntrySaved: (entry, head) => rememberSavedGlobal(entry, head),
    });
    const catalogueResult = async (
      pending: Promise<GlobalResult<GlobalSnapshot>>,
      request: number,
    ) => {
      let result: GlobalResult<GlobalSnapshot>;
      try {
        result = await pending;
      } catch (reason) {
        result = {
          kind: 'retry',
          message: reason instanceof Error ? reason.message : 'Could not load globals.',
        };
      }
      if (current() && request === catalogueRequest && result.kind !== 'ok')
        useGlobalIdentities.setState({ status: 'failed', error: result.message });
      return result;
    };
    session = {
      token,
      role,
      transport,
      // One configured publication destination (S4 contract v1); its sync header is the repository's.
      service: {
        ...service,
        read: () => catalogueResult(service.read(), ++catalogueRequest),
        readCatalog: () => catalogueResult(service.readCatalog!(), ++catalogueRequest),
      },
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

import { createGlobalsService, type GlobalEntry } from '../services/globals';
import { createGlobalsHttpTransport, type GlobalsHttpTransport } from '../services/globalsHttp';
import { useAuthStore } from './auth';
import { useGlobalIdentities } from './globalIdentities';

let session: {
  token: string | null;
  transport: GlobalsHttpTransport;
  service: ReturnType<typeof createGlobalsService>;
} | null = null;

/**
 * One authenticated service per session token, so its cache never outlives a sign-out. Called
 * while rendering, so it never updates a store; the identity index is repository data and stays.
 */
export function globalsSession() {
  const token = useAuthStore.getState().token;
  if (session?.token !== token) {
    const transport = createGlobalsHttpTransport();
    session = {
      token,
      transport,
      // One configured publication destination (S4 contract v1); its sync header is the repository's.
      service: createGlobalsService(transport, { destinations: ['live'] }),
    };
  }
  return session;
}

/** Records the live identities of an authoritative snapshot (catalogue order kept). */
export function rememberGlobalIdentities(entries: readonly GlobalEntry[]): void {
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
    status: 'ready',
    error: '',
  });
}

let loading: Promise<void> | undefined;
/** Catalogue pages only (no review pages): enough to resolve names to stable IDs. */
export function loadGlobalIdentities(force = false): Promise<void> {
  if (!force && useGlobalIdentities.getState().status === 'ready') return Promise.resolve();
  loading ??= (async () => {
    const { transport } = globalsSession();
    useGlobalIdentities.setState({ status: 'loading', error: '' });
    const entries: GlobalEntry[] = [];
    const seen = new Set<string>();
    let cursor: string | null = 'p0';
    while (cursor !== null) {
      if (!/^p\d{1,5}$/.test(cursor) || seen.has(cursor)) {
        useGlobalIdentities.setState({
          status: 'failed',
          error: 'Invalid global catalogue cursor.',
        });
        return;
      }
      seen.add(cursor);
      const page = await transport.list(cursor);
      if (page.kind !== 'ok') {
        useGlobalIdentities.setState({ status: 'failed', error: page.message });
        return;
      }
      entries.push(...page.value.entries);
      cursor = page.value.nextCursor;
    }
    rememberGlobalIdentities(entries);
  })().finally(() => {
    loading = undefined;
  });
  return loading;
}

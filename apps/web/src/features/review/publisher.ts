import { apiUrl } from '../../services/api';
import {
  getPublishStatus,
  getTranslationStatus,
  kickPublish,
  postPublish,
  postTranslations,
  PublishHttpError,
} from '../../services/publisher/api';
import { sessionToken } from '../../services/session';
import { publisherEnabled } from '../../services/publisher/flag';
import { createIndexedDbOpStore } from '../../services/publisher/opStore';
import { useAuthStore } from '../../stores/auth';
import { useDataStore } from '../../stores/data';
import { translationKey } from '../../services/translationPublish';
import {
  canPublishTranslations,
  canPushLive as canPush,
  publishLanguages,
} from '../auth/permissions';
import { PublishDriver, usePublishState } from './publishDriver';
import { useReviewSession } from './session';

const channelName = 'clarity-publisher';
const store = createIndexedDbOpStore();

/**
 * A request carries whatever session the browser holds when it is sent: only the settled one of the
 * account these operations belong to may send it (another tab may be signing in as someone else).
 */
function bound<A extends unknown[], R>(send: (...args: A) => Promise<R>) {
  return (...args: A): Promise<R> => {
    const { user, token, loading } = useAuthStore.getState();
    const settled = !loading && user && String(user.id) === usePublishState.getState().userId;
    return settled && token === currentToken()
      ? send(...args)
      : Promise.reject(new PublishHttpError(0, 'The sign-in is changing'));
  };
}
function currentToken(): string | null {
  try {
    return sessionToken();
  } catch {
    return null;
  }
}

/** The tab's publisher. Inert (never touches storage or the network) unless the flag is on. */
export const publishDriver = new PublishDriver({
  store,
  api: {
    post: bound(postPublish),
    postTranslations: bound(postTranslations),
    status: bound(getPublishStatus),
    translationStatus: bound(getTranslationStatus),
    kick: bound(kickPublish),
  },
  // Its assignments may have changed: the menu, the list, and the ticks follow.
  forbidden: () => void useAuthStore.getState().load(),
  now: () => Date.now(),
  setTimer: (run, ms) => setTimeout(run, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  visible: () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
  broadcast: () => channel?.postMessage('changed'),
  acknowledge(op) {
    useReviewSession.setState((state) => ({
      ...(op.translations
        ? {
            translations: {
              ...state.translations,
              ...Object.fromEntries(
                op.translations.map(({ row }) => [translationKey(row), row.expected]),
              ),
            },
          }
        : {}),
      ...(op.globals
        ? {
            globals: {
              ...state.globals,
              ...Object.fromEntries(
                op.globals
                  .filter(({ id }) => !op.refusedGlobals?.some((refused) => refused.id === id))
                  .map(({ id, expected }) => [id, expected]),
              ),
            },
          }
        : {}),
      acknowledgments: {
        ...state.acknowledgments,
        ...Object.fromEntries(
          op.hashes.map((hash) => [
            hash,
            {
              digest: op.markers?.[hash] ?? op.expected[hash]!,
              previous: op.previous[hash] ?? undefined,
            },
          ]),
        ),
      },
    }));
  },
});

let channel: BroadcastChannel | undefined;
let started = false;

/** Resumes stored operations on any page, follows sign-in/out and role changes, syncs other tabs. */
export function startPublisher(): void {
  if (started || !publisherEnabled() || !apiUrl) return;
  started = true;
  try {
    channel = new BroadcastChannel(channelName);
    channel.onmessage = () => void publishDriver.refresh();
  } catch {
    channel = undefined; // Tabs then sync on their own poll ticks.
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void publishDriver.refresh();
  });
  const observeBundle = (generatedAt: string | undefined) =>
    generatedAt
      ? store.observeBundle(Date.parse(generatedAt), Date.now()).catch(() => undefined)
      : undefined;
  useDataStore.subscribe((state, previous) => {
    const generatedAt = state.data?.bundle.generatedAt;
    const { user } = useAuthStore.getState();
    if (
      generatedAt !== previous.data?.bundle.generatedAt &&
      (canPush(user) || canPublishTranslations(user))
    )
      void observeBundle(generatedAt);
  });
  let key: string | null | undefined;
  const sync = () => {
    const { user, token } = useAuthStore.getState();
    // A new session token for the same account also restarts: paused (signed-out) sends resume.
    const translator = canPublishTranslations(user);
    const languages = translator ? publishLanguages(user) : undefined;
    // Other languages are another start: a request naming a lost one is never sent again.
    const next =
      canPush(user) || translator
        ? `${String(user!.id)}|${token ?? ''}${languages ? `|${languages.join()}` : ''}`
        : null;
    if (next === key) return;
    key = next;
    if (next) {
      void observeBundle(useDataStore.getState().data?.bundle.generatedAt);
      void publishDriver.start(String(user!.id), languages);
    } else publishDriver.stop();
  };
  useAuthStore.subscribe(sync);
  sync();
}

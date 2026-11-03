import { apiUrl } from '../../services/api';
import { kickPublish, getPublishStatus, postPublish } from '../../services/publisher/api';
import { publisherEnabled } from '../../services/publisher/flag';
import { createIndexedDbOpStore } from '../../services/publisher/opStore';
import { useAuthStore } from '../../stores/auth';
import { canPush } from './model';
import { PublishDriver } from './publishDriver';
import { useReviewSession } from './session';

const channelName = 'clarity-publisher';

/** The tab's publisher. Inert (never touches storage or the network) unless the flag is on. */
export const publishDriver = new PublishDriver({
  store: createIndexedDbOpStore(),
  api: { post: postPublish, status: getPublishStatus, kick: kickPublish },
  now: () => Date.now(),
  setTimer: (run, ms) => setTimeout(run, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  visible: () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
  broadcast: () => channel?.postMessage('changed'),
  acknowledge(op) {
    useReviewSession.setState((state) => ({
      acknowledgments: {
        ...state.acknowledgments,
        ...Object.fromEntries(
          op.hashes.map((hash) => [
            hash,
            { digest: op.expected[hash]!, previous: op.previous[hash] ?? undefined },
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
  let key: string | null | undefined;
  const sync = () => {
    const { user, token } = useAuthStore.getState();
    // A new session token for the same account also restarts: paused (signed-out) sends resume.
    const next = canPush(user) ? `${String(user!.id)}|${token ?? ''}` : null;
    if (next === key) return;
    key = next;
    if (next) void publishDriver.start(String(user!.id));
    else publishDriver.stop();
  };
  useAuthStore.subscribe(sync);
  sync();
}

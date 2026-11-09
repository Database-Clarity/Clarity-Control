import { z } from 'zod';
import { bucketPattern, maxMessageChars, parseSnapshot, type Snapshot } from './snapshot';

export const newOrigin = 'https://control.d2clarity.com';
/** Origins that may send a snapshot to the new site. */
export const senderOrigins: readonly string[] = ['https://database-clarity.github.io'];

const channel = 'clarity-migrate';
const base = { channel: z.literal(channel), version: z.literal(1) };
/** Receiver to sender: the page is open and listening. */
export const readyMessage = z.object({ ...base, type: z.literal('ready') });
/** Sender to receiver: the snapshot as JSON TEXT, so its size is checked before any parsing. */
export const snapshotMessage = z.object({
  ...base,
  type: z.literal('snapshot'),
  payload: z.string(),
});
/** Sender to receiver: nothing will be sent (for example, over the size cap). */
export const abortMessage = z.object({
  ...base,
  type: z.literal('abort'),
  reason: z.string().max(500),
});
/** Receiver to sender: what is now safely held on the new side; nothing is cleared before a click. */
export const doneMessage = z.object({
  ...base,
  type: z.literal('done'),
  stored: z.record(z.string().regex(bucketPattern), z.array(z.string().max(32)).max(100_000)),
  unplaced: z.number().int().min(0),
});
/** Receiver to sender: the user cancelled, or the data was refused. */
export const refusedMessage = z.object({
  ...base,
  type: z.literal('refused'),
  reason: z.string().max(500),
});

export const stamp = { channel, version: 1 } as const;

/** What `postMessage` needs from a window; narrow so tests can fake it. */
export interface PostTarget {
  postMessage(message: unknown, targetOrigin: string): void;
  closed?: boolean;
}
export interface MessageSource {
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
}

export interface ReceiverHandlers {
  /** A valid, in-cap snapshot from an allowed sender. */
  onSnapshot(snapshot: Snapshot): void;
  /** Something arrived from the allowed sender but cannot be used; show this to the user. */
  onRefused(message: string): void;
  /** The sender cancelled before sending. */
  onAbort(reason: string): void;
}

/**
 * The new site's end. Announces itself to the opener at each allowed origin (the browser delivers
 * it only to a window of exactly that origin), then accepts messages only from that opener window
 * AND an exactly matching origin. Everything else is ignored silently.
 */
export function startReceiver(
  source: MessageSource,
  opener: PostTarget | null,
  allowed: readonly string[],
  handlers: ReceiverHandlers,
  maxChars = maxMessageChars,
): { stop(): void; reply(message: unknown): void; announce(): void } {
  let from: string | null = null;
  const listener = (event: MessageEvent) => {
    if (!opener || event.source !== opener || !allowed.includes(event.origin)) return;
    from = event.origin;
    const data: unknown = event.data;
    const abort = abortMessage.safeParse(data);
    if (abort.success) return handlers.onAbort(abort.data.reason);
    const message = snapshotMessage.safeParse(data);
    if (!message.success) return;
    const parsed = parseSnapshot(message.data.payload, maxChars);
    if (!parsed.ok) {
      opener.postMessage({ ...stamp, type: 'refused', reason: parsed.message }, event.origin);
      return handlers.onRefused(parsed.message);
    }
    handlers.onSnapshot(parsed.snapshot);
  };
  source.addEventListener('message', listener);
  const announce = () => {
    if (opener && !opener.closed)
      for (const origin of allowed) opener.postMessage({ ...stamp, type: 'ready' }, origin);
  };
  announce();
  return {
    announce,
    stop: () => source.removeEventListener('message', listener),
    // Replies go only to the origin that actually sent us data, and never to a closed window.
    reply: (message) => {
      if (opener && !opener.closed && from !== null) opener.postMessage(message, from);
    },
  };
}

export interface SenderHandlers {
  onWaiting(): void;
  onSent(): void;
  onDone(stored: Record<string, string[]>, unplaced: number): void;
  onRefused(reason: string): void;
  onClosed(): void;
}

/**
 * The old site's end. `target` is the window opened by the user's click. It sends the snapshot
 * only after a `ready` from that window at exactly `destination`, and only to that origin.
 */
export function startSender(
  source: MessageSource,
  target: PostTarget,
  destination: string,
  payload: Promise<string>,
  handlers: SenderHandlers,
): { stop(): void; checkClosed(): boolean } {
  let sent = false;
  let finished = false;
  const listener = (event: MessageEvent) => {
    if (event.source !== target || event.origin !== destination || finished) return;
    const data: unknown = event.data;
    if (readyMessage.safeParse(data).success) {
      if (sent) return;
      sent = true;
      void payload.then(
        (text) => {
          target.postMessage({ ...stamp, type: 'snapshot', payload: text }, destination);
          handlers.onSent();
        },
        (error: unknown) => {
          const reason = error instanceof Error ? error.message : 'Could not prepare the drafts.';
          target.postMessage({ ...stamp, type: 'abort', reason }, destination);
          finished = true;
          handlers.onRefused(reason);
        },
      );
      return;
    }
    const done = doneMessage.safeParse(data);
    if (done.success) {
      finished = true;
      return handlers.onDone(done.data.stored, done.data.unplaced);
    }
    const refused = refusedMessage.safeParse(data);
    if (refused.success) {
      sent = false;
      handlers.onRefused(refused.data.reason);
    }
  };
  source.addEventListener('message', listener);
  handlers.onWaiting();
  return {
    stop: () => source.removeEventListener('message', listener),
    checkClosed: () => {
      if (target.closed && !finished) {
        finished = true;
        handlers.onClosed();
        return true;
      }
      return false;
    },
  };
}

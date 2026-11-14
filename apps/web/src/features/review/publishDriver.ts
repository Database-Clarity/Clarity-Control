import { create } from 'zustand';
import type { RemoteStatus } from '../../services/publisher/api';
import { PublishHttpError } from '../../services/publisher/api';
import { isTerminal, type OpStore, type PublishOp } from '../../services/publisher/opStore';
import { newOpId } from '../../services/publisher/ulid';

/** Timings from design §2/§3: poll cheaply, auto-kick once after 3 minutes, never hammer. */
export const publishTiming = {
  /** Status polling: fast while a run is likely starting, then slower. Per pending operation. */
  pollMs: (ageMs: number) =>
    ageMs < 30_000 ? 4_000 : ageMs < 180_000 ? 10_000 : ageMs < 1_800_000 ? 30_000 : 60_000,
  waitingMs: 180_000,
  autoKickMs: 180_000,
  manualKickGapMs: 30_000,
  /**
   * A Worker-reported 500/502 (its own JSON error, not an edge page) is resent this many times in
   * total; then, once the Worker confirms it holds no request for the opId, the operation fails
   * with the Worker's message instead of retrying forever.
   */
  workerErrorAttempts: 3,
  /** Resend backoff for an operation the Worker has not yet acknowledged. */
  sendBackoffMs: (attempt: number) => Math.min(60_000, 2_000 * 2 ** attempt),
  /** Another tab's attempt this recent is left alone. */
  foreignAttemptMs: 8_000,
  /** The Worker only creates requests whose opId time is within 24 h; stop resending before that. */
  sendExpiryMs: 23 * 3_600_000,
  /** Finished operations are kept (they back the acknowledgment overlay) for a day. */
  retainMs: 24 * 3_600_000,
  /** After a reload only operations this fresh rebuild acknowledgments (bundle lag is minutes). */
  ackWindowMs: 15 * 60_000,
  /** A pending operation older than this stops being polled; the line says to check live status. */
  pollGiveUpMs: 24 * 3_600_000,
  /** Worker caps (core publishRequest.ts): at most 3,000 hashes, body at most 300 KB. */
  maxHashes: 3000,
  /** Conservative local CPU measurement; deployed tail gate still required. */
  chunkHashes: 50,
  maxBodyBytes: 300 * 1024,
} as const;

export interface PublishApi {
  post(body: {
    opId: string;
    hashes: number[];
    expected: Record<string, string>;
  }): Promise<{ status: 'pending' } | { status: RemoteStatus }>;
  status(opId: string): Promise<RemoteStatus | 'unknown'>;
  kick(opId: string): Promise<void>;
}

export interface DriverDeps {
  store: OpStore;
  api: PublishApi;
  now(): number;
  setTimer(run: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** Polling and resends pause while the tab is hidden. */
  visible(): boolean;
  /** Tells other tabs the store changed. */
  broadcast(): void;
  /** A publish finished with `done`/`unchanged`: mark its hashes pushed in the review overlay. */
  acknowledge(op: PublishOp): void;
}

export interface PublishState {
  userId: string | null;
  hydrated: boolean;
  /** This account's operations, oldest first; dismissed ones are omitted. */
  ops: PublishOp[];
  /** Transient, tab-local reason an operation is not progressing ("offline, retrying"). */
  notes: Record<string, string>;
  storageError: string | undefined;
}

export const usePublishState = create<PublishState>(() => ({
  userId: null,
  hydrated: false,
  ops: [],
  notes: {},
  storageError: undefined,
}));

export interface PublishInput {
  hash: number;
  digest: string;
  previous: string | undefined;
}

/** Hashes covered by an operation that is still queued or being sent. */
export function activeHashes(ops: readonly PublishOp[]): Set<number> {
  return new Set(ops.filter((op) => !isTerminal(op.status)).flatMap((op) => op.hashes));
}

export class PublishDriver {
  private userId: string | null = null;
  private timer: unknown;
  private running = false;
  private again = false;
  private generation = 0;
  private readonly attempts = new Map<string, { count: number; at: number }>();
  private readonly paused = new Set<string>();
  private readonly acknowledged = new Set<string>();
  private readonly inFlight = new Set<string>();

  constructor(private readonly deps: DriverDeps) {}

  /** Switch to an account (or null). Resumes that account's stored operations. */
  async start(userId: string | null): Promise<void> {
    this.stopTimer();
    const generation = ++this.generation;
    this.userId = userId;
    this.paused.clear();
    this.attempts.clear();
    this.inFlight.clear();
    this.running = false;
    usePublishState.setState({
      userId,
      hydrated: false,
      ops: [],
      notes: {},
      storageError: undefined,
    });
    if (!userId) return;
    await this.reload(generation, true);
    if (generation !== this.generation) return;
    usePublishState.setState({ hydrated: true });
    await this.tick();
  }

  stop() {
    this.generation++;
    this.userId = null;
    this.running = false;
    this.stopTimer();
    usePublishState.setState({ userId: null, hydrated: false, ops: [], notes: {} });
  }

  /** Re-read storage (another tab may have changed it) and act on anything due. */
  async refresh(): Promise<void> {
    if (!this.userId) return;
    await this.tick();
  }

  /**
   * Persist, then send. The record exists in storage before any request leaves, so a reload or a
   * lost 202 can only ever resend this exact opId and body. Rejects if storage is unavailable.
   */
  async create(inputs: PublishInput[]): Promise<PublishOp> {
    const userId = this.userId;
    const generation = this.generation;
    if (!userId) throw new Error('Sign in to publish.');
    if (!inputs.length) throw new Error('Nothing to publish.');
    if (inputs.length > publishTiming.maxHashes)
      throw new Error(
        `Too many tooltips for one publish (${inputs.length}; the limit is ${publishTiming.maxHashes}). Select fewer and publish in several steps. Nothing was sent.`,
      );
    const now = this.deps.now();
    const sorted = [...inputs].sort((a, b) => a.hash - b.hash);
    const groupId = newOpId(now);
    const chunks: PublishOp[] = [];
    for (let offset = 0; offset < sorted.length; offset += publishTiming.chunkHashes) {
      const chunk = sorted.slice(offset, offset + publishTiming.chunkHashes);
      const op: PublishOp = {
        opId: offset === 0 ? groupId : newOpId(now),
        ...(sorted.length > publishTiming.chunkHashes
          ? { groupId, groupSize: Math.ceil(sorted.length / publishTiming.chunkHashes) }
          : {}),
        userId,
        createdAt: now,
        hashes: chunk.map((input) => input.hash),
        expected: Object.fromEntries(chunk.map((input) => [input.hash, input.digest])),
        previous: Object.fromEntries(chunk.map((input) => [input.hash, input.previous ?? null])),
        status: 'created',
        updatedAt: now,
      };
      const bodyBytes = new TextEncoder().encode(
        JSON.stringify({ opId: op.opId, hashes: op.hashes, expected: op.expected }),
      ).length;
      if (bodyBytes > publishTiming.maxBodyBytes)
        throw new Error('This publish is too large to send. Nothing was sent.');
      chunks.push(op);
    }
    try {
      if (chunks.length === 1) await this.deps.store.add(chunks[0]!);
      else await this.deps.store.addMany(chunks);
    } catch (reason) {
      const detail = reason instanceof Error ? reason.message : 'unknown error';
      throw new Error(
        `Publishing needs browser storage, which is unavailable (${detail}). Nothing was sent.`,
      );
    }
    if (generation !== this.generation) return chunks[0]!;
    usePublishState.setState((state) => ({ ops: [...state.ops, ...chunks] }));
    this.deps.broadcast();
    // Send in sequence to avoid a burst of CAS collisions between our own chunks.
    void this.sendChunks(chunks);
    return chunks[0]!;
  }

  private async sendChunks(chunks: PublishOp[]) {
    const generation = this.generation;
    for (const op of chunks) {
      if (generation !== this.generation) return;
      await this.send(op.opId);
    }
  }

  async dismiss(opId: string): Promise<void> {
    const op = this.current(opId);
    if (!op || !isTerminal(op.status)) return;
    await this.deps.store.update(opId, (current) => ({ ...current, dismissed: true }));
    usePublishState.setState((state) => ({
      ops: state.ops.filter((entry) => entry.opId !== opId),
    }));
    this.deps.broadcast();
  }

  /** Manual Retry: kick one waiting operation. One pipeline run drains the whole queue. */
  async kickWaiting(opId: string): Promise<void> {
    const claimed = await this.claim(opId, (op, now) =>
      isTerminal(op.status) ||
      (op.kickedAt !== undefined && now - op.kickedAt < publishTiming.manualKickGapMs)
        ? undefined
        : { ...op, kickedAt: now },
    );
    if (claimed) await this.kick(opId);
  }

  /** Retry for a request someone else queued (seen in the bundle): nothing local to claim, so tab-local gap. */
  async kickRemote(opId: string): Promise<void> {
    const now = this.deps.now();
    if (!this.userId || now - this.lastRemoteKick < publishTiming.manualKickGapMs) return;
    this.lastRemoteKick = now;
    await this.deps.api.kick(opId).catch(() => undefined);
  }

  // ---- internals ----

  private lastRemoteKick = -Infinity;

  private async reload(generation: number, first = false) {
    let stored: PublishOp[];
    try {
      stored = await this.deps.store.list(this.userId!);
    } catch (reason) {
      if (generation !== this.generation) return;
      const detail = reason instanceof Error ? reason.message : 'unknown error';
      usePublishState.setState({ storageError: `Publish storage is unavailable: ${detail}` });
      return;
    }
    if (generation !== this.generation) return;
    const now = this.deps.now();
    const liveGroups = new Set(
      stored.filter((op) => !isTerminal(op.status)).map((op) => op.groupId ?? op.opId),
    );
    const expired = stored.filter(
      (op) =>
        !liveGroups.has(op.groupId ?? op.opId) &&
        isTerminal(op.status) &&
        stored
          .filter((entry) => (entry.groupId ?? entry.opId) === (op.groupId ?? op.opId))
          .every((entry) => now - entry.updatedAt > publishTiming.retainMs),
    );
    if (expired.length) {
      await this.deps.store.remove(expired.map((op) => op.opId)).catch(() => undefined);
      if (generation !== this.generation) return;
    }
    const kept = stored.filter((op) => !expired.includes(op)).sort(byAge);
    for (const op of kept) {
      // Acknowledgments are tab memory, so rebuild them from finished operations after a reload.
      // Each finished operation is acknowledged exactly once per tab, so a bundle that has caught
      // up (which retires an acknowledgment) is never overridden again.
      if (!this.acknowledged.has(op.opId) && (op.status === 'done' || op.status === 'unchanged')) {
        this.acknowledged.add(op.opId);
        if ((first || !op.dismissed) && now - op.updatedAt <= publishTiming.ackWindowMs)
          this.deps.acknowledge(op);
      }
    }
    usePublishState.setState({ ops: kept.filter((op) => !op.dismissed), storageError: undefined });
  }

  private stopTimer() {
    if (this.timer !== undefined) this.deps.clearTimer(this.timer);
    this.timer = undefined;
  }

  /** Atomic across tabs: `change` runs inside the storage transaction and decides who wins. */
  private async claim(
    opId: string,
    change: (op: PublishOp, now: number) => PublishOp | undefined,
  ): Promise<boolean> {
    const now = this.deps.now();
    let won = false;
    try {
      await this.deps.store.update(opId, (op) => {
        const next = change(op, now);
        won = next !== undefined;
        return next;
      });
    } catch {
      return false;
    }
    return won;
  }

  /** One pass: sync from storage, then do whatever is due. Serialized; a request mid-pass reruns it. */
  async tick(): Promise<void> {
    if (!this.userId) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    const generation = this.generation;
    try {
      do {
        this.again = false;
        await this.reload(generation);
        if (generation !== this.generation) return;
        await this.work(generation);
      } while (this.again && generation === this.generation);
    } finally {
      if (generation === this.generation) this.running = false;
    }
    if (generation === this.generation) this.schedule();
  }

  private async work(generation: number) {
    if (!this.deps.visible()) return;
    for (const op of [...usePublishState.getState().ops]) {
      if (generation !== this.generation) return;
      if (this.paused.has(op.opId)) continue;
      const now = this.deps.now();
      if (op.status === 'created') {
        const retry = this.attempts.get(op.opId);
        const due = retry ? retry.at : (op.polledAt ?? 0) + publishTiming.foreignAttemptMs;
        if (due <= now) await this.send(op.opId);
      } else if (op.status === 'pending') {
        const accepted = op.acceptedAt ?? op.createdAt;
        if (now - accepted > publishTiming.pollGiveUpMs) {
          this.note(
            op.opId,
            'Still waiting after 24 hours. Check live status; this is no longer polled.',
          );
          continue;
        }
        const gap = publishTiming.pollMs(now - accepted) * 0.8;
        const polled = await this.claim(op.opId, (current, at) =>
          current.polledAt !== undefined && at - current.polledAt < gap
            ? undefined
            : { ...current, polledAt: at },
        );
        if (polled) await this.poll(op.opId);
        if (now - accepted >= publishTiming.autoKickMs) {
          const kicked = await this.claim(op.opId, (current, at) =>
            current.autoKicked || isTerminal(current.status)
              ? undefined
              : { ...current, autoKicked: true, kickedAt: at },
          );
          if (kicked) await this.kick(op.opId);
        }
      }
    }
  }

  private schedule() {
    this.stopTimer();
    if (!this.userId || !this.deps.visible()) return;
    const now = this.deps.now();
    let next = Infinity;
    for (const op of usePublishState.getState().ops) {
      if (isTerminal(op.status) || this.paused.has(op.opId) || this.inFlight.has(op.opId)) continue;
      if (
        op.status === 'pending' &&
        now - (op.acceptedAt ?? op.createdAt) > publishTiming.pollGiveUpMs
      )
        continue;
      if (op.status === 'created') {
        const retry = this.attempts.get(op.opId);
        next = Math.min(
          next,
          retry ? retry.at : (op.polledAt ?? 0) + publishTiming.foreignAttemptMs,
        );
      } else {
        const accepted = op.acceptedAt ?? op.createdAt;
        next = Math.min(
          next,
          (op.polledAt ?? 0) + publishTiming.pollMs(now - accepted),
          op.autoKicked ? Infinity : accepted + publishTiming.autoKickMs,
        );
      }
    }
    if (next === Infinity) return;
    const generation = this.generation;
    this.timer = this.deps.setTimer(
      () => {
        this.timer = undefined;
        if (generation === this.generation) void this.tick();
      },
      Math.max(500, next - now),
    );
  }

  private note(opId: string, text: string | undefined) {
    usePublishState.setState((state) => {
      if (state.notes[opId] === text) return state;
      const notes = { ...state.notes };
      if (text === undefined) delete notes[opId];
      else notes[opId] = text;
      return { notes };
    });
  }

  /** Persist a status change, mirror it into state, and acknowledge a successful finish. */
  private async settle(opId: string, patch: Partial<PublishOp>) {
    const stored = await this.deps.store
      .update(opId, (op) => ({ ...op, ...patch, updatedAt: this.deps.now() }))
      .catch(() => undefined);
    if (!stored) return;
    this.note(opId, undefined);
    usePublishState.setState((state) => ({
      ops: state.ops.map((op) => (op.opId === opId ? stored : op)),
    }));
    if (
      (stored.status === 'done' || stored.status === 'unchanged') &&
      !this.acknowledged.has(opId)
    ) {
      this.acknowledged.add(opId);
      this.deps.acknowledge(stored);
    }
    this.deps.broadcast();
  }

  private adopt(opId: string, remote: RemoteStatus) {
    const op = this.current(opId);
    return this.settle(opId, {
      status: remote,
      acceptedAt: op?.acceptedAt ?? this.deps.now(),
    });
  }

  private current(opId: string) {
    return usePublishState.getState().ops.find((op) => op.opId === opId);
  }

  /** POST the stored body. Re-sending is always safe: the Worker is idempotent per opId. */
  private async send(opId: string) {
    const op = this.current(opId);
    if (!op || this.inFlight.has(opId) || isTerminal(op.status)) return;
    const generation = this.generation;
    this.inFlight.add(opId);
    try {
      const now = this.deps.now();
      if (op.status === 'created' && now - op.createdAt > publishTiming.sendExpiryMs) {
        // The window for (re)creating the request has closed, but the Worker may already hold it (a
        // lost 202). Only the Worker's own answer can say so: never infer non-delivery from age.
        let remote: RemoteStatus | 'unknown';
        try {
          remote = await this.deps.api.status(opId);
        } catch {
          this.attempts.set(opId, { count: 9, at: now + publishTiming.sendBackoffMs(9) });
          this.note(
            opId,
            'Could not confirm with the Worker whether this was received; checking again.',
          );
          return;
        }
        if (generation !== this.generation) return;
        if (remote === 'unknown')
          await this.settle(opId, {
            status: 'failed',
            error:
              'The Worker has no record of this publish and it is too old to send. Publish again.',
          });
        else await this.adopt(opId, remote);
        return;
      }
      await this.deps.store
        .update(opId, (current) => ({ ...current, polledAt: now }))
        .catch(() => undefined);
      let result: Awaited<ReturnType<PublishApi['post']>>;
      try {
        result = await this.deps.api.post({ opId, hashes: op.hashes, expected: op.expected });
      } catch (reason) {
        if (generation === this.generation) await this.sendFailed(op, reason);
        return;
      }
      if (generation !== this.generation) return;
      this.attempts.delete(opId);
      await this.adopt(opId, result.status);
    } finally {
      this.inFlight.delete(opId);
      // A send outside a tick (create, resend) still needs its follow-up poll/retry scheduled.
      if (generation === this.generation && !this.running) this.schedule();
    }
  }

  private async sendFailed(op: PublishOp, reason: unknown) {
    const status = reason instanceof PublishHttpError ? reason.status : 0;
    const message = reason instanceof Error ? reason.message : 'Unknown error';
    if (status === 401) {
      this.paused.add(op.opId);
      this.note(op.opId, 'Sign in again to continue; nothing is lost.');
      return;
    }
    if (status === 403) {
      await this.settle(op.opId, {
        status: 'failed',
        error:
          'The Worker refused this account (HTTP 403), so this tab cannot follow the publish. If it was already queued it may still run; check live status before publishing again.',
      });
      return;
    }
    if (status === 409) {
      await this.settle(op.opId, {
        status: 'failed',
        error: 'This publish id was already used with different contents. Publish again.',
      });
      return;
    }
    if (status === 400) {
      // Never a new opId: ask the Worker whether it knows this one.
      try {
        const remote = await this.deps.api.status(op.opId);
        if (remote !== 'unknown') return void (await this.adopt(op.opId, remote));
      } catch {
        // The Worker really did reject the body; report that below.
      }
      await this.settle(op.opId, {
        status: 'failed',
        error: /creation window/i.test(message)
          ? 'The Worker rejected this publish because its time is outside the allowed window. Check your device clock, then publish again.'
          : `The Worker rejected this publish (${message.slice(0, 120)}). Publish again.`,
      });
      return;
    }
    if (status === 413) {
      await this.settle(op.opId, {
        status: 'failed',
        error: 'This publish is too large for the Worker. Select fewer tooltips and publish again.',
      });
      return;
    }
    if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
      await this.settle(op.opId, {
        status: 'failed',
        error: `The Worker rejected this publish (HTTP ${status}). Publish again.`,
      });
      return;
    }
    // Offline, timeout, 5xx, 429: unresolved. Keep the record and resend the same opId and body.
    const count = (this.attempts.get(op.opId)?.count ?? 0) + 1;
    this.attempts.set(op.opId, {
      count,
      at: this.deps.now() + publishTiming.sendBackoffMs(count - 1),
    });
    // The Worker's own 500/502 names a failure a resend will not fix by itself (a broken read, bad
    // stored data). 503 is its "retry the same opId" answer; edge pages carry no Worker message.
    const workerError =
      (status === 500 || status === 502) && reason instanceof PublishHttpError && reason.fromWorker;
    if (workerError && count >= publishTiming.workerErrorAttempts) {
      // A create may have landed during an earlier attempt: only the Worker's "unknown" settles it.
      let remote: RemoteStatus | 'unknown' | undefined;
      try {
        remote = await this.deps.api.status(op.opId);
      } catch {
        remote = undefined;
      }
      if (remote !== undefined && remote !== 'unknown')
        return void (await this.adopt(op.opId, remote));
      if (remote === 'unknown') {
        await this.settle(op.opId, {
          status: 'failed',
          error: `The Worker could not take this publish (HTTP ${status}: ${message.slice(0, 160)}). Nothing was queued. Publish again later, or report this error.`,
        });
        return;
      }
    }
    this.note(
      op.opId,
      status === 0
        ? 'Offline; retrying.'
        : workerError
          ? `Worker error (HTTP ${status}: ${message.slice(0, 160)}); retrying.`
          : `Worker busy (HTTP ${status}); retrying.`,
    );
  }

  private async poll(opId: string) {
    const generation = this.generation;
    let remote: RemoteStatus | 'unknown';
    try {
      remote = await this.deps.api.status(opId);
    } catch (reason) {
      if (generation !== this.generation) return;
      const status = reason instanceof PublishHttpError ? reason.status : 0;
      if (status === 401) {
        this.paused.add(opId);
        this.note(opId, 'Sign in again to check progress.');
      } else {
        this.note(
          opId,
          status === 0 ? 'Offline; checking again soon.' : `Status check failed (HTTP ${status}).`,
        );
      }
      return;
    }
    if (generation !== this.generation) return;
    if (remote === 'unknown') {
      // The 202 may never have landed: resend the same body (idempotent).
      await this.send(opId);
      return;
    }
    if (remote === 'pending') {
      this.note(opId, undefined);
      return;
    }
    await this.adopt(opId, remote);
  }

  private async kick(opId: string) {
    const generation = this.generation;
    try {
      await this.deps.api.kick(opId);
      if (generation === this.generation) this.note(opId, undefined);
    } catch (reason) {
      if (generation !== this.generation) return;
      const status = reason instanceof PublishHttpError ? reason.status : 0;
      // 409 = no longer pending: it finished meanwhile. Check right away.
      if (status === 409) await this.poll(opId);
      else
        this.note(
          opId,
          status === 0 ? 'Could not reach the Worker to retry.' : `Retry failed (HTTP ${status}).`,
        );
    }
  }
}

function byAge(a: PublishOp, b: PublishOp) {
  return a.createdAt - b.createdAt || a.opId.localeCompare(b.opId);
}

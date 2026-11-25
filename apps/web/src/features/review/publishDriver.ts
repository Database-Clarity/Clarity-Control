import { create } from 'zustand';
import { dependencyChunks } from '../../services/dependencyChunks';
import type { TranslationPublishBody, TranslationPublishRow } from '@clarity/core';
import type {
  PublishAnswer,
  PublishBody,
  RefusedRow,
  RemoteStatus,
} from '../../services/publisher/api';
import { PublishHttpError, publishBody, translationBody } from '../../services/publisher/api';
import { translationKey } from '../../services/translationPublish';
import { isTerminal, type OpStore, type PublishOp } from '../../services/publisher/opStore';
import { newOpId } from '../../services/publisher/ulid';

/** Poll cheaply and recover a stalled trigger without sending a kick for each part. */
export const publishTiming = {
  /** Status polling: fast while a run is likely starting, then slower. Per pending operation. */
  pollMs: (ageMs: number) =>
    ageMs < 30_000 ? 4_000 : ageMs < 180_000 ? 10_000 : ageMs < 1_800_000 ? 30_000 : 60_000,
  waitingMs: 180_000,
  autoKickMs: 5 * 60_000,
  autoKickGapMs: 10 * 60_000,
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
  /** Conservative local CPU measurement; deployed tail gate still required. */
  chunkHashes: 50,
  /** Same ceiling as maxPublicationConsumers in the Worker globals reader. */
  maxConsumers: 500,
  maxBodyBytes: 300 * 1024,
} as const;

export interface PublishApi {
  post(body: PublishBody, switched?: true): Promise<PublishAnswer>;
  postTranslations(body: TranslationPublishBody): Promise<PublishAnswer>;
  status(opId: string): Promise<RemoteStatus | 'unknown'>;
  /** A translators' operation, with the reason of each row that refused it. */
  translationStatus(opId: string): Promise<PublishAnswer | { status: 'unknown' }>;
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
  /** The Worker refused this account: its languages may have changed. */
  forbidden?(): void;
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
  /** Publication proofs required by this row, one per stored language or removal. */
  consumers?: number;
  /** An Inactive decision that removes this row or one of its stubs. */
  removal?: boolean;
  /** Reviewed imports and live readers that must publish ahead of a removal. */
  dependencies?: readonly number[];
}

export const publishingAlready =
  'Some of these tooltips are already being published. Nothing was sent; review the list and publish again.';

export class PublishClosureLimitError extends Error {
  constructor(readonly groups: { hashes: number[]; consumers: number }[]) {
    super(
      `Review cannot safely split these changes into separate requests. The publisher allows ${publishTiming.maxConsumers} tooltip languages per request.`,
    );
  }
}

/** Prefer one request per closure. Split larger closures in dependency order, keeping cycles. */
export function publishChunks<T extends Omit<PublishInput, 'digest'>>(inputs: readonly T[]): T[][] {
  const consumers = (items: readonly T[]) =>
    items.reduce((total, item) => total + (item.consumers ?? 1), 0);
  const hasRemoval = inputs.some(({ removal }) => removal);
  const chunks = dependencyChunks(inputs, {
    fits: (items) =>
      items.length <= publishTiming.chunkHashes && consumers(items) <= publishTiming.maxConsumers,
    splitDependencies: (items) => hasRemoval || consumers(items) > publishTiming.maxConsumers,
    // Prefer publishing repairs ahead of removals when either order is valid.
    order: (a, b) => Number(!!a.removal) - Number(!!b.removal) || a.hash - b.hash,
    missing: (hash) => `Select pending imported tooltip ${hash} as well. Nothing was sent.`,
    duplicate: 'Duplicate publish hash. Nothing was sent.',
  });
  const oversized = chunks.flatMap((chunk) => {
    const count = consumers(chunk);
    return count > publishTiming.maxConsumers
      ? [{ hashes: chunk.map(({ hash }) => hash), consumers: count }]
      : [];
  });
  if (oversized.length) throw new PublishClosureLimitError(oversized);
  return chunks;
}

/**
 * Hashes covered by an operation that is still queued or being sent. A group that is recovering
 * from a refusal holds every one of its rows until it can no longer recover, never part of it.
 */
export const activeHashes = (ops: readonly PublishOp[]): Set<number> =>
  new Set(heldOps(ops).flatMap((op) => op.hashes));
/** Globals covered likewise, by id. */
export const activeGlobals = (ops: readonly PublishOp[]): Set<string> =>
  new Set(heldOps(ops).flatMap((op) => op.globals?.map(({ id }) => id) ?? []));

/** Translators' rows covered likewise, by key; a refused request holds the rows it sends again. */
export const activeTranslations = (ops: readonly PublishOp[], now = Date.now()): Set<string> =>
  new Set(
    ops.flatMap((op) =>
      (isTerminal(op.status) ? owedRows(op, ops, now) : (op.translations ?? [])).map(({ row }) =>
        translationKey(row),
      ),
    ),
  );

/** The rows a refused request still sends again; past the window they are free to review again. */
export const owedRows = (op: PublishOp, ops: readonly PublishOp[], now: number) =>
  op.released || now - op.updatedAt > publishTiming.ackWindowMs ? [] : remainder(op, ops);

/** The rows of a refused request that were not refused themselves and were not sent again. */
export function remainder(op: PublishOp, ops: readonly PublishOp[]) {
  if (!op.translations || !op.refusedRows?.length || op.dismissed) return [];
  if (ops.some(({ resends }) => resends === op.opId)) return [];
  const refused = new Set(op.refusedRows.map(({ key }) => key));
  return op.translations.filter(({ row }) => !refused.has(translationKey(row)));
}

function heldOps(ops: readonly PublishOp[]): PublishOp[] {
  const groups = new Map<string, PublishOp[]>();
  for (const op of ops)
    if (op.groupId) groups.set(op.groupId, [...(groups.get(op.groupId) ?? []), op]);
  const held = ops.filter((op) => !isTerminal(op.status) || needsPublishReceipt(op));
  for (const members of groups.values()) if (recovering(members)) held.push(...members);
  return held;
}

/** A group with an unread receipt, or with a refusal that it can still combine and resend. */
export function recovering(members: readonly PublishOp[]): boolean {
  return (
    members.some(needsPublishReceipt) ||
    (members.some((op) => op.refusal !== undefined) &&
      (members.some((op) => !isTerminal(op.status)) || regroupRefusals(members).length > 0))
  );
}

/** An older open tab can persist a rejection from the status projection alone. */
export function needsPublishReceipt(op: PublishOp): boolean {
  return op.status === 'rejected' && !op.receiptChecked && op.refusal === undefined;
}

/** Keep successful requests and greedily combine only the latest round's refused parts in order. */
export function regroupRefusals(members: readonly PublishOp[]): PublishOp[][] {
  const expected = members[0]?.groupHashCount;
  if (
    expected === undefined ||
    members.some((op) => !isTerminal(op.status) || needsPublishReceipt(op)) ||
    members.reduce((count, op) => count + op.hashes.length, 0) !== expected
  )
    return [];
  const round = Math.max(...members.map((op) => op.round ?? 0));
  const latest = members.filter((op) => op.round === round).sort(byAge);
  const refused = latest.filter(
    (op) => op.status === 'rejected' && op.refusal !== undefined && op.regroupable !== false,
  );
  const parts: PublishOp[][] = [];
  let weight = 0;
  for (const op of refused) {
    if (!parts.length || weight + op.consumers! > publishTiming.maxConsumers) {
      parts.push([]);
      weight = 0;
    }
    parts.at(-1)!.push(op);
    weight += op.consumers!;
  }
  // Combining reduces the number of requests left. A successful part can also have repaired a
  // prerequisite, so give the refused selection another chance even if it already fills a request.
  return parts.length < refused.length ||
    latest.some((op) => op.status === 'done' || op.status === 'unchanged')
    ? parts
    : [];
}

/** Receipt reads back off like status polls, by age since the rejection was recorded. */
const receiptDue = (op: PublishOp) =>
  op.polledAt === undefined ? 0 : op.polledAt + publishTiming.pollMs(op.polledAt - op.updatedAt);

export class PublishDriver {
  private userId: string | null = null;
  /** A translator's assigned languages; undefined for an editor's whole publishes. */
  private languages: ReadonlySet<string> | undefined;
  /** Includes dismissed group predecessors; their acceptance still orders unsent chunks. */
  private storedOps: PublishOp[] = [];
  private timer: unknown;
  private running = false;
  private again = false;
  private generation = 0;
  private readonly attempts = new Map<string, { count: number; at: number }>();
  private readonly paused = new Set<string>();
  private readonly acknowledged = new Set<string>();
  private readonly inFlight = new Set<string>();

  constructor(private readonly deps: DriverDeps) {}

  /**
   * Switch to an account (or null). Resumes that account's stored operations: a translator's own
   * rows, or an editor's whole publishes, never those of a role the account no longer has.
   */
  async start(userId: string | null, languages?: readonly string[]): Promise<void> {
    this.stopTimer();
    const generation = ++this.generation;
    this.userId = userId;
    this.languages = languages && new Set(languages);
    this.storedOps = [];
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
    this.storedOps = [];
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
  async create(
    inputs: PublishInput[],
    globals: NonNullable<PublishOp['globals']> = [],
    switched = false,
  ): Promise<PublishOp> {
    const userId = this.userId;
    const generation = this.generation;
    if (!userId) throw new Error('Sign in to publish.');
    if (!inputs.length && !globals.length) throw new Error('Nothing to publish.');
    const now = this.deps.now();
    const planned = inputs.length ? publishChunks(inputs) : [[]];
    const groupId = newOpId(now);
    const chunks: PublishOp[] = [];
    for (const chunk of planned) {
      const op: PublishOp = {
        opId: chunks.length === 0 ? groupId : newOpId(now),
        round: 0,
        ...(planned.length > 1
          ? {
              groupId,
              groupSize: planned.length,
              groupIndex: chunks.length,
              groupHashCount: inputs.length,
              consumers: chunk.reduce((count, input) => count + (input.consumers ?? 1), 0),
            }
          : {}),
        userId,
        createdAt: now,
        hashes: chunk.map((input) => input.hash),
        expected: Object.fromEntries(chunk.map((input) => [input.hash, input.digest])),
        previous: Object.fromEntries(chunk.map((input) => [input.hash, input.previous ?? null])),
        // First, so the parts that use a new global find it published.
        ...(chunks.length === 0 && globals.length ? { globals } : {}),
        ...(switched ? { switched: true as const } : {}),
        status: 'created',
        updatedAt: now,
      };
      const bodyBytes = new TextEncoder().encode(JSON.stringify(publishBody(op))).length;
      if (bodyBytes > publishTiming.maxBodyBytes)
        throw new Error('This publish is too large to send. Nothing was sent.');
      chunks.push(op);
    }
    let busy = false;
    try {
      // A publish stored since Review listed these rows (or one still recovering) holds them.
      busy = !(await this.deps.store.addMany(chunks, (stored) => {
        const held = activeHashes(stored);
        const heldGlobals = activeGlobals(stored);
        return (
          inputs.some(({ hash }) => held.has(hash)) || globals.some(({ id }) => heldGlobals.has(id))
        );
      }));
    } catch (reason) {
      const detail = reason instanceof Error ? reason.message : 'unknown error';
      throw new Error(
        `Publishing needs browser storage, which is unavailable (${detail}). Nothing was sent.`,
      );
    }
    if (busy) throw new Error(publishingAlready);
    if (generation !== this.generation) return chunks[0]!;
    this.storedOps.push(...chunks);
    usePublishState.setState((state) => ({ ops: [...state.ops, ...chunks] }));
    this.deps.broadcast();
    // Send in sequence to avoid a burst of CAS collisions between our own chunks.
    void this.sendChunks(chunks);
    return chunks[0]!;
  }

  /** A translator's publish: independent rows, sent in parts of the size the Worker takes. */
  async createTranslations(
    rows: readonly { row: TranslationPublishRow; name: string }[],
    partRows: number,
  ): Promise<void> {
    const userId = this.userId;
    const generation = this.generation;
    if (!userId) throw new Error('Sign in to publish.');
    if (!rows.length) throw new Error('Nothing to publish.');
    const now = this.deps.now();
    const groupId = newOpId(now);
    const size = Math.ceil(rows.length / partRows);
    const parts = Array.from({ length: size }, (_, index) =>
      translationOp(
        userId,
        now,
        rows.slice(index * partRows, (index + 1) * partRows),
        index === 0 ? groupId : newOpId(now),
        size > 1 ? { groupId, groupSize: size, groupIndex: index } : {},
      ),
    );
    const keys = rows.map(({ row }) => translationKey(row));
    let stored = false;
    try {
      stored = await this.deps.store.addMany(parts, (known) => {
        const held = activeTranslations(known);
        return keys.some((key) => held.has(key));
      });
    } catch (reason) {
      const detail = reason instanceof Error ? reason.message : 'unknown error';
      throw new Error(
        `Publishing needs browser storage, which is unavailable (${detail}). Nothing was sent.`,
      );
    }
    if (!stored)
      throw new Error(
        'Some of these translations are already being published. Nothing was sent; review the list and publish again.',
      );
    if (generation !== this.generation) return;
    this.storedOps.push(...parts);
    usePublishState.setState((state) => ({ ops: [...state.ops, ...parts] }));
    this.deps.broadcast();
    void this.sendChunks(parts);
  }

  /** A request naming a language this account lost: never sent, resent, or kicked again. */
  private parked(op: PublishOp) {
    return !!op.translations?.some(({ row }) => !this.languages?.has(row.lang));
  }

  /** Refused translators' requests whose other rows still go out again. */
  private owed() {
    const now = this.deps.now();
    return this.storedOps.flatMap((op) => {
      const rows = owedRows(op, this.storedOps, now);
      return rows.length ? [{ op, rows }] : [];
    });
  }

  /** The rest of a refused request is sent once, whichever tab gets there. */
  private async resendTranslations(generation: number) {
    for (const { op, rows } of this.owed()) {
      if (this.parked(op)) {
        await this.settle(op.opId, { released: true });
        if (generation !== this.generation) return;
        continue;
      }
      const now = this.deps.now();
      const part = translationOp(op.userId, now, rows, newOpId(now), {
        groupId: op.groupId ?? op.opId,
        groupSize: op.groupSize ?? 1,
        groupIndex: op.groupIndex ?? 0,
        groupCreatedAt: op.groupCreatedAt ?? op.createdAt,
        resends: op.opId,
      });
      const stored = await this.deps.store
        .addMany([part], (known) => known.some(({ resends }) => resends === op.opId))
        .catch(() => undefined);
      if (generation !== this.generation) return;
      if (stored === undefined) continue;
      if (stored) this.deps.broadcast();
      // Reload the new part, whichever tab stored it.
      this.again = true;
    }
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
    if (!this.current(opId)) return;
    const generation = this.generation;
    const claimed = await this.claim(opId, (op, now) =>
      op.status !== 'pending' ||
      this.parked(op) ||
      (op.kickedAt !== undefined && now - op.kickedAt < publishTiming.manualKickGapMs)
        ? undefined
        : { ...op, kickedAt: now },
    );
    // The account, or its languages, can change while storage answers.
    if (!claimed || generation !== this.generation) return;
    const op = this.current(opId);
    if (op && !this.parked(op)) await this.kick(opId);
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

  private async list(userId: string) {
    const stored = await this.deps.store.list(userId);
    return stored.filter((op) => !!op.translations === !!this.languages);
  }

  private async reload(generation: number, first = false) {
    let stored: PublishOp[];
    try {
      stored = await this.list(this.userId!);
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
    this.storedOps = kept;
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
    const { generation, userId } = this;
    let won = false;
    try {
      await this.deps.store.update(opId, (op) => {
        // Storage can answer after an account or language change: this claim is then nobody's.
        if (generation !== this.generation || op.userId !== userId) return undefined;
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
    const pending: PublishOp[] = [];
    for (const op of [...usePublishState.getState().ops]) {
      if (generation !== this.generation) return;
      if (this.paused.has(op.opId)) continue;
      const now = this.deps.now();
      if (op.status === 'created') {
        if (!(await this.groupReady(op))) continue;
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
        if ((polled && (await this.poll(op.opId))) === 'pending') pending.push(op);
      } else if (needsPublishReceipt(op)) {
        const claimed = await this.claim(op.opId, (current, at) =>
          needsPublishReceipt(current) && at >= receiptDue(current)
            ? { ...current, polledAt: at }
            : undefined,
        );
        if (claimed && generation === this.generation) await this.adopt(op.opId, 'rejected');
      }
    }
    for (const op of pending) {
      if (generation !== this.generation) return;
      if (this.deps.now() - (op.acceptedAt ?? op.createdAt) >= publishTiming.autoKickMs)
        await this.autoKick(op.opId, generation);
    }
    if (generation === this.generation) await this.recoverGroups();
    if (generation === this.generation) await this.resendTranslations(generation);
  }

  private async autoKick(opId: string, generation: number) {
    const now = this.deps.now();
    const op = this.current(opId);
    if (!op || this.parked(op)) return;
    const claimed = await this.deps.store
      .claimKick(opId, now, (members, bundleAt) => {
        if (generation !== this.generation) return false;
        const first = members.sort(byAge).find((op) => !isTerminal(op.status));
        if (first?.opId !== opId) return false;
        return (
          now - bundleAt >= publishTiming.autoKickMs &&
          members.every(
            (op) =>
              now - op.updatedAt >= publishTiming.autoKickMs &&
              now - (op.kickedAt ?? -Infinity) >= publishTiming.autoKickGapMs,
          )
        );
      })
      .catch(() => false);
    if (claimed && generation === this.generation) await this.kick(opId);
  }

  private recoveries() {
    const groups = new Set(
      this.storedOps
        .filter((op) => op.refusal !== undefined && !op.dismissed)
        .map((op) => op.groupId),
    );
    return [...groups].flatMap((groupId) => {
      if (!groupId) return [];
      const parts = regroupRefusals(this.storedOps.filter((op) => op.groupId === groupId));
      return parts.length ? [parts] : [];
    });
  }

  private async recoverGroups() {
    const generation = this.generation;
    for (const parts of this.recoveries()) {
      const now = this.deps.now();
      const replacements = parts.map((part): PublishOp => {
        const first = part[0]!;
        const globals = part.flatMap((op) => op.globals ?? []);
        return {
          opId: newOpId(now),
          userId: first.userId,
          groupId: first.groupId,
          groupSize: first.groupSize,
          groupIndex: first.groupIndex,
          groupHashCount: first.groupHashCount,
          round: first.round! + 1,
          consumers: part.reduce((count, op) => count + op.consumers!, 0),
          hashes: part.flatMap((op) => op.hashes),
          expected: Object.assign({}, ...part.map((op) => op.expected)),
          previous: Object.assign({}, ...part.map((op) => op.previous)),
          ...(globals.length ? { globals } : {}),
          ...(first.switched ? { switched: true as const } : {}),
          status: 'created',
          createdAt: now,
          groupCreatedAt: first.groupCreatedAt ?? first.createdAt,
          kickedAt: Math.max(...part.map((op) => op.kickedAt ?? 0)) || undefined,
          updatedAt: now,
        };
      });
      const stored = await this.deps.store
        .replaceRefused(parts.flat(), replacements)
        .catch(() => null);
      if (generation !== this.generation) return;
      if (stored === null) continue;
      if (stored) this.deps.broadcast();
      // Reload the new round, regardless of which tab won the replace.
      this.again = true;
    }
  }

  private schedule() {
    this.stopTimer();
    if (!this.userId || !this.deps.visible()) return;
    const now = this.deps.now();
    let next = this.recoveries().length ? now + publishTiming.pollMs(0) : Infinity;
    if (this.owed().length) next = now;
    for (const op of usePublishState.getState().ops) {
      if (needsPublishReceipt(op) && !this.paused.has(op.opId))
        next = Math.min(next, receiptDue(op));
      if (isTerminal(op.status) || this.paused.has(op.opId) || this.inFlight.has(op.opId)) continue;
      if (
        op.status === 'pending' &&
        now - (op.acceptedAt ?? op.createdAt) > publishTiming.pollGiveUpMs
      )
        continue;
      if (op.status === 'created') {
        if (this.unacceptedPredecessors(op).length) continue;
        const retry = this.attempts.get(op.opId);
        next = Math.min(
          next,
          retry ? retry.at : (op.polledAt ?? 0) + publishTiming.foreignAttemptMs,
        );
      } else {
        const accepted = op.acceptedAt ?? op.createdAt;
        next = Math.min(next, (op.polledAt ?? 0) + publishTiming.pollMs(now - accepted));
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
  /**
   * `whileCreated`: a failure inferred from the Worker's "unknown" applies only while the stored
   * record is still `created`. Another tab (or an earlier send) may have stored `pending` meanwhile;
   * then the record is kept as stored and this tab follows it instead.
   */
  private async settle(opId: string, patch: Partial<PublishOp>, whileCreated = false) {
    const generation = this.generation;
    const stored = await this.deps.store
      .update(opId, (op) => {
        // Keep the first observed confirmation time when two tabs see the same receipt.
        if (op.status === 'done' || op.status === 'unchanged') return undefined;
        if (whileCreated && op.status !== 'created') return undefined;
        return { ...op, ...patch, updatedAt: this.deps.now() };
      })
      .catch(() => undefined);
    if (!stored || generation !== this.generation) return;
    this.storedOps = this.storedOps.map((op) => (op.opId === opId ? stored : op));
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

  private async adopt(opId: string, remote: RemoteStatus, answer?: PublishAnswer) {
    const op = this.current(opId);
    if (!op) return;
    let refusedGlobals: NonNullable<PublishOp['refusedGlobals']> = [];
    if (op.globals && (remote === 'done' || remote === 'unchanged')) {
      // Finished says nothing about single globals: only the receipt's own outcomes do.
      const outcome = await this.globalOutcome(op, answer);
      if (outcome === 'later') return;
      if (outcome === 'unreadable')
        return this.settle(opId, {
          status: 'failed',
          acceptedAt: op.acceptedAt ?? this.deps.now(),
          error:
            'The publish finished, but which changes went live could not be read. Check live status before publishing these again.',
        });
      refusedGlobals = outcome;
    }
    if (remote === 'rejected' && !answer && !op.translations) {
      const generation = this.generation;
      if (op.status !== 'rejected') {
        // Store the rejection first: a finished part is never kicked or retried, and if the
        // receipt read below fails, the receipt scheduler (with back-off) takes over.
        await this.settle(opId, {
          status: 'rejected',
          acceptedAt: op.acceptedAt ?? this.deps.now(),
        });
        if (generation !== this.generation) return;
      }
      // The status projection omits the reason. Replaying the exact POST returns the terminal
      // receipt for this intent, with no new request or change to the original selection.
      try {
        answer = await this.post(op);
      } catch (reason) {
        if (generation !== this.generation) return;
        const status = reason instanceof PublishHttpError ? reason.status : 0;
        if (status === 401) {
          // Signing in again restarts the driver, which clears the pause.
          this.paused.add(opId);
          this.note(opId, 'Sign in again to continue; nothing is lost.');
        } else if (status === 403 || status === 409) {
          // A definite answer: reading again will not help. Finish this part with what is known.
          const detail =
            reason instanceof PublishHttpError && reason.fromWorker ? reason.message.trim() : '';
          return this.settle(opId, {
            status: 'rejected',
            receiptChecked: true,
            error: `The publisher refused ${this.subject(op)}. Its reason could not be read (HTTP ${status}${detail ? `: ${detail.slice(0, 160)}` : ''}).`,
          });
        } else this.note(opId, 'Checking why the publisher refused this part.');
        return;
      }
      if (generation !== this.generation || answer.status !== 'rejected') return;
    }
    if (op.translations && answer?.rows) return this.refuseRows(op, answer.rows);
    const refusal = remote === 'rejected' ? answer?.refusal : undefined;
    return this.settle(opId, {
      status: remote,
      acceptedAt: op.acceptedAt ?? this.deps.now(),
      ...(remote === 'rejected' && (answer || op.translations) ? { receiptChecked: true } : {}),
      ...(refusedGlobals.length ? { refusedGlobals } : {}),
      ...(refusal !== undefined
        ? {
            refusal,
            regroupable: answer?.regroupable,
            error:
              answer?.regroupable === false
                ? refusal
                : `${this.subject(op, op.globals ? 'tooltips' : 'Tooltips')}: ${refusal}`,
          }
        : {}),
    });
  }

  /** Nothing of this request went live; the rows that refused it wait for another review. */
  private refuseRows(op: PublishOp, rows: readonly RefusedRow[]) {
    const names = new Map(op.translations!.map(({ row, name }) => [translationKey(row), name]));
    return this.settle(op.opId, {
      status: 'rejected',
      acceptedAt: op.acceptedAt ?? this.deps.now(),
      receiptChecked: true,
      refusedRows: rows.flatMap(({ key, error }) => {
        const name = names.get(key);
        return name === undefined ? [] : [{ key, name, error }];
      }),
    });
  }

  /** The globals a finished request left out, from its receipt; 'later' asks again. */
  private async globalOutcome(
    op: PublishOp,
    answer: PublishAnswer | undefined,
  ): Promise<NonNullable<PublishOp['refusedGlobals']> | 'later' | 'unreadable'> {
    const generation = this.generation;
    if (!answer)
      try {
        answer = await this.post(op);
      } catch (reason) {
        if (generation !== this.generation) return 'later';
        const status = reason instanceof PublishHttpError ? reason.status : 0;
        if (status === 403 || status === 409) return 'unreadable';
        if (status === 401) this.paused.add(op.opId);
        this.note(
          op.opId,
          status === 401
            ? 'Sign in again to continue; nothing is lost.'
            : 'Checking which globals went live.',
        );
        return 'later';
      }
    if (generation !== this.generation || answer.status === 'pending') return 'later';
    const { live = [], refused = [] } = answer.globals ?? {};
    const outcomes = op.globals!.map(({ id, name }) => {
      const error = refused.find((entry) => entry.id === id)?.error;
      return live.includes(id) ? null : error === undefined ? undefined : { id, name, error };
    });
    return outcomes.includes(undefined)
      ? 'unreadable'
      : outcomes.filter((entry) => entry !== null && entry !== undefined);
  }

  /** "tooltips 10, 20", or with the globals of the request first. */
  private subject(op: PublishOp, tooltipsWord = 'tooltips') {
    if (op.translations)
      return new Intl.ListFormat('en').format(firstFew(op.translations.map(({ name }) => name)));
    const tooltips = op.hashes.length ? [`${tooltipsWord} ${hashList(op.hashes)}`] : [];
    return new Intl.ListFormat('en').format([
      ...(op.globals?.map(({ name }) => name) ?? []),
      ...tooltips,
    ]);
  }

  private current(opId: string) {
    return usePublishState.getState().ops.find((op) => op.opId === opId);
  }

  private unacceptedPredecessors(op: PublishOp): PublishOp[] {
    if (!op.groupId) return [];
    return this.storedOps.filter(
      (earlier) =>
        earlier.groupId === op.groupId &&
        byAge(earlier, op) < 0 &&
        earlier.acceptedAt === undefined &&
        (earlier.status === 'created' || earlier.status === 'failed'),
    );
  }

  private async groupReady(op: PublishOp): Promise<boolean> {
    const earlier = this.unacceptedPredecessors(op);
    if (!earlier.length) return true;
    if (earlier.some((entry) => isTerminal(entry.status))) {
      await this.settle(
        op.opId,
        {
          status: 'failed',
          error:
            'An earlier chunk was not accepted. Further sends of this chunk were stopped; it may already be queued. Check live status before publishing again.',
        },
        true,
      );
    } else this.note(op.opId, 'Waiting for an earlier chunk to be received.');
    return false;
  }

  /** POST the stored body. Re-sending is always safe: the Worker is idempotent per opId. */
  private post(op: PublishOp) {
    if (op.translations)
      return this.deps.api.postTranslations(
        translationBody({ opId: op.opId, translations: op.translations }),
      );
    const body = publishBody(op);
    return op.switched ? this.deps.api.post(body, true) : this.deps.api.post(body);
  }

  private async status(
    op: PublishOp,
  ): Promise<{ remote: RemoteStatus | 'unknown'; answer?: PublishAnswer }> {
    if (!op.translations) return { remote: await this.deps.api.status(op.opId) };
    const answer = await this.deps.api.translationStatus(op.opId);
    return answer.status === 'unknown'
      ? { remote: 'unknown' }
      : { remote: answer.status, answer: answer as PublishAnswer };
  }

  private async send(opId: string) {
    const op = this.current(opId);
    if (!op || this.inFlight.has(opId) || isTerminal(op.status)) return;
    const generation = this.generation;
    this.inFlight.add(opId);
    try {
      if (op.status === 'created' && op.groupId) {
        // Consult persisted predecessors even after another tab dismisses a failed chunk.
        let stored: PublishOp[];
        try {
          stored = await this.list(op.userId);
        } catch {
          if (generation === this.generation) {
            const count = (this.attempts.get(opId)?.count ?? 0) + 1;
            this.attempts.set(opId, {
              count,
              at: this.deps.now() + publishTiming.sendBackoffMs(count - 1),
            });
            this.note(opId, 'Could not check earlier chunks; retrying.');
          }
          return;
        }
        if (generation !== this.generation) return;
        this.storedOps = stored;
        if (!(await this.groupReady(op))) return;
      }
      const now = this.deps.now();
      const parked = this.parked(op);
      // Accepted once: the Worker knows it, whatever this answer said.
      if (parked && op.status !== 'created') return;
      if (parked || (op.status === 'created' && now - op.createdAt > publishTiming.sendExpiryMs)) {
        // The window for (re)creating the request has closed, but the Worker may already hold it (a
        // lost 202). Only the Worker's own answer can say so: never infer non-delivery from age.
        let remote: RemoteStatus | 'unknown';
        let answer: PublishAnswer | undefined;
        try {
          ({ remote, answer } = await this.status(op));
        } catch {
          if (generation !== this.generation) return;
          this.attempts.set(opId, { count: 9, at: now + publishTiming.sendBackoffMs(9) });
          this.note(
            opId,
            'Could not confirm with the Worker whether this was received; checking again.',
          );
          return;
        }
        if (generation !== this.generation) return;
        if (remote === 'unknown')
          await this.settle(
            opId,
            {
              status: 'failed',
              error: parked
                ? 'One of its languages is no longer yours, and the Worker has no record of it. Publish the rest again.'
                : 'The Worker has no record of this publish and it is too old to send. Publish again.',
            },
            true,
          );
        else await this.adopt(opId, remote, answer);
        return;
      }
      await this.deps.store
        .update(opId, (current) => ({ ...current, polledAt: now }))
        .catch(() => undefined);
      if (generation !== this.generation) return;
      let result: Awaited<ReturnType<PublishApi['post']>>;
      try {
        result = await this.post(op);
      } catch (reason) {
        if (generation === this.generation) await this.sendFailed(op, reason);
        return;
      }
      if (generation !== this.generation) return;
      this.attempts.delete(opId);
      await this.adopt(opId, result.status, result);
    } finally {
      this.inFlight.delete(opId);
      // A send outside a tick (create, resend) still needs its follow-up poll/retry scheduled.
      if (generation === this.generation && !this.running) this.schedule();
    }
  }

  private async sendFailed(op: PublishOp, reason: unknown) {
    // Called right after send() checked the generation; every await below re-checks it, so a
    // reply that lands after a restart or account switch never settles, adopts, or notes.
    const generation = this.generation;
    const status = reason instanceof PublishHttpError ? reason.status : 0;
    const message = reason instanceof Error ? reason.message : 'Unknown error';
    // Only the Worker's own JSON sentence; an edge page's body is not a message to show.
    const workerMessage =
      reason instanceof PublishHttpError && reason.fromWorker ? reason.message.trim() : '';
    if (status === 401) {
      this.paused.add(op.opId);
      this.note(op.opId, 'Sign in again to continue; nothing is lost.');
      return;
    }
    if (status === 403) {
      this.deps.forbidden?.();
      await this.settle(op.opId, {
        status: 'failed',
        error: op.translations
          ? 'These translations are not yours to publish (HTTP 403). If the publish was already queued it may still run; check the live text before publishing again.'
          : 'The Worker refused this account (HTTP 403), so this tab cannot follow the publish. If it was already queued it may still run; check live status before publishing again.',
      });
      return;
    }
    if (status === 409 && op.translations && reason instanceof PublishHttpError && reason.rows)
      return this.refuseRows(op, reason.rows);
    if (status === 409) {
      await this.settle(op.opId, {
        status: 'failed',
        error:
          workerMessage ||
          'This publish id was already used with different contents. Publish again.',
      });
      return;
    }
    if (status === 400) {
      // Never a new opId: ask the Worker whether it knows this one.
      try {
        const { remote, answer } = await this.status(op);
        if (generation !== this.generation) return;
        if (remote !== 'unknown') return void (await this.adopt(op.opId, remote, answer));
      } catch {
        // The Worker really did reject the body; report that below.
      }
      if (generation !== this.generation) return;
      await this.settle(
        op.opId,
        {
          status: 'failed',
          error: /creation window/i.test(message)
            ? 'The Worker rejected this publish because its time is outside the allowed window. Check your device clock, then publish again.'
            : `The Worker rejected this publish (${message.slice(0, 120)}). Publish again.`,
        },
        true,
      );
      return;
    }
    if (status === 413) {
      await this.settle(op.opId, {
        status: 'failed',
        error: op.translations
          ? 'The Worker takes smaller parts now. Reload the page, then publish again.'
          : 'This publish is too large for the Worker. Select fewer tooltips and publish again.',
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
    // Offline, timeout, 5xx, 429: keep the record and resend the same opId and body.
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
      let answer: PublishAnswer | undefined;
      try {
        ({ remote, answer } = await this.status(op));
      } catch {
        remote = undefined;
      }
      if (generation !== this.generation) return;
      if (remote !== undefined && remote !== 'unknown')
        return void (await this.adopt(op.opId, remote, answer));
      if (remote === 'unknown') {
        await this.settle(
          op.opId,
          {
            status: 'failed',
            error: `Worker error (HTTP ${status}: ${message.slice(0, 160)}); the Worker holds no request for these tooltips. Publish again later, or report this error.`,
          },
          true,
        );
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
    let answer: PublishAnswer | undefined;
    try {
      const op = this.current(opId);
      if (!op) return;
      ({ remote, answer } = await this.status(op));
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
      return remote;
    }
    await this.adopt(opId, remote, answer);
  }

  private async kick(opId: string) {
    const generation = this.generation;
    try {
      await this.deps.api.kick(opId);
      if (generation === this.generation) this.note(opId, undefined);
    } catch (reason) {
      if (generation !== this.generation) return;
      const status = reason instanceof PublishHttpError ? reason.status : 0;
      if (status === 403) this.deps.forbidden?.();
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

function translationOp(
  userId: string,
  now: number,
  translations: NonNullable<PublishOp['translations']>,
  opId: string,
  group: Partial<PublishOp>,
): PublishOp {
  return {
    opId,
    ...group,
    userId,
    createdAt: now,
    hashes: [],
    expected: {},
    previous: {},
    translations,
    status: 'created',
    updatedAt: now,
  };
}

/** Names up to ten tooltips, then "and N more", so the reason after the list is never lost. */
export function hashList(hashes: readonly number[]): string {
  return hashes.length <= 10
    ? hashes.join(', ')
    : `${hashes.slice(0, 10).join(', ')} and ${hashes.length - 10} more`;
}

const firstFew = (names: readonly string[]) =>
  names.length <= 10 ? names : [...names.slice(0, 10), `${names.length - 10} more`];

function byAge(a: PublishOp, b: PublishOp) {
  if (a.groupId && a.groupId === b.groupId) {
    // Old stored groups were sorted by hash; new groups persist their dependency order.
    const order = (a.groupIndex ?? Math.min(...a.hashes)) - (b.groupIndex ?? Math.min(...b.hashes));
    if (order) return order;
  }
  return a.createdAt - b.createdAt || a.opId.localeCompare(b.opId);
}

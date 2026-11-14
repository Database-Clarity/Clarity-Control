/**
 * TEST-ONLY fixture Worker for the scheduled-changes batch routes (spec "Worker API", phase P3-0).
 * Web tests and QA (P3a, P3b) run batch flows against it instead of any real Worker or data repo:
 * install it with `vi.stubGlobal('fetch', fixture.fetch)`. Requests that are not batch routes go
 * to `fallback` (default: a 404), so it composes with other fetch doubles.
 *
 * It models what the web relies on: the switch (503 while OFF), roles (Q3: trials and signed-out
 * requests are refused; translators edit their languages of existing members only), revision CAS,
 * one open batch per tooltip (Q2), merge3 against the stored proposal, "Unschedule to edit" for
 * non-translation edits of a scheduled batch, and "Publishing started" after `claim()`. P3a aligned
 * the bodies with the P2 Worker (apps/worker/src/schedule): refusals are `{error, details?}`, writes
 * answer `{commit, batch, ...}` (plus this fixture's `head`, the same SHA), the caps (15 members,
 * 15 changes per draft save, 10 per scheduled save), schedule admission (lead time, stale members),
 * kick, resolve, and raw reads of batch.json, event pages, and activation conflicts at any head it
 * made. `publish()`, `failRun()`, and `addConflict()` stand in for the publisher (P4).
 */
import { contentHash, merge3, stableStringify, type Tooltip } from '@clarity/core';
import {
  activate,
  activationConflictSchema,
  batchSchema,
  changedFields,
  checkNotBefore,
  resolveActivation,
  type ActivationConflict,
  initialRevisions,
  isContentChange,
  isOpenStatus,
  isTranslationField,
  nextRevisions,
  scheduleLimits,
  type Batch,
  type BatchMember,
} from '@clarity/core/schedule';

export type FixtureRole = 'maintainer' | 'editor' | 'translator' | 'trial' | null;
export interface FixtureUser {
  id: number;
  login: string;
  role: FixtureRole;
  /** A translator's assigned languages. */
  languages?: string[];
}
export interface FixtureOptions {
  /** Current saved tooltips at head. */
  current?: Record<number, Tooltip>;
  user: FixtureUser;
  /** The build switch (config/scheduled.json); OFF answers 503 on every batch route. */
  enabled?: boolean;
  /** Clock for stamps; defaults to a fixed instant so runs are reproducible. */
  now?: () => Date;
  fallback?: (request: Request) => Promise<Response>;
  /** Hashes with a pushed.json entry (published before); others are first publications (C4). */
  pushed?: number[];
  /** Override the Worker caps (e.g. to exercise multi-chunk saves into a draft batch). */
  caps?: Partial<typeof fixtureCaps>;
}

/** The P2 Worker's caps (apps/worker/src/schedule/store.ts). */
export const fixtureCaps: { members: number; draftSave: number; scheduledSave: number } = {
  members: 15,
  draftSave: 15,
  scheduledSave: 10,
};
export interface FixtureChange {
  hash: number;
  base: Tooltip | null;
  next: Tooltip;
}

const crockford = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
/** A Worker refusal: `{error, details?}` (apps/worker/src/index.ts). */
const refuse = (status: number, error: string, details?: unknown) =>
  json(status, details === undefined ? { error } : { error, details });
const same = (a: unknown, b: unknown) => stableStringify(a) === stableStringify(b);

export function createBatchFixture(options: FixtureOptions) {
  const current = new Map(
    Object.entries(options.current ?? {}).map(([hash, tooltip]) => [Number(hash), tooltip]),
  );
  const batches = new Map<string, Batch>();
  const members = new Map<string, Map<number, BatchMember>>();
  let now = options.now ?? (() => new Date('2026-11-13T12:00:00.000Z'));
  const pushed = new Set(options.pushed ?? []);
  const caps = { ...fixtureCaps, ...options.caps };
  const conflicts = new Map<number, ActivationConflict>();
  type Archive = { seq: number; events: Batch['events'] }[];
  /** Archived event pages per batch (events/<seq>.json), oldest first. */
  const archives = new Map<string, Archive>();
  /** What raw.githubusercontent.com serves at each head this fixture made. */
  const snapshots = new Map<
    string,
    {
      batches: Map<string, Batch>;
      members: Map<string, Map<number, BatchMember>>;
      conflicts: Map<number, ActivationConflict>;
      archives: Map<string, Archive>;
    }
  >();
  let user = options.user;
  let enabled = options.enabled ?? true;
  let sequence = 0;
  let commits = 0;
  /** Batches kicked (POST /batches/:id/kick), in order. */
  const kicks: string[] = [];
  /** Every request this fixture answered, in order (route and status), for assertions. */
  const log: { method: string; path: string; status: number }[] = [];
  const nextCommit = () => (++commits).toString(16).padStart(40, '0');
  let head = nextCommit();
  const snap = () =>
    snapshots.set(head, {
      batches: structuredClone(batches),
      members: structuredClone(members),
      conflicts: structuredClone(conflicts),
      archives: structuredClone(archives),
    });
  const advance = () => {
    head = nextCommit();
    snap();
  };
  snap();
  /** Keeps the newest 200 events inline; older ones move to an archive page (root ruling). */
  const withEvents = (batch: Batch, events: Batch['events']): Batch['events'] => {
    if (events.length <= scheduleLimits.inlineEvents) return events;
    const moved = events.slice(0, events.length - scheduleLimits.inlineEvents);
    const pages = archives.get(batch.id) ?? [];
    const seq = pages.reduce((sum, page) => sum + page.events.length, 0);
    archives.set(batch.id, [...pages, { seq, events: moved }]);
    return events.slice(-scheduleLimits.inlineEvents);
  };
  const nextId = () => {
    let id = '01JF';
    for (let n = ++sequence, i = 0; i < 22; i++, n = Math.floor(n / 32)) id += crockford[n % 32];
    return id;
  };
  const by = () => ({ id: user.id, login: user.login });
  const event = (
    action: Batch['events'][number]['action'],
    revisions: { revision: number; contentRevision: number },
    extra: object = {},
  ) => ({ at: now().toISOString(), by: by(), action, ...revisions, ...extra });
  const memberList = (id: string) => [...(members.get(id)?.values() ?? [])];
  const digestMembers = (list: BatchMember[]) =>
    list.map(({ hash, base, proposed }) => ({ hash, base, proposed }));
  const write = (
    batch: Batch,
    action: Batch['events'][number]['action'],
    before: BatchMember[],
    hashes?: number[],
    patch: Partial<Batch> = {},
  ): Batch => {
    const after = memberList(batch.id);
    const revisions = nextRevisions(
      batch,
      isContentChange(digestMembers(before), digestMembers(after)),
    );
    const next = batchSchema.parse({
      ...batch,
      ...patch,
      ...revisions,
      events: withEvents(batch, [
        ...batch.events,
        event(action, revisions, {
          ...(hashes ? { hashes } : {}),
          ...(patch.notBefore ? { notBefore: patch.notBefore } : {}),
        }),
      ]),
    });
    batches.set(batch.id, next);
    advance();
    return next;
  };
  const openBatchOf = (hash: number) =>
    [...batches.values()].find(
      (batch) => isOpenStatus(batch.status) && members.get(batch.id)?.has(hash),
    );
  const canManage = () => user.role === 'maintainer' || user.role === 'editor';

  const ok = (status: number, body: object) => json(status, { head, commit: head, ...body });

  function guard(batch: Batch | undefined, revision: unknown): Response | Batch {
    if (!batch) return refuse(404, 'Batch not found');
    if (batch.claim !== null || batch.status === 'publishing')
      return refuse(409, 'Publishing started');
    if (batch.status === 'published') return refuse(409, 'This batch is published');
    if (batch.status === 'cancelled') return refuse(409, 'This batch is cancelled');
    if (revision !== batch.revision)
      return refuse(409, 'The batch changed; reload it and retry', { revision: batch.revision });
    return batch;
  }

  /** Non-translation activation conflicts of a batch's members against current (stale, R14). */
  const staleMembers = (id: string) =>
    memberList(id).flatMap((member) => {
      const result = activate({
        base: member.base,
        current: current.get(member.hash) ?? null,
        proposed: member.proposed,
      });
      return result.ok ? [] : [{ hash: member.hash, fields: result.fields }];
    });

  function save(batch: Batch, changes: FixtureChange[]): Response {
    if (!Array.isArray(changes) || changes.length === 0 || changes.length > caps.draftSave)
      return refuse(400, 'Invalid request body');
    if (batch.status !== 'draft' && changes.length > caps.scheduledSave)
      return refuse(422, `A scheduled batch takes at most ${caps.scheduledSave} changes per save`);
    const stored = members.get(batch.id)!;
    const written: BatchMember[] = [];
    const saveConflicts: { hash: number; fields: string[] }[] = [];
    const staged = new Map(stored);
    for (const change of changes) {
      const member = stored.get(change.hash);
      if (change.next.hash !== change.hash) return json(400, { error: 'Hash mismatch' });
      if (!member) {
        if (!canManage())
          return refuse(403, 'Translators may change only tooltips already in the batch');
        if (batch.status !== 'draft') return refuse(409, 'Unschedule to edit');
        const other = openBatchOf(change.hash);
        if (other)
          return refuse(
            409,
            `Tooltip ${change.hash} is already in the open batch "${other.name}"; one open batch per tooltip`,
            { hashes: [change.hash], batchId: other.id },
          );
        if (staged.size >= caps.members)
          return refuse(409, `A batch holds at most ${caps.members} tooltips`);
        const saved = current.get(change.hash) ?? null;
        if (!same(change.base, saved)) {
          saveConflicts.push({ hash: change.hash, fields: ['$base'] });
          continue;
        }
        const added: BatchMember = {
          hash: change.hash,
          base: saved,
          baseCommit: head,
          proposed: change.next,
          updatedAt: now().toISOString(),
          updatedBy: user.login,
        };
        staged.set(change.hash, added);
        written.push(added);
        continue;
      }
      const base = change.base ?? member.proposed;
      const merged = merge3(base, member.proposed, change.next);
      if (!merged.ok) {
        saveConflicts.push({ hash: change.hash, fields: merged.conflicts.map((c) => c.field) });
        continue;
      }
      const fields = changedFields(member.proposed, merged.merged);
      if (user.role === 'translator') {
        const allowed = new Set((user.languages ?? []).map((lang) => `text.${lang}`));
        if (fields.some((field) => !allowed.has(field)))
          return refuse(403, 'Translators edit their languages only');
      } else if (!canManage()) return refuse(403, 'No batch access');
      if (batch.status === 'scheduled' && fields.some((field) => !isTranslationField(field)))
        return refuse(409, 'Unschedule to edit', { hash: change.hash, fields });
      if (!fields.length) continue;
      const updated: BatchMember = {
        ...member,
        proposed: merged.merged,
        updatedAt: now().toISOString(),
        updatedBy: user.login,
      };
      staged.set(change.hash, updated);
      written.push(updated);
    }
    if (saveConflicts.length) return json(409, { conflicts: saveConflicts });
    if (!written.length) return ok(200, { commit: null, batch, members: [] });
    const before = memberList(batch.id);
    members.set(batch.id, staged);
    const next = write(
      batch,
      'save',
      before,
      written.map((member) => member.hash),
    );
    return ok(200, { batch: next, members: written, savedAt: now().getTime() });
  }

  function kick(id: string): Response {
    const batch = batches.get(id);
    if (!batch) return refuse(404, 'Batch not found');
    if (!canManage()) return refuse(403, 'Forbidden');
    if (batch.status !== 'scheduled' && batch.status !== 'publishing')
      return refuse(409, 'Only a scheduled or publishing batch can be kicked');
    if (
      !batch.notBefore ||
      now().getTime() <= Date.parse(batch.notBefore) + scheduleLimits.overdueMs
    )
      return refuse(409, 'This batch is not overdue');
    kicks.push(id);
    return json(202, { batchId: id, opId: batch.opId, status: batch.status });
  }

  async function resolve(id: string, body: Record<string, unknown>): Promise<Response> {
    const batch = batches.get(id);
    if (!batch) return refuse(404, 'Batch not found');
    if (!canManage()) return refuse(403, 'Forbidden');
    const hash = body.hash as number;
    const conflict = conflicts.get(hash);
    if (!conflict) return refuse(404, `Tooltip ${hash} has no activation conflict to resolve`);
    if (conflict.batchId !== id) return refuse(409, 'This conflict belongs to another batch');
    const saved = current.get(hash) ?? null;
    if ((saved ? await contentHash(saved) : null) !== body.expectedCurrent)
      return json(409, { error: 'Current changed; review the conflict again', current: saved });
    let result: ReturnType<typeof resolveActivation>;
    try {
      result = resolveActivation({
        base: conflict.base,
        current: saved,
        proposed: conflict.proposed,
        choices: body.choices as Record<string, 'upcoming' | 'current'>,
      });
    } catch (error) {
      return refuse(400, error instanceof Error ? error.message : 'Invalid choices');
    }
    if (!result.ok)
      return json(409, {
        error: 'Choose upcoming or current for every conflicted field',
        missing: result.missing,
        current: saved,
      });
    if (result.tooltip) current.set(hash, result.tooltip);
    else current.delete(hash);
    conflicts.delete(hash);
    const revisions = { revision: batch.revision + 1, contentRevision: batch.contentRevision };
    const next = batchSchema.parse({
      ...batch,
      ...revisions,
      events: withEvents(batch, [...batch.events, event('resolve', revisions, { hashes: [hash] })]),
    });
    batches.set(id, next);
    advance();
    return ok(200, { tooltip: result.tooltip, batch: next });
  }

  async function handle(request: Request): Promise<Response | null> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '');
    const route = /\/batches(?:\/([^/]+)(?:\/([a-z]+))?)?$/.exec(path);
    if (!route) return null;
    if (!enabled) return refuse(503, 'Scheduled batches are not enabled');
    if (user.role === null) return refuse(401, 'Sign in');
    if (user.role === 'trial') return refuse(403, 'No batch access');
    const [, id, action] = route;
    if (request.method === 'GET' && !id) {
      const index = [...batches.values()].map((batch) => ({
        id: batch.id,
        name: batch.name,
        status: batch.status,
        notBefore: batch.notBefore,
        opId: batch.opId,
        revision: batch.revision,
        hashes: memberList(batch.id)
          .map((member) => member.hash)
          .sort((a, b) => a - b),
        updatedAt: batch.events.at(-1)?.at ?? batch.createdAt,
      }));
      return json(200, { head, index: { batches: index } });
    }
    if (request.method !== 'POST') return refuse(405, 'Method not allowed');
    const body = (await request.json()) as Record<string, unknown>;
    if (!id) {
      if (!canManage()) return refuse(403, 'Forbidden');
      const open = [...batches.values()].filter((batch) => isOpenStatus(batch.status)).length;
      if (open >= scheduleLimits.openBatches)
        return refuse(409, `At most ${scheduleLimits.openBatches} open batches`);
      const batch = batchSchema.parse({
        id: nextId(),
        name: body.name,
        createdBy: by(),
        createdAt: now().toISOString(),
        ...initialRevisions,
        status: 'draft',
        notBefore: null,
        zone: null,
        opId: null,
        scheduledContentRevision: null,
        claim: null,
        result: null,
        events: [{ at: now().toISOString(), by: by(), action: 'create', ...initialRevisions }],
      });
      batches.set(batch.id, batch);
      members.set(batch.id, new Map());
      advance();
      return ok(201, { batch });
    }
    if (action === 'kick') return kick(id);
    if (action === 'resolve') return resolve(id, body);
    const checked = guard(batches.get(id), body.revision);
    if (checked instanceof Response) return checked;
    const batch = checked;
    switch (action) {
      case 'save':
        return save(batch, body.changes as FixtureChange[]);
      case 'remove': {
        if (!canManage()) return refuse(403, 'Forbidden');
        if (batch.status !== 'draft') return refuse(409, 'Unschedule to edit');
        const before = memberList(id);
        const hashes = body.hashes as number[];
        const stored = new Map(members.get(id));
        for (const hash of hashes) stored.delete(hash);
        members.set(id, stored);
        // write() advances head: build the response after it, so it names the new commit.
        const next = write(batch, 'remove', before, hashes);
        return ok(200, { batch: next });
      }
      case 'rebase': {
        if (!canManage()) return refuse(403, 'Forbidden');
        if (batch.status !== 'draft') return refuse(409, 'Unschedule to edit');
        const hash = body.hash as number;
        const member = members.get(id)?.get(hash);
        const saved = current.get(hash) ?? null;
        if (!member) return refuse(404, `Tooltip ${hash} is not in this batch`);
        if (!same(body.base, saved))
          return json(409, { error: 'Current changed; rebase again', current: saved });
        if (!changedFields(saved, body.next as Tooltip).length)
          return refuse(422, 'Nothing left to publish; remove the tooltip from the batch');
        const before = memberList(id);
        const rebased: BatchMember = {
          ...member,
          base: saved,
          baseCommit: head,
          proposed: body.next as Tooltip,
          updatedAt: now().toISOString(),
          updatedBy: user.login,
        };
        members.set(id, new Map(members.get(id)).set(hash, rebased));
        const next = write(batch, 'rebase', before, [hash]);
        return ok(200, { batch: next, members: [rebased] });
      }
      case 'schedule': {
        if (!canManage()) return refuse(403, 'Forbidden');
        if (memberList(id).length === 0) return refuse(422, 'Add a tooltip to the batch first');
        if (body.notBefore !== 'now') {
          const check = checkNotBefore(String(body.notBefore), now().getTime());
          if (!check.ok) return refuse(422, check.reason);
        }
        const stale = staleMembers(id);
        if (stale.length)
          return refuse(409, 'Current changed under this batch; rebase the listed tooltips', {
            members: stale,
          });
        const notBefore =
          body.notBefore === 'now'
            ? new Date(Math.floor(now().getTime() / 60_000) * 60_000).toISOString()
            : (body.notBefore as string);
        const before = memberList(id);
        const next = write(
          batch,
          batch.status === 'scheduled' ? 'reschedule' : 'schedule',
          before,
          undefined,
          {
            status: 'scheduled',
            notBefore,
            zone: (body.zone as string | undefined) ?? 'UTC',
            opId: nextId(),
            scheduledContentRevision: batch.contentRevision,
          },
        );
        return ok(202, {
          opId: next.opId,
          batch: next,
          firstPublications: memberList(id)
            .map((member) => member.hash)
            .filter((hash) => !pushed.has(hash)),
        });
      }
      case 'unschedule':
      case 'cancel': {
        if (!canManage()) return refuse(403, 'Forbidden');
        if (action === 'unschedule' && batch.status !== 'scheduled')
          return refuse(409, 'This batch is not scheduled');
        const next = write(batch, action, memberList(id), undefined, {
          status: action === 'cancel' ? 'cancelled' : 'draft',
          notBefore: null,
          zone: null,
          opId: null,
          scheduledContentRevision: null,
        });
        return ok(200, { batch: next });
      }
      default:
        return refuse(404, 'Endpoint not found');
    }
  }

  function raw(pathname: string): Response {
    const notFound = () => new Response('404: Not Found', { status: 404 });
    const path = /\/([0-9a-f]{40})\/schedule\/(.+)$/.exec(pathname);
    const at = path ? snapshots.get(path[1]) : undefined;
    if (!path || !at) return notFound();
    const rest = path[2];
    const member = /^batches\/([^/]+)\/tooltips\/(\d+)\.json$/.exec(rest);
    if (member) {
      const body = at.members.get(member[1])?.get(Number(member[2]));
      return body ? json(200, body) : notFound();
    }
    const file = /^batches\/([^/]+)\/batch\.json$/.exec(rest);
    if (file) {
      const body = at.batches.get(file[1]);
      return body ? json(200, body) : notFound();
    }
    const page = /^batches\/([^/]+)\/events\/(\d{8})\.json$/.exec(rest);
    if (page) {
      const body = at.archives.get(page[1])?.find((entry) => entry.seq === Number(page[2]));
      return body ? json(200, { events: body.events }) : notFound();
    }
    const conflict = /^activation-conflicts\/(\d+)\.json$/.exec(rest);
    if (conflict) {
      const body = at.conflicts.get(Number(conflict[1]));
      return body ? json(200, body) : notFound();
    }
    return notFound();
  }

  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    // Commit-pinned bodies (spec: the web reads them from raw.githubusercontent.com), at any head
    // this fixture made.
    if (url.hostname === 'raw.githubusercontent.com') return raw(url.pathname);
    const response = await handle(request.clone());
    if (!response) return options.fallback?.(request) ?? new Response(null, { status: 404 });
    log.push({ method: request.method, path: url.pathname, status: response.status });
    return response;
  };

  return {
    fetch,
    handle,
    log,
    batches,
    members,
    get head() {
      return head;
    },
    setUser(next: FixtureUser) {
      user = next;
    },
    setEnabled(next: boolean) {
      enabled = next;
    },
    kicks,
    conflicts,
    /** Current saved changed at head (another user's /save). */
    setCurrent(hash: number, tooltip: Tooltip | null) {
      if (tooltip) current.set(hash, tooltip);
      else current.delete(hash);
      advance();
    },
    setNow(next: () => Date) {
      now = next;
    },
    /** The publisher's claim + RECORD (P4): published, with the landing time and its source. */
    publish(
      id: string,
      landedAtSource: 'cas' | 'observed' = 'cas',
      landedAt = now().toISOString(),
    ) {
      const batch = batches.get(id);
      if (!batch || !batch.opId || (batch.status !== 'scheduled' && batch.status !== 'publishing'))
        throw new Error('Only a scheduled or publishing batch publishes');
      const revisions = { revision: batch.revision + 1, contentRevision: batch.contentRevision };
      for (const member of memberList(id)) {
        const result = activate({
          base: member.base,
          current: current.get(member.hash) ?? null,
          proposed: member.proposed,
        });
        if (result.ok) current.set(member.hash, result.tooltip);
        pushed.add(member.hash);
      }
      batches.set(
        id,
        batchSchema.parse({
          ...batch,
          ...revisions,
          status: 'published',
          claim: batch.claim ?? { opId: batch.opId, claimedAt: landedAt },
          result: {
            opId: batch.opId,
            status: 'published',
            landedAt,
            landedAtSource,
            recordedAt: landedAt,
            exportNow: landedAt,
            liveCommit: 'f'.repeat(40),
          },
          events: withEvents(batch, [...batch.events, event('published', revisions)]),
        }),
      );
      advance();
    },
    /** A run that failed without a live write: back to draft with the failed result (R15). */
    failRun(
      id: string,
      status: 'stale' | 'rejected' | 'superseded',
      outcomes: { hash: number; status: string; fields?: string[] }[] = [],
      error?: string,
    ) {
      const batch = batches.get(id);
      if (!batch || !batch.opId) throw new Error('Only a batch with an operation can fail');
      const revisions = { revision: batch.revision + 1, contentRevision: batch.contentRevision };
      batches.set(
        id,
        batchSchema.parse({
          ...batch,
          ...revisions,
          status: 'draft',
          notBefore: null,
          zone: null,
          opId: null,
          scheduledContentRevision: null,
          claim: null,
          result: { opId: batch.opId, status, outcomes, ...(error ? { error } : {}) },
          events: withEvents(batch, [...batch.events, event(status, revisions)]),
        }),
      );
      advance();
    },
    /** RECORD left an activation conflict (published batch; current changed meanwhile). */
    addConflict(id: string, hash: number, currentAtRecord: Tooltip | null) {
      const batch = batches.get(id)!;
      const member = members.get(id)!.get(hash)!;
      const result = activate({
        base: member.base,
        current: currentAtRecord,
        proposed: member.proposed,
      });
      if (result.ok) throw new Error('No conflict for these tooltips');
      conflicts.set(
        hash,
        activationConflictSchema.parse({
          hash,
          batchId: id,
          opId: batch.opId,
          fields: result.fields,
          changed: result.changed,
          base: member.base,
          proposed: member.proposed,
          currentAtRecord,
        }),
      );
      if (currentAtRecord) current.set(hash, currentAtRecord);
      else current.delete(hash);
      const revisions = { revision: batch.revision + 1, contentRevision: batch.contentRevision };
      batches.set(id, batchSchema.parse({ ...batch, ...revisions }));
      advance();
    },
    /** Appends `count` save events (to exercise the 200-event overflow pages). */
    addEvents(id: string, count: number) {
      let batch = batches.get(id)!;
      for (let index = 0; index < count; index++) {
        const revisions = { revision: batch.revision + 1, contentRevision: batch.contentRevision };
        batch = batchSchema.parse({
          ...batch,
          ...revisions,
          events: withEvents(batch, [...batch.events, event('save', revisions, { hashes: [] })]),
        });
      }
      batches.set(id, batch);
      advance();
    },
    /** The publisher's claim commit (P4): every later Worker write gets "Publishing started". */
    claim(id: string) {
      const batch = batches.get(id);
      if (!batch || batch.status !== 'scheduled' || !batch.opId)
        throw new Error('Only a scheduled batch can be claimed');
      batches.set(
        id,
        batchSchema.parse({
          ...batch,
          revision: batch.revision + 1,
          status: 'publishing',
          claim: { opId: batch.opId, claimedAt: now().toISOString() },
        }),
      );
      advance();
    },
  };
}
export type BatchFixture = ReturnType<typeof createBatchFixture>;

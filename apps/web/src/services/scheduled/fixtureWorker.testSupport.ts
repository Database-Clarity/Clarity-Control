/**
 * TEST-ONLY fixture Worker for the scheduled-changes batch routes (spec "Worker API", phase P3-0).
 * Web tests and QA (P3a, P3b) run batch flows against it instead of any real Worker or data repo:
 * install it with `vi.stubGlobal('fetch', fixture.fetch)`. Requests that are not batch routes go
 * to `fallback` (default: a 404), so it composes with other fetch doubles.
 *
 * It models what the web relies on: the switch (503 while OFF), roles (Q3: trials and signed-out
 * requests are refused; translators edit their languages of existing members only), revision CAS,
 * one open batch per tooltip (Q2), merge3 against the stored proposal, "Unschedule to edit" for
 * non-translation edits of a scheduled batch, and "Publishing started" after `claim()`. Bodies and
 * statuses are this fixture's; P3a aligns them with the P2 Worker when it merges. It never models
 * publication itself (P4).
 */
import { merge3, stableStringify, type Tooltip } from '@clarity/core';
import {
  batchSchema,
  changedFields,
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
}
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
const same = (a: unknown, b: unknown) => stableStringify(a) === stableStringify(b);

export function createBatchFixture(options: FixtureOptions) {
  const current = new Map(
    Object.entries(options.current ?? {}).map(([hash, tooltip]) => [Number(hash), tooltip]),
  );
  const batches = new Map<string, Batch>();
  const members = new Map<string, Map<number, BatchMember>>();
  const now = options.now ?? (() => new Date('2026-11-13T12:00:00.000Z'));
  let user = options.user;
  let enabled = options.enabled ?? true;
  let sequence = 0;
  let commits = 0;
  /** Every request this fixture answered, in order (route and status), for assertions. */
  const log: { method: string; path: string; status: number }[] = [];
  const nextCommit = () => (++commits).toString(16).padStart(40, '0');
  let head = nextCommit();
  const nextId = () => {
    let id = '01JF';
    for (let n = ++sequence, i = 0; i < 22; i++, n = Math.floor(n / 32)) id += crockford[n % 32];
    return id;
  };
  const by = () => ({ id: user.id, login: user.login });
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
      events: [
        ...batch.events,
        { at: now().toISOString(), by: by(), action, ...revisions, ...(hashes ? { hashes } : {}) },
      ].slice(-scheduleLimits.inlineEvents),
    });
    batches.set(batch.id, next);
    head = nextCommit();
    return next;
  };
  const openBatchOf = (hash: number) =>
    [...batches.values()].find(
      (batch) => isOpenStatus(batch.status) && members.get(batch.id)?.has(hash),
    );
  const canManage = () => user.role === 'maintainer' || user.role === 'editor';

  function guard(batch: Batch | undefined, revision: unknown): Response | Batch {
    if (!batch) return json(404, { error: 'No such batch' });
    if (batch.claim !== null) return json(409, { error: 'Publishing started' });
    if (!isOpenStatus(batch.status)) return json(409, { error: `The batch is ${batch.status}` });
    if (revision !== batch.revision)
      return json(409, { error: 'The batch changed; reload it', revision: batch.revision });
    return batch;
  }

  function save(batch: Batch, changes: FixtureChange[]): Response {
    if (changes.length === 0 || changes.length > scheduleLimits.membersPerBatch)
      return json(400, { error: 'Bad change count' });
    const stored = members.get(batch.id)!;
    const written: BatchMember[] = [];
    const conflicts: { hash: number; fields: string[] }[] = [];
    const staged = new Map(stored);
    for (const change of changes) {
      const member = stored.get(change.hash);
      if (change.next.hash !== change.hash) return json(400, { error: 'Hash mismatch' });
      if (!member) {
        if (!canManage()) return json(403, { error: 'Only editors add tooltips to a batch' });
        if (batch.status !== 'draft') return json(409, { error: 'Unschedule to edit' });
        const other = openBatchOf(change.hash);
        if (other) return json(409, { error: `Tooltip ${change.hash} is in ${other.name}` });
        if (staged.size >= scheduleLimits.membersPerBatch)
          return json(409, { error: 'The batch is full' });
        const saved = current.get(change.hash) ?? null;
        if (!same(change.base, saved)) {
          conflicts.push({ hash: change.hash, fields: ['$base'] });
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
        conflicts.push({ hash: change.hash, fields: merged.conflicts.map((c) => c.field) });
        continue;
      }
      const fields = changedFields(member.proposed, merged.merged);
      if (user.role === 'translator') {
        const allowed = new Set((user.languages ?? []).map((lang) => `text.${lang}`));
        if (fields.some((field) => !allowed.has(field)))
          return json(403, { error: 'Translators edit their languages only' });
      } else if (!canManage()) return json(403, { error: 'No batch access' });
      if (batch.status === 'scheduled' && fields.some((field) => !isTranslationField(field)))
        return json(409, { error: 'Unschedule to edit' });
      const updated: BatchMember = {
        ...member,
        proposed: merged.merged,
        updatedAt: now().toISOString(),
        updatedBy: user.login,
      };
      staged.set(change.hash, updated);
      written.push(updated);
    }
    if (conflicts.length) return json(409, { conflicts });
    const before = memberList(batch.id);
    members.set(batch.id, staged);
    const next = write(
      batch,
      'save',
      before,
      written.map((member) => member.hash),
    );
    return json(200, { head, batch: next, members: written });
  }

  async function handle(request: Request): Promise<Response | null> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '');
    const route = /\/batches(?:\/([^/]+)(?:\/([a-z]+))?)?$/.exec(path);
    if (!route) return null;
    if (!enabled) return json(503, { error: 'Scheduled changes are off' });
    if (user.role === null) return json(401, { error: 'Sign in' });
    if (user.role === 'trial') return json(403, { error: 'No batch access' });
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
    if (request.method !== 'POST') return json(405, { error: 'Method not allowed' });
    const body = (await request.json()) as Record<string, unknown>;
    if (!id) {
      if (!canManage()) return json(403, { error: 'Only editors create batches' });
      const open = [...batches.values()].filter((batch) => isOpenStatus(batch.status)).length;
      if (open >= scheduleLimits.openBatches) return json(409, { error: 'Too many open batches' });
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
      head = nextCommit();
      return json(200, { head, batch });
    }
    const checked = guard(batches.get(id), body.revision);
    if (checked instanceof Response) return checked;
    const batch = checked;
    switch (action) {
      case 'save':
        return save(batch, body.changes as FixtureChange[]);
      case 'remove': {
        if (!canManage()) return json(403, { error: 'Only editors remove tooltips' });
        if (batch.status !== 'draft') return json(409, { error: 'Unschedule to edit' });
        const before = memberList(id);
        const hashes = body.hashes as number[];
        const stored = new Map(members.get(id));
        for (const hash of hashes) stored.delete(hash);
        members.set(id, stored);
        return json(200, { head, batch: write(batch, 'remove', before, hashes) });
      }
      case 'rebase': {
        if (!canManage()) return json(403, { error: 'Only editors rebase' });
        if (batch.status !== 'draft') return json(409, { error: 'Unschedule to edit' });
        const hash = body.hash as number;
        const member = members.get(id)?.get(hash);
        const saved = current.get(hash) ?? null;
        if (!member) return json(404, { error: 'Not a member' });
        if (!same(body.base, saved)) return json(409, { conflicts: [{ hash, fields: ['$base'] }] });
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
        return json(200, {
          head,
          batch: write(batch, 'rebase', before, [hash]),
          members: [rebased],
        });
      }
      case 'schedule': {
        if (!canManage()) return json(403, { error: 'Only editors schedule' });
        if (memberList(id).length === 0) return json(409, { error: 'The batch is empty' });
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
        return json(200, { head, batch: next });
      }
      case 'unschedule':
      case 'cancel': {
        if (!canManage()) return json(403, { error: `Only editors ${action}` });
        if (action === 'unschedule' && batch.status !== 'scheduled')
          return json(409, { error: 'Not scheduled' });
        const next = write(batch, action, memberList(id), undefined, {
          status: action === 'cancel' ? 'cancelled' : 'draft',
          ...(action === 'unschedule' ? { notBefore: null, zone: null } : {}),
          opId: null,
          scheduledContentRevision: null,
        });
        return json(200, { head, batch: next });
      }
      default:
        return json(404, { error: 'No such route' });
    }
  }

  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    // Commit-pinned member bodies (spec: the web reads them from raw.githubusercontent.com).
    const raw = /\/([0-9a-f]{40})\/schedule\/batches\/([^/]+)\/tooltips\/(\d+)\.json$/.exec(
      url.pathname,
    );
    if (url.hostname === 'raw.githubusercontent.com' && raw) {
      const member = raw[1] === head ? members.get(raw[2])?.get(Number(raw[3])) : undefined;
      return member ? json(200, member) : new Response('404: Not Found', { status: 404 });
    }
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
    /** Current saved changed at head (another user's /save). */
    setCurrent(hash: number, tooltip: Tooltip | null) {
      if (tooltip) current.set(hash, tooltip);
      else current.delete(hash);
      head = nextCommit();
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
      head = nextCommit();
    },
  };
}
export type BatchFixture = ReturnType<typeof createBatchFixture>;

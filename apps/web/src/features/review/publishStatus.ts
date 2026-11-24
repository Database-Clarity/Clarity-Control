import { isTerminal, type PublishOp } from '../../services/publisher/opStore';
import {
  needsPublishReceipt,
  publishProofWait,
  publishTiming,
  regroupRefusals,
} from './publishDriver';

export type Tone = 'busy' | 'ok' | 'warn' | 'bad';
export interface OpView {
  opId: string;
  tone: Tone;
  /** Short status chip, fixed width in the UI. */
  chip: string;
  /** What the line says after the count. */
  detail: string;
  /** Tooltip count or confirmed progress. */
  lead: string;
  /** A queued part still has no result after the Retry threshold. */
  waiting: boolean;
  /** Finished: can be dismissed. */
  finished: boolean;
}

/** Formats a timestamp for display: the shared formatter with the user's date settings. */
export type When = (ms: number) => string;

function elapsed(start: number, end: number): string {
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

const changeCount = (op: PublishOp) => op.hashes.length + (op.globals?.length ?? 0);

/** "3 tooltips", with the globals by name ("G_refill and 3 tooltips"; four or more are counted). */
function changeNames({ hashes, globals = [] }: PublishOp): string {
  const tooltips = `${hashes.length} tooltip${hashes.length === 1 ? '' : 's'}`;
  return new Intl.ListFormat('en').format([
    ...(globals.length > 3 ? [`${globals.length} globals`] : globals.map(({ name }) => name)),
    ...(hashes.length || !globals.length ? [tooltips] : []),
  ]);
}

/**
 * The one place statuses become words. Wording keeps "nothing went live" explicit when true.
 * `combining`: every part has finished and the group is reading receipts or combining refusals, so
 * nothing is queued and Retry would do nothing.
 */
export function describeOp(
  op: PublishOp,
  note: string | undefined,
  now: number,
  when: When,
  combining = false,
  liveCount?: number,
): OpView {
  const count = changeCount(op);
  const startedAt = op.groupCreatedAt ?? op.createdAt;
  const tooltipCount = changeNames(op);
  const lead =
    liveCount !== undefined && !isTerminal(op.status)
      ? `${liveCount} of ${count} ${op.globals ? 'changes' : 'tooltips'} live.`
      : op.status === 'done' || op.status === 'pending'
        ? tooltipCount
        : `${tooltipCount} · ${when(startedAt)}`;
  const base = { opId: op.opId, lead, waiting: false, finished: isTerminal(op.status) };
  switch (op.status) {
    case 'created':
      return {
        ...base,
        tone: 'busy',
        chip: op.syncPendingSince === undefined ? 'Sending…' : 'Checking…',
        detail:
          note ??
          (op.syncPendingSince === undefined ? 'Sending the publish request.' : publishProofWait),
      };
    case 'pending': {
      if (combining)
        return { ...base, tone: 'busy', chip: 'Checking…', detail: note ?? 'Checking results.' };
      const acceptedAt = op.acceptedAt ?? op.createdAt;
      const waiting = now - acceptedAt >= publishTiming.waitingMs;
      return waiting
        ? {
            ...base,
            waiting,
            tone: 'warn',
            chip: 'Waiting',
            detail: note ?? `Queued ${when(acceptedAt)}.`,
          }
        : {
            ...base,
            tone: 'busy',
            chip: 'Queued',
            detail: note ?? 'Waiting for confirmation.',
          };
    }
    case 'done':
      return {
        ...base,
        tone: 'ok',
        chip: 'Published',
        detail: `Confirmed live after ${elapsed(startedAt, op.updatedAt)}.`,
      };
    case 'unchanged':
      return {
        ...base,
        tone: 'ok',
        chip: 'Already live',
        detail: `Live already matched these ${op.globals ? 'changes' : 'tooltips'}.`,
      };
    case 'stale':
      return {
        ...base,
        tone: 'warn',
        chip: 'Changed',
        detail:
          op.error ??
          'Saved text changed since review. Nothing from this request went live; review and publish again.',
      };
    case 'rejected':
      return {
        ...base,
        tone: 'bad',
        chip: 'Rejected',
        detail:
          op.error ?? 'The publisher refused this request. Nothing went live; check the tooltips.',
      };
    case 'failed':
      return {
        ...base,
        tone: 'bad',
        chip: 'Failed',
        detail:
          op.error ?? 'The publish run failed. Check live status before publishing these again.',
      };
  }
}

/** Entries the bundle reports in the Worker's publish queue that are not this account's own. */
export function foreignWaiting(
  queue: readonly { opId: string; createdAt?: string; invalid?: true }[] | undefined,
  ownIds: ReadonlySet<string>,
  now: number,
): { count: number; since: number; opId: string } | undefined {
  const waiting = (queue ?? [])
    .filter((entry): entry is { opId: string; createdAt: string } =>
      Boolean(entry.createdAt && !entry.invalid && !ownIds.has(entry.opId)),
    )
    .map((entry) => ({ opId: entry.opId, since: Date.parse(entry.createdAt) }))
    .filter((entry) => Number.isFinite(entry.since) && now - entry.since >= publishTiming.waitingMs)
    .sort((a, b) => a.since - b.since);
  return waiting.length
    ? { count: waiting.length, since: waiting[0]!.since, opId: waiting[0]!.opId }
    : undefined;
}

/**
 * Present one confirmed action; a queued part wins over one still sending, and both win over
 * partial success or failure. `checking`: combining with every part finished (nothing to kick).
 */
export function groupPublishes(
  ops: readonly PublishOp[],
): { op: PublishOp; members: PublishOp[]; liveCount?: number; checking?: boolean }[] {
  const groups = new Map<string, PublishOp[]>();
  for (const op of ops) {
    const id = op.groupId ?? op.opId;
    const members = groups.get(id) ?? [];
    members.push(op);
    groups.set(id, members);
  }
  return [...groups.values()].map((members) => {
    const first = members[0]!;
    const tooltips = members.reduce((total, op) => total + op.hashes.length, 0);
    const count = members.reduce((total, op) => total + changeCount(op), 0);
    const globals = members.flatMap((op) => op.globals ?? []);
    const missing =
      first.groupHashCount === undefined
        ? members.length < (first.groupSize ?? members.length)
        : tooltips !== first.groupHashCount;
    const unfinished =
      members.find((op) => op.status === 'pending') ?? members.find((op) => !isTerminal(op.status));
    const combining =
      (unfinished?.round ?? 0) > 0 ||
      members.some(needsPublishReceipt) ||
      (members.some((op) => op.refusal !== undefined) && regroupRefusals(members).length > 0);
    if (members.length === 1 && !missing && !combining) return { op: first, members };
    const failures = members.filter(
      (op) => isTerminal(op.status) && op.status !== 'done' && op.status !== 'unchanged',
    );
    const failed = failures[0];
    const refused = failures.flatMap((op) =>
      op.refusal !== undefined && op.error ? [op.error] : [],
    );
    const successful = members
      .filter((op) => op.status === 'done' || op.status === 'unchanged')
      .reduce((count, op) => count + changeCount(op), 0);
    return {
      members,
      liveCount: first.groupId ? successful : undefined,
      checking: combining && !unfinished,
      op: {
        ...first,
        groupCreatedAt: Math.min(...members.map((op) => op.groupCreatedAt ?? op.createdAt)),
        updatedAt: Math.max(...members.map((op) => op.updatedAt)),
        // Waiting (and Retry) is timed from the queued part, e.g. a resent combination.
        acceptedAt: unfinished ? (unfinished.acceptedAt ?? unfinished.createdAt) : first.acceptedAt,
        syncPendingSince: unfinished?.syncPendingSince,
        hashes: members.flatMap((op) => op.hashes),
        ...(globals.length ? { globals } : {}),
        status: missing
          ? 'failed'
          : unfinished
            ? unfinished.status
            : combining
              ? 'pending'
              : failed
                ? 'failed'
                : members.every((op) => op.status === 'unchanged')
                  ? 'unchanged'
                  : 'done',
        error: missing
          ? 'Some local publish records are unavailable. Check live status before publishing again.'
          : failed
            ? `Publish incomplete: ${successful} of ${count} ${globals.length ? 'changes' : 'tooltips'} confirmed live.${
                // The first failed part's own reason (e.g. the Worker's error), so the grouped
                // row still says why; it describes that part only, never the whole group.
                // Each refusal names at most ten tooltips; list three parts, then count the rest.
                refused.length
                  ? ` ${refused.slice(0, 3).join(' ')}${
                      refused.length > 3 ? ` ${refused.length - 3} more parts were refused.` : ''
                    }`
                  : failed.error
                    ? ` First failed part (${failed.hashes.length} tooltips): ${failed.error}`
                    : ''
              } Check live status before publishing again.`
            : undefined,
      },
    };
  });
}

import { isTerminal, type PublishOp } from '../../services/publisher/opStore';
import { needsPublishReceipt, publishTiming, regroupRefusals } from './publishDriver';

export type Tone = 'busy' | 'ok' | 'warn' | 'bad';
export interface OpView {
  opId: string;
  tone: Tone;
  /** Short status chip, fixed width in the UI. */
  chip: string;
  /** What the line says after the count and start time. */
  detail: string;
  /** "3 tooltips · 14:05": the line's fixed lead-in. */
  lead: string;
  /** A queued part has not been picked up for a while: Retry kicks it. */
  waiting: boolean;
  /** Finished: can be dismissed. */
  finished: boolean;
}

/** Formats a timestamp for display: the shared formatter with the user's date settings. */
export type When = (ms: number) => string;

/** Long final reasons (many hashes, converter messages) stay readable in one Activity line. */
const reasonChars = 500;
const clampReason = (text: string) =>
  text.length <= reasonChars ? text : `${text.slice(0, reasonChars - 1).trimEnd()}…`;

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
): OpView {
  const count = op.hashes.length;
  const lead = `${count} tooltip${count === 1 ? '' : 's'} · ${when(op.createdAt)}`;
  const base = { opId: op.opId, lead, waiting: false, finished: isTerminal(op.status) };
  switch (op.status) {
    case 'created':
      return {
        ...base,
        tone: 'busy',
        chip: 'Sending…',
        detail:
          note ??
          (op.syncPendingSince === undefined
            ? 'Saved on this device; sending to the publisher.'
            : 'Sync pending. Publishing will continue automatically.'),
      };
    case 'pending': {
      if (combining)
        return { ...base, tone: 'busy', chip: 'Combining…', detail: note ?? 'Combining parts…' };
      const waiting = now - (op.acceptedAt ?? op.createdAt) >= publishTiming.waitingMs;
      return waiting
        ? {
            ...base,
            waiting,
            tone: 'warn',
            chip: 'Waiting',
            detail: note ?? 'No publish run has started yet. Retry starts one.',
          }
        : {
            ...base,
            tone: 'busy',
            chip: 'Publishing…',
            detail: note ?? 'Queued. A publish run goes live in a minute or two.',
          };
    }
    case 'done':
      return { ...base, tone: 'ok', chip: 'Published', detail: 'Live for everyone.' };
    case 'unchanged':
      return {
        ...base,
        tone: 'ok',
        chip: 'Already live',
        detail: 'Live already matched these tooltips.',
      };
    case 'stale':
      return {
        ...base,
        tone: 'warn',
        chip: 'Changed',
        detail: op.error
          ? clampReason(op.error)
          : 'Saved text changed since review. Nothing from this request went live; review and publish again.',
      };
    case 'rejected':
      return {
        ...base,
        tone: 'bad',
        chip: 'Rejected',
        detail: op.error
          ? clampReason(op.error)
          : 'The publisher refused this request. Nothing went live; check the tooltips.',
      };
    case 'failed':
      return {
        ...base,
        tone: 'bad',
        chip: 'Failed',
        detail: op.error
          ? clampReason(op.error)
          : 'The publish run failed. Check live status before publishing these again.',
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
): { op: PublishOp; members: PublishOp[]; combining?: boolean; checking?: boolean }[] {
  const groups = new Map<string, PublishOp[]>();
  for (const op of ops) {
    const id = op.groupId ?? op.opId;
    const members = groups.get(id) ?? [];
    members.push(op);
    groups.set(id, members);
  }
  return [...groups.values()].map((members) => {
    const first = members[0]!;
    const count = members.reduce((total, op) => total + op.hashes.length, 0);
    const missing =
      first.groupHashCount === undefined
        ? members.length < (first.groupSize ?? members.length)
        : count !== first.groupHashCount;
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
      .reduce((count, op) => count + op.hashes.length, 0);
    return {
      members,
      combining,
      checking: combining && !unfinished,
      op: {
        ...first,
        // Waiting (and Retry) is timed from the queued part, e.g. a resent combination.
        acceptedAt: unfinished ? (unfinished.acceptedAt ?? unfinished.createdAt) : first.acceptedAt,
        hashes: members.flatMap((op) => op.hashes),
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
            ? `Publish incomplete: ${successful} of ${count} tooltips confirmed live.${
                // The first failed part's own reason (e.g. the Worker's error), so the grouped
                // row still says why; it describes that part only, never the whole group.
                refused.length
                  ? ` ${refused.join(' ')}`
                  : failed.error
                    ? ` First failed part (${failed.hashes.length} tooltips): ${failed.error}`
                    : ''
              } Check live status before publishing again.`
            : undefined,
      },
    };
  });
}

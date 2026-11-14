import { isTerminal, type PublishOp } from '../../services/publisher/opStore';
import { publishTiming } from './publishDriver';

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
  /** No publish run has picked this up for a while: offer Retry. */
  waiting: boolean;
  /** Finished: can be dismissed. */
  finished: boolean;
}

/** Formats a timestamp for display: the shared formatter with the user's date settings. */
export type When = (ms: number) => string;

/** The one place statuses become words. Wording keeps "nothing went live" explicit when true. */
export function describeOp(
  op: PublishOp,
  note: string | undefined,
  now: number,
  when: When,
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
        detail: note ?? 'Saved on this device; sending to the publisher.',
      };
    case 'pending': {
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

/** Present one confirmed action; pending always wins over partial success or failure. */
export function groupPublishes(
  ops: readonly PublishOp[],
): { op: PublishOp; members: PublishOp[] }[] {
  const groups = new Map<string, PublishOp[]>();
  for (const op of ops) {
    const id = op.groupId ?? op.opId;
    const members = groups.get(id) ?? [];
    members.push(op);
    groups.set(id, members);
  }
  return [...groups.values()].map((members) => {
    const first = members[0]!;
    const missing = members.length < (first.groupSize ?? members.length);
    if (members.length === 1 && !missing) return { op: first, members };
    const unfinished = members.find((op) => !isTerminal(op.status));
    const failed = members.find(
      (op) => isTerminal(op.status) && op.status !== 'done' && op.status !== 'unchanged',
    );
    const successful = members
      .filter((op) => op.status === 'done' || op.status === 'unchanged')
      .reduce((count, op) => count + op.hashes.length, 0);
    return {
      members,
      op: {
        ...first,
        hashes: members.flatMap((op) => op.hashes),
        status: missing
          ? 'failed'
          : unfinished
            ? 'pending'
            : failed
              ? 'failed'
              : members.every((op) => op.status === 'unchanged')
                ? 'unchanged'
                : 'done',
        error: missing
          ? 'Some local publish records are unavailable. Check live status before publishing again.'
          : failed
            ? `Publish incomplete: ${successful} of ${members.reduce((count, op) => count + op.hashes.length, 0)} tooltips confirmed live.${
                // The first failed part's own reason (e.g. the Worker's error), so the grouped
                // row still says why; it describes that part only, never the whole group.
                failed.error
                  ? ` First failed part (${failed.hashes.length} tooltips): ${failed.error}`
                  : ''
              } Check live status before publishing again.`
            : undefined,
      },
    };
  });
}

import type { Tooltip } from '@clarity/core';

type Archive = Tooltip['archive'];

export function formatArchiveDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

/** Readable history line for an `archive` change; undefined when unchanged. */
export function archiveChangeLine(before: Archive, after: Archive): string | undefined {
  if (JSON.stringify(before) === JSON.stringify(after)) return undefined;
  if (!after) return 'Archive: restored from the Archive (archive flag cleared)';
  if (!before)
    return `Archive: archived as "${after.lastSeen.name}" (removed ${formatArchiveDate(after.removedAt)})`;
  if (after.successor !== before.successor)
    return after.successor === undefined
      ? 'Archive: successor cleared'
      : `Archive: successor set to ${after.successor}`;
  return 'Archive: archive details edited';
}

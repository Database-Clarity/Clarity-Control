import type { Tooltip } from '@clarity/core';
import { formatDate, parseDate, type DateSettings } from '../../services/format/date';
import { useSettingsStore } from '../../stores/settings';

type Archive = Tooltip['archive'];

/** Removal date in the user's date settings; unparseable values are shown as stored. */
export function formatArchiveDate(
  iso: string,
  settings: DateSettings = useSettingsStore.getState().settings,
): string {
  return parseDate(iso) ? formatDate(iso, settings) : iso;
}

/** Readable history line for an `archive` change; undefined when unchanged. */
export function archiveChangeLine(
  before: Archive,
  after: Archive,
  settings?: DateSettings,
): string | undefined {
  if (JSON.stringify(before) === JSON.stringify(after)) return undefined;
  if (!after) return 'Archive: restored from the Archive (archive flag cleared)';
  if (!before)
    return `Archive: archived as "${after.lastSeen.name}" (removed ${formatArchiveDate(after.removedAt, settings)})`;
  if (after.successor !== before.successor)
    return after.successor === undefined
      ? 'Archive: successor cleared'
      : `Archive: successor set to ${after.successor}`;
  return 'Archive: archive details edited';
}

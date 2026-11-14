import { bungieDrift, removedFromManifest, type Tooltip } from '@clarity/core';
import type { Drafts } from '../../services/draftStorage';
import type { EditorData } from '../../stores/data';
import { isSetSelector } from '../compendium/itemClassification';
import { archiveIdentity, inactiveArchiveHashes } from '../archive/archive';
import type { QueueItem } from './model';

import { archiveState, type ArchiveRestore } from './sources';

/**
 * The lists' rows as queue items: used by the list pages to start a queue and, loaded on demand,
 * by Rebuild queue. Kept apart from sources.ts so the editor never loads the lists' code until a
 * rebuild asks for it.
 */

export function driftRows(data: EditorData, query: string): QueueItem[] {
  const search = query.trim().toLocaleLowerCase();
  return bungieDrift(
    Object.values(data.bundle.tooltips).filter(
      (tooltip) => !data.items[tooltip.hash] || !isSetSelector(data.items[tooltip.hash]),
    ),
    data.items,
    data.aliases,
  )
    .changed.filter(
      ({ tooltip }) =>
        String(tooltip.hash).includes(search) ||
        data.items[tooltip.hash]?.name.toLocaleLowerCase().includes(search),
    )
    .map(({ tooltip }) => ({
      key: String(tooltip.hash),
      hash: tooltip.hash,
      name: data.items[tooltip.hash]?.name ?? String(tooltip.hash),
    }));
}

export function archiveItem(tooltip: Tooltip, data: EditorData, drafts: Drafts): QueueItem {
  return {
    key: String(tooltip.hash),
    hash: tooltip.hash,
    name: archiveIdentity(tooltip, data).name,
    detail: archiveState(drafts[tooltip.hash]?.next ?? tooltip),
  };
}

export function archiveRows(
  data: EditorData,
  filters: Pick<ArchiveRestore, 'returned' | 'query'>,
): Tooltip[] {
  const result = removedFromManifest(
    Object.values(data.bundle.tooltips),
    data.items,
    data.aliases,
    inactiveArchiveHashes(data),
  );
  return (filters.returned ? result.returned : result.removed).filter((tooltip) =>
    `${archiveIdentity(tooltip, data).name} ${tooltip.hash}`
      .toLocaleLowerCase()
      .includes(filters.query.toLocaleLowerCase()),
  );
}

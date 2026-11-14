import type { QueueItem, WorkQueue } from './model';
import type { SourceContext, TranslationsRestore } from './sources';
import { upcomingStore } from '../tooltip/UpcomingSwitch.store';
import { batchDraftKey, useBatchDraftStore } from '../../services/scheduled/batchDrafts';
import {
  upcomingRows,
  filterUpcoming,
  upcomingRowState,
  parseUpcomingFilter,
} from '../translations/upcoming';
import { ensureBatch, refreshBatches } from '../tooltip/UpcomingSwitch.load';
import { tooltipPath } from '../navigation/stepping';
import { canonicalHash } from '../navigation/catalog';
import { merged } from './model';

export function subscribe(listener: () => void) {
  const stopBatch = useBatchDraftStore.subscribe(listener);
  const stopUpcoming = upcomingStore().subscribe(listener);
  return () => {
    stopBatch();
    stopUpcoming();
  };
}
export function done(queue: WorkQueue, context: SourceContext, item: QueueItem): boolean {
  const destination = queue.destination;
  if (
    !destination ||
    !item.lang ||
    !context.user ||
    !['maintainer', 'editor', 'translator'].includes(context.user.role ?? '')
  )
    return false;
  if (context.user.role === 'translator' && !context.user.languages?.includes(item.lang))
    return false;
  const state = upcomingStore().getState();
  const batch = state.memberOf[item.hash];
  const load = state.loads[destination.batchId];
  if (
    state.listFailed ||
    batch?.id !== destination.batchId ||
    load?.state !== 'ready' ||
    load.revision !== batch.revision
  )
    return false;
  const member = load.upcoming.members[item.hash];
  const future = load.upcoming.overlay[item.hash]?.next;
  if (!member || !future) return false;
  const local = useBatchDraftStore.getState();
  const staged =
    local.hydrated && local.owner === String(context.user.id)
      ? local.drafts[batchDraftKey(destination.batchId, item.hash)]
      : undefined;
  // The completion rule includes local batch text; discarding it reopens the row.
  const proposed = staged?.next ?? member.proposed;
  return (
    upcomingRowState(
      { ...member, proposed },
      context.data.bundle.tooltips[item.hash],
      staged
        ? { ...future, text: { ...future.text, [item.lang]: staged.next.text[item.lang] } }
        : future,
      item.lang,
    ).state === 'ready'
  );
}
export async function rebuild(queue: WorkQueue, context: SourceContext): Promise<QueueItem[]> {
  const id = queue.destination?.batchId;
  if (!id) return [];
  const user = context.user;
  const language = (queue.origin.restore as TranslationsRestore).language;
  if (
    !user ||
    !['maintainer', 'editor', 'translator'].includes(user.role ?? '') ||
    (user.role === 'translator' && !user.languages?.includes(language))
  )
    throw new Error('This account cannot work on the destination language.');
  await refreshBatches();
  ensureBatch(id);
  const state = upcomingStore().getState();
  const batch = Object.values(state.memberOf).find((batch) => batch.id === id);
  const load = state.loads[id];
  if (!batch || load?.state !== 'ready' || load.revision !== batch.revision)
    throw new Error('Reload the destination batch before rebuilding.');
  const restore = queue.origin.restore as TranslationsRestore & { upcomingState?: string };
  const rows = filterUpcoming(
    upcomingRows(context.data, [{ batch, upcoming: load.upcoming }], restore.language),
    {
      state: parseUpcomingFilter(restore.upcomingState ?? null),
      category: restore.category,
      query: restore.query,
    },
  );
  return merged(
    queue,
    rows.map((row) => {
      const canonical = canonicalHash(row.hash, context.data);
      const query = new URLSearchParams({ lang: row.language });
      if (canonical !== row.hash) query.set('variant', String(row.hash));
      return {
        key: row.key,
        hash: row.hash,
        lang: row.language,
        name: row.name,
        detail: { path: tooltipPath(canonical, query.toString()), batchId: id },
      };
    }),
  );
}

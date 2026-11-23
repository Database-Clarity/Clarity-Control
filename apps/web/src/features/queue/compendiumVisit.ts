import type { WorkThrough } from './useQueue';

/**
 * Names the visit (or the run of visits) that opens the Compendium view, for VariantWorkspace: a
 * Source changes entry does each time; a parity run once, so stepping keeps the view in use. On a
 * phone a run opens on the editor like every other, where the queue and its steps are.
 */
export function compendiumVisit(state: unknown, work: WorkThrough | null, phone: boolean): unknown {
  if (work?.mode === 'active' && work.queue.source === 'parity')
    return phone ? undefined : work.queue.id;
  return (state as { pane?: unknown } | null)?.pane === 'compendium' ? state : undefined;
}

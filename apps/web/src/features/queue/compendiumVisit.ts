import type { WorkThrough } from './useQueue';

/** A visit (or a run of visits) with a view of its own to open, once, for VariantWorkspace. */
export interface ViewVisit {
  id: unknown;
  view: 'compendium' | 'translation';
}

/**
 * A Source changes entry opens the Compendium each time, a parity run once, so stepping keeps the
 * view in use. On a phone a run starts on the editor like every other, where its steps are.
 */
export function compendiumVisit(
  state: unknown,
  work: WorkThrough | null,
  phone: boolean,
): ViewVisit | undefined {
  if (work?.mode === 'active' && work.queue.source === 'parity')
    return { id: work.queue.id, view: phone ? 'translation' : 'compendium' };
  return (state as { pane?: unknown } | null)?.pane === 'compendium'
    ? { id: state, view: 'compendium' }
    : undefined;
}

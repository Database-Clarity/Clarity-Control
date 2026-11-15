/**
 * Review changes: the Saved | Batches subview (scheduled changes, spec "Editor UX"). The choice
 * lives in the URL (`view=batches`, the open batch in `batch=<id>`), so Back/Forward and reload
 * keep it. Batches exist only with the build switch ON (I6) and for the roles that may read them
 * (maintainer, editor, translator; trials get no batch access, Q3): otherwise the view is always
 * Saved and nothing about batches renders or loads. The switch test is inline, so a switch-OFF
 * build drops the Batches chunk.
 */
import { lazy } from 'react';
import type { User } from '../../services/api';

export type ReviewSubview = 'saved' | 'batches';

export const batchReaders: readonly NonNullable<User['role']>[] = [
  'maintainer',
  'editor',
  'translator',
];

export function canReadBatches(user: User | null | undefined): boolean {
  return (
    import.meta.env.VITE_SCHEDULED_ENABLED === '1' &&
    !!user?.role &&
    batchReaders.includes(user.role)
  );
}

export function reviewSubview(
  params: URLSearchParams,
  user: User | null | undefined,
): ReviewSubview {
  return canReadBatches(user) && params.get('view') === 'batches' ? 'batches' : 'saved';
}

/** The URL for a subview: Saved keeps its own params (filters, open change); Batches its batch. */
export function subviewParams(params: URLSearchParams, view: ReviewSubview): URLSearchParams {
  const next = new URLSearchParams(params);
  if (view === 'batches') next.set('view', 'batches');
  else next.delete('view');
  return next;
}

// The Batches chunk; a switch-OFF build has neither the import nor these components (null).
const chunk = () =>
  import.meta.env.VITE_SCHEDULED_ENABLED === '1'
    ? import('./batches/BatchesPane')
    : Promise.reject(new Error('Scheduled changes are off'));

/** The Saved | Batches switch for the Review header line. */
export const SubviewSwitch =
  import.meta.env.VITE_SCHEDULED_ENABLED === '1'
    ? lazy(() => chunk().then((module) => ({ default: module.SubviewSwitch })))
    : null;
/** The Batches header counts and Refresh. */
export const BatchesHeader =
  import.meta.env.VITE_SCHEDULED_ENABLED === '1'
    ? lazy(() => chunk().then((module) => ({ default: module.BatchesHeader })))
    : null;
/** The open batch's detail (main column). */
export const BatchesMain =
  import.meta.env.VITE_SCHEDULED_ENABLED === '1'
    ? lazy(() => chunk().then((module) => ({ default: module.BatchesMain })))
    : null;
/** The batch list (left column and the phone's list sheet). */
export const BatchesList =
  import.meta.env.VITE_SCHEDULED_ENABLED === '1'
    ? lazy(() => chunk().then((module) => ({ default: module.BatchesList })))
    : null;

/** Starts loading the Batches chunk early for a reader, so the header switch never pops in late. */
export function preloadBatches(user: User | null | undefined) {
  if (import.meta.env.VITE_SCHEDULED_ENABLED === '1' && canReadBatches(user)) void chunk();
}

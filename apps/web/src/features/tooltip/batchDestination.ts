/** Lazy batch authoring. A requested destination never falls back to Current. */
import { createElement, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { Lang, Tooltip, MarkupGlobals } from '@clarity/core';
import { useAuthStore } from '../../stores/auth';
import type { Drafts } from '../../services/draftStorage';
import type { BatchLoad, OpenBatch } from './UpcomingSwitch.store';

export interface BatchDestination {
  kind: 'batch';
  batchId: string;
  batchName: string;
}
export interface BatchEditing {
  destination: BatchDestination;
  drafts: Drafts;
  reason: string | null;
  saveControl?: ReactNode;
  english(
    hash: number,
    current: string | undefined,
    upcoming: string,
    globals: MarkupGlobals,
  ): ReactNode;
  edit(base: Tooltip, lang: Lang, text: string, author: string): void;
  discard(hash: number): void;
}
const empty: Drafts = {};
const noop = () => () => {};
const nothing = () => undefined;
export function useBatchEditing(
  destination: BatchDestination | undefined,
  batch: OpenBatch | undefined,
  load: BatchLoad | undefined,
  eligible: boolean,
  listFailed: boolean,
): BatchEditing | undefined {
  const auth = useAuthStore();
  const [runtimeError, setRuntimeError] = useState<string>();
  const destinationId = destination?.batchId;
  const [runtime, setRuntime] = useState<typeof import('./batchDestination.live')>();
  useEffect(() => {
    if (destinationId && eligible)
      void import('./batchDestination.live').then(setRuntime, () =>
        setRuntimeError('Read-only: batch editing did not load. Reload to retry.'),
      );
  }, [destinationId, eligible]);
  const state = useSyncExternalStore(runtime?.subscribe ?? noop, runtime?.snapshot ?? nothing);
  if (!destination) return undefined;
  const reason = !eligible
    ? 'Read-only: this account has no batch access.'
    : runtimeError
      ? runtimeError
      : !runtime || !state?.hydrated
        ? 'Read-only: loading batch drafts.'
        : !state.owner || auth.loading || state.owner !== String(auth.user?.id)
          ? 'Read-only: loading this account’s batch drafts.'
          : state.external
            ? 'Read-only: another tab changed these batch drafts. Reload before editing.'
            : state.error
              ? `Read-only: ${state.error}`
              : listFailed
                ? 'Read-only: the batch listing did not load. Retry before editing.'
                : !batch
                  ? 'Read-only: this batch is no longer open. Your drafts are kept.'
                  : batch.status === 'publishing'
                    ? 'Read-only: this batch is publishing. Your drafts are kept.'
                    : load?.state !== 'ready' || load.revision !== batch.revision
                      ? 'Read-only: loading the latest batch revision.'
                      : null;
  const editing: BatchEditing = {
    destination,
    english: (hash, current, upcoming, globals) =>
      runtime && eligible
        ? createElement(runtime.BatchEnglish, { hash, current, upcoming, globals })
        : null,
    drafts:
      runtime && state && eligible && state.owner === String(auth.user?.id)
        ? runtime.drafts(state.drafts, destination.batchId)
        : empty,
    reason,
    edit(base, lang, text, author) {
      if (reason || !runtime || load?.state !== 'ready') return;
      const member = load.upcoming.members[base.hash];
      const future = load.upcoming.overlay[base.hash]?.next;
      if (!member || !future || (batch?.status === 'scheduled' && lang === 'en')) return;
      runtime.edit(destination.batchId, member.proposed, future, lang, text, author);
    },
    discard(hash) {
      if (!reason) runtime?.discard(destination.batchId, hash);
    },
  };
  if (runtime && eligible) editing.saveControl = createElement(runtime.BatchSave, { editing });
  return editing;
}

import { useEffect, useMemo } from 'react';
import { useDataStore } from '../../stores/data';
import { useCompendiumStore } from './store';
import { compendiumChanges } from './tracking';
import { useDisplayMatches } from './useDisplayMatches';
import { useDraftStore } from '../../stores/drafts';
import { useAuthStore } from '../../stores/auth';
import { groupManifestItems } from './manifestItems';
import { preparedEvidence, preparedProposals, reviewedEntries } from './reviewViewCache';
import { peekMatchingSession } from './matchingSession';
import { readProgress, reviewStorageKey } from './reviewProgress';
import { bundleUrl } from '../../services/bundle';
import { compendiumDataUrl } from '../../services/compendium';
import { apiUrl } from '../../services/api';
import { pickerRowIndex } from './pickerRows';

export type CompendiumCount =
  { state: 'loading' } | { state: 'error' } | { state: 'ready'; count: number };

/** Number of Compendium changes waiting for review. One load owner: whoever mounts this first. */
export function useCompendiumCount(): CompendiumCount {
  const editor = useDataStore((state) => state.data);
  const tooltips = editor?.bundle.tooltips;
  const drafts = useDraftStore((state) => state.drafts);
  const userId = useAuthStore((state) => state.user?.id);
  const { data, error, load } = useCompendiumStore();
  const { prepared } = useDisplayMatches(editor, data, drafts, userId);
  useEffect(() => {
    if (!editor || !data || !prepared) return;
    // Prepare the entire review model fairly, regardless of viewport, selection or route.
    // Separate idle jobs keep this work out of editor input and foreground navigation.
    const evidence = () =>
      preparedEvidence(prepared, useDraftStore.getState().drafts, editor, data);
    const jobs = [
      ...data.tabs.map((tab) => () => {
        pickerRowIndex(tab);
      }),
      () => groupManifestItems(editor.items, editor.aliases),
      () => {
        try {
          const key = reviewStorageKey(
            `${bundleUrl}|${compendiumDataUrl}|${apiUrl ?? 'read-only'}`,
            userId,
          );
          reviewedEntries(evidence(), readProgress(localStorage, key));
        } catch {
          // The review view owns the existing invalid-progress recovery/error flow.
        }
      },
      () => {
        const core = peekMatchingSession(editor, data)?.currentProposals;
        if (core) preparedProposals(prepared, core);
      },
    ];
    let cancelled = false;
    let idle: number | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      const next = () => {
        if (cancelled) return;
        jobs.shift()?.();
        if (jobs.length) schedule();
      };
      if ('requestIdleCallback' in window) idle = window.requestIdleCallback(next);
      else timer = setTimeout(next, 0);
    };
    schedule();
    return () => {
      cancelled = true;
      if (idle !== undefined) window.cancelIdleCallback(idle);
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [editor, data, prepared, userId]);
  useEffect(() => {
    const start = () => {
      void load();
      void import('./MatchReviewPage');
      // Any source can contain sheet glyphs. Load their shared face during idle prefetch,
      // rather than fetching it on the first entry that happens to use one.
      void document.fonts?.load('16px DestinySymbols').catch(() => undefined);
    };
    if ('requestIdleCallback' in window) {
      const id = window.requestIdleCallback(start, { timeout: 1500 });
      return () => window.cancelIdleCallback(id);
    }
    const id = setTimeout(start, 0);
    return () => clearTimeout(id);
  }, [load]);
  const count = useMemo(
    () => (tooltips && data ? compendiumChanges(tooltips, data).length : null),
    [tooltips, data],
  );
  if (error) return { state: 'error' };
  return count === null ? { state: 'loading' } : { state: 'ready', count };
}

/**
 * The count on a workspace tab: shown only when above zero, with an accessible name; an error
 * shows "!" and a loading count stays visually quiet but is announced.
 */
export function CompendiumBadge({
  count,
  className,
}: {
  count: CompendiumCount;
  className?: string;
}) {
  if (count.state === 'loading') return <span className="sr-only">Compendium changes loading</span>;
  if (count.state === 'error')
    return (
      <span className={className} role="img" aria-label="Compendium unavailable">
        !
      </span>
    );
  if (count.count === 0) return null;
  return (
    <span className={className} role="img" aria-label={`${count.count} Compendium changes`}>
      {count.count}
    </span>
  );
}

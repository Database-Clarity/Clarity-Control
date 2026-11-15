import { useEffect, useMemo } from 'react';
import { useDataStore } from '../../stores/data';
import { useCompendiumStore } from './store';
import { compendiumChanges } from './tracking';
import { useDisplayMatches } from './useDisplayMatches';
import { useDraftStore } from '../../stores/drafts';
import { useAuthStore } from '../../stores/auth';
import { groupManifestItems } from './manifestItems';
import { preparedEvidence, warmPreparedProposals, reviewedEntries } from './reviewViewCache';
import { peekMatchingSession, prewarmMatchingSession } from './matchingSession';
import { readProgress, reviewStorageKey } from './reviewProgress';
import { bundleUrl } from '../../services/bundle';
import { compendiumDataUrl, pendingCompendiumWorker } from '../../services/compendium';
import { apiUrl } from '../../services/api';
import { pickerIdleScheduler, warmPickerRowIndexes } from './pickerRows';
import { preloadCompendiumTab } from './LazyCompendiumTab';

export type CompendiumCount =
  { state: 'loading' } | { state: 'error' } | { state: 'ready'; count: number };

/**
 * Number of Compendium changes waiting for review. One load owner: whoever mounts this first.
 * `loads` false (translators: they see only the snapshot saved with the English, owner
 * 2026-11-10) never fetches or prefetches the live sheet.
 */
export function useCompendiumCount(loads = true): CompendiumCount {
  const editor = useDataStore((state) => state.data);
  const tooltips = editor?.bundle.tooltips;
  const { data, error, load } = useCompendiumStore();
  useEffect(() => {
    if (!loads || !editor || data) return;
    void load();
    const bridge = pendingCompendiumWorker();
    if (bridge) prewarmMatchingSession(editor, bridge);
  }, [loads, editor, data, load]);
  useEffect(() => {
    if (!loads) return;
    const start = () => {
      void load();
      void preloadCompendiumTab();
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
  }, [loads, load]);
  const count = useMemo(
    () => (tooltips && data ? compendiumChanges(tooltips, data).length : null),
    [tooltips, data],
  );
  if (error) return { state: 'error' };
  return count === null ? { state: 'loading' } : { state: 'ready', count };
}

/**
 * Speculative review preparation subscribes to drafts. Callers of useCompendiumCount render
 * it beside their content, so a keystroke re-renders this null component, not the header.
 */
export function CompendiumWarmup() {
  const editor = useDataStore((state) => state.data);
  const data = useCompendiumStore((state) => state.data);
  const drafts = useDraftStore((state) => state.drafts);
  const userId = useAuthStore((state) => state.user?.id);
  const { prepared } = useDisplayMatches(editor, data, drafts, userId);
  useEffect(() => {
    if (!editor || !data || !prepared) return;
    // Prepare the entire review model fairly, regardless of viewport, selection or route.
    // Separate idle jobs keep this work out of editor input and foreground navigation.
    const evidence = () =>
      preparedEvidence(prepared, useDraftStore.getState().drafts, editor, data);
    const cancelIndexWarmup = warmPickerRowIndexes(data.tabs);
    let cancelProposals: (() => void) | undefined;
    const jobs = [
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
        if (core) cancelProposals = warmPreparedProposals(prepared, core);
      },
    ];
    const idle = pickerIdleScheduler(() => {
      jobs.shift()?.();
      if (jobs.length) idle.schedule();
      else idle.cancel();
    });
    idle.schedule();
    return () => {
      cancelIndexWarmup();
      cancelProposals?.();
      idle.cancel();
    };
  }, [editor, data, prepared, userId]);
  return null;
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

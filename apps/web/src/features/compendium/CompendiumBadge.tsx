import { useEffect, useMemo } from 'react';
import { useDataStore } from '../../stores/data';
import { useCompendiumStore } from './store';
import { compendiumChanges } from './tracking';
import { useDisplayMatches } from './useDisplayMatches';
import { useDraftStore } from '../../stores/drafts';
import { useAuthStore } from '../../stores/auth';

export type CompendiumCount =
  { state: 'loading' } | { state: 'error' } | { state: 'ready'; count: number };

/** Number of Compendium changes waiting for review. One load owner: whoever mounts this first. */
export function useCompendiumCount(): CompendiumCount {
  const editor = useDataStore((state) => state.data);
  const tooltips = editor?.bundle.tooltips;
  const drafts = useDraftStore((state) => state.drafts);
  const userId = useAuthStore((state) => state.user?.id);
  const { data, error, load } = useCompendiumStore();
  useDisplayMatches(editor, data, drafts, userId);
  useEffect(() => {
    const start = () => {
      void load();
      void import('./MatchReviewPage');
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

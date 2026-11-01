import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { bundleUrl } from '../../services/bundle';
import { compendiumDataUrl } from '../../services/compendium';
import { GuidancePersistence } from './guidancePersistence';
import type { ReviewCategory } from './reviewCategories';

export function useGuidance(categories: ReviewCategory[], baseline: string) {
  const persistence = useMemo(
    () =>
      new GuidancePersistence(
        `${bundleUrl}|${compendiumDataUrl}`,
        new URL(`${import.meta.env.BASE_URL}__review-guidance`, window.location.href).href,
        {
          getItem: (key) => localStorage.getItem(key),
          setItem: (key, value) => localStorage.setItem(key, value),
        },
      ),
    [],
  );
  const state = useSyncExternalStore(persistence.subscribe, persistence.getSnapshot);
  useEffect(() => {
    void persistence.start();
    return () => persistence.dispose();
  }, [persistence]);
  useEffect(() => {
    persistence.synchronize(
      categories.map((category) => ({
        id: category.id,
        name: category.name,
        rule: category.rule,
        count: category.entries.length,
        hashes: category.entries.map((entry) => entry.hash),
        active: true,
      })),
      baseline,
    );
  }, [persistence, categories, baseline, state.ready, state.conflict, state.document]);
  return { ...state, persistence };
}

import type { CompendiumData } from '@clarity/core';
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { bundleUrl } from '../../services/bundle';
import { compendiumDataUrl } from '../../services/compendium';
import { GuidancePersistence } from './guidancePersistence';
import type { ReviewCategory } from './reviewCategories';

export function useGuidance(categories: ReviewCategory[], baseline: string, source: CompendiumData, enabled: boolean) {
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
    if (!enabled || !persistence.renew(categories, source, baseline)) return;
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
  }, [
    persistence,
    categories,
    baseline,
    source,
    enabled,
    state.ready,
    state.saving,
    state.conflict,
    state.reloading,
    state.document,
  ]);
  return { ...state, persistence };
}

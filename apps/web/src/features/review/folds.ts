import {
  composeTooltipTranslation,
  languages,
  publishableHash,
  translationFallbackIds,
  type Tooltip,
} from '@clarity/core';
import type { PendingTooltip } from './model';
import { publishedFor, type usePublished } from './published';

interface Settled {
  decided: Set<PendingTooltip>;
  folded: Set<PendingTooltip>;
  list: PendingTooltip[];
}
const settled = new WeakMap<PendingTooltip[], Settled>();

/** The list, with the rows folded that turned out to wait for translations only. */
export const settledFolds = (entries: PendingTooltip[]) => settled.get(entries)?.list ?? entries;

/** Is the saved tooltip the published one, apart from its translations and the alias marker? */
async function onlyTranslations(saved: Tooltip, live: Tooltip, pushed: string): Promise<boolean> {
  try {
    let neutral = saved;
    for (const lang of languages)
      if (lang !== 'en') {
        const fallback = translationFallbackIds(live.text.en, lang).filter(
          (id) => typeof saved.text.en?.numbers?.retired[id] === 'object',
        );
        ({ tooltip: neutral } = await composeTooltipTranslation(
          neutral,
          lang,
          live.text[lang],
          fallback,
          {},
        ));
      }
    return (await publishableHash(neutral, {})) === pushed;
  } catch {
    return false;
  }
}

/**
 * A translation on a migration leftover: the bundle does not name it in `only`, since its alias
 * marker differs too. Each such row stays listed until the published text the page loads anyway
 * shows that nothing else waits. True once the list changed.
 */
export async function settleFolds(
  entries: PendingTooltip[],
  byHash: ReturnType<typeof usePublished.getState>['byHash'],
): Promise<boolean> {
  const known = settled.get(entries);
  const open = entries.flatMap((entry) => {
    if (!entry.mayFold || known?.decided.has(entry)) return [];
    const version = publishedFor(byHash, entry.tooltip.hash, entry.pushed);
    return version?.status === 'ready' && version.tooltip ? [{ entry, live: version.tooltip }] : [];
  });
  if (!open.length) return false;
  const proved = await Promise.all(
    open.map(({ entry, live }) => onlyTranslations(entry.tooltip, live, entry.pushed!)),
  );
  const state = settled.get(entries) ?? {
    decided: new Set<PendingTooltip>(),
    folded: new Set<PendingTooltip>(),
    list: entries,
  };
  const before = state.folded.size;
  open.forEach(({ entry }, index) => {
    state.decided.add(entry);
    if (proved[index]) state.folded.add(entry);
  });
  if (state.folded.size !== before)
    state.list = entries.map((entry) =>
      state.folded.has(entry) ? { ...entry, translationOnly: true as const } : entry,
    );
  settled.set(entries, state);
  return state.folded.size !== before;
}

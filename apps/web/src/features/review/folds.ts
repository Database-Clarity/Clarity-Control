import {
  composeTooltipTranslation,
  languages,
  publishableHash,
  translationFallbackIds,
  type Tooltip,
} from '@clarity/core';
import type { PendingTooltip } from './model';
import { publishedFor, type usePublished } from './published';

const settled = new WeakMap<PendingTooltip[], PendingTooltip[]>();

/** The list, with the unverified folded rows that turned out to wait for more than translations. */
export const settledFolds = (entries: PendingTooltip[]) => settled.get(entries) ?? entries;

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
 * marker differs too. It is folded at once, and checked against the published text the page loads
 * anyway; a row that waits for anything else returns to the list. True once the list changed.
 */
export async function settleFolds(
  entries: PendingTooltip[],
  byHash: ReturnType<typeof usePublished.getState>['byHash'],
): Promise<boolean> {
  if (settled.has(entries)) return false;
  const open = entries.filter(({ translationOnly }) => translationOnly === 'unverified');
  if (!open.length) return false;
  const versions = open.map(({ tooltip, pushed }) => publishedFor(byHash, tooltip.hash, pushed));
  if (versions.some((version) => !version || version.status === 'loading')) return false;
  const verified = await Promise.all(
    open.map(({ tooltip, pushed }, index) => {
      const version = versions[index]!;
      return version.status === 'ready' && version.tooltip
        ? onlyTranslations(tooltip, version.tooltip, pushed!)
        : false;
    }),
  );
  if (settled.has(entries)) return false;
  const mixed = new Set(open.filter((_, index) => !verified[index]));
  settled.set(
    entries,
    mixed.size
      ? entries.map((entry) =>
          mixed.has(entry) ? { ...entry, translationOnly: undefined } : entry,
        )
      : entries,
  );
  return mixed.size > 0;
}

import {
  resolveCompendiumLink,
  translationStateOf,
  type CompendiumData,
  type Lang,
} from '@clarity/core';
import type { EditorData } from '../../stores/data';
import { classifyItem, inactiveCategory, isSetSelector } from '../compendium/itemClassification';
import { canonicalHash, variantHashes } from './catalog';

export const Missing = 1;
export const Outdated = 2;
export type MarkerIndex = ReadonlyMap<number, number>;

/** Saved-state rules only. Draft text must not hide a missing saved tooltip. */
export function savedFinderMarkers(
  hash: number,
  data: EditorData,
  source: CompendiumData | null,
  lang: Lang,
): number {
  const item = data.items[hash];
  const tooltip = data.bundle.tooltips[hash];
  const classification = item && classifyItem(item, tooltip, data.bundle.inactiveMoves);
  const needsText =
    !item ||
    (!classification?.excluded &&
      classification?.categoryId !== inactiveCategory &&
      item.categoryId !== inactiveCategory &&
      !isSetSelector(item) &&
      !(item.baseHash !== undefined && canonicalHash(hash, data) !== hash) &&
      !(item.categoryId === 'weapon-frame' && !item.inGameDescription.trim()));
  let flags = needsText && !tooltip?.text.en?.text.trim() ? Missing : 0;
  if (lang !== 'en') {
    if (tooltip?.text.en?.text.trim() && translationStateOf(tooltip, lang).state === 'outdated')
      flags |= Outdated;
  } else if (source && tooltip?.compendium) {
    const resolved = resolveCompendiumLink(tooltip.compendium, source);
    if (resolved.status !== 'ok' && !(resolved.status === 'moved' && !resolved.changed)) flags |= Outdated;
  }
  return flags;
}

/** Shared by the header and phone sheet; never recomputed on typing or stepping. */
const cache = new WeakMap<
  EditorData,
  Map<CompendiumData | null, Map<Lang, Promise<MarkerIndex>>>
>();
export function prepareFinderMarkers(
  data: EditorData,
  source: CompendiumData | null,
  lang: Lang,
): Promise<MarkerIndex> {
  let sources = cache.get(data);
  if (!sources) cache.set(data, (sources = new Map()));
  let languages = sources.get(source);
  if (!languages) sources.set(source, (languages = new Map()));
  const previous = languages.get(lang);
  if (previous) return previous;
  const job = new Promise<MarkerIndex>((resolve) => {
    const hashes = new Set(
      [...Object.keys(data.items), ...Object.keys(data.bundle.tooltips)].map(Number),
    );
    const iterator = hashes.values();
    const own = new Map<number, number>();
    const index = new Map<number, number>();
    const idle = (run: () => void) => {
      if (typeof requestIdleCallback === 'function') requestIdleCallback(run);
      else setTimeout(run, 0);
    };
    const fill = () => {
      for (let n = 0; n < 32; n++) {
        const next = iterator.next();
        if (next.done) {
          idle(rollup);
          return;
        }
        own.set(next.value, savedFinderMarkers(next.value, data, source, lang));
      }
      idle(fill);
    };
    const remaining = hashes.values();
    const rollup = () => {
      for (let n = 0; n < 64; n++) {
        const next = remaining.next();
        if (next.done) {
          resolve(index);
          return;
        }
        index.set(
          next.value,
          variantHashes(next.value, data).reduce((flags, hash) => flags | (own.get(hash) ?? 0), 0),
        );
      }
      idle(rollup);
    };
    idle(fill);
  });
  languages.set(lang, job);
  return job;
}

export function rollupFinderMarkers(hashes: readonly number[], index: MarkerIndex): number {
  return hashes.reduce((flags, hash) => flags | (index.get(hash) ?? 0), 0);
}

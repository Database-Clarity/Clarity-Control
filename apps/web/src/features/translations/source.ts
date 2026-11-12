import { findElementTags, type Lang, type Tooltip } from '@clarity/core';

export interface SourceHistory {
  getHistory(
    hash: number,
    page: number,
    signal?: AbortSignal,
  ): Promise<{
    commits: { commit: string }[];
  }>;
  getVersion(hash: number, commit: string, signal?: AbortSignal): Promise<{ tooltip: Tooltip }>;
}

export type TranslationSource =
  { kind: 'found'; text: string } | { kind: 'missing'; reason: string };

export async function findTranslationSource(
  hash: number,
  sourceUpdatedAt: string,
  history: SourceHistory,
  signal?: AbortSignal,
): Promise<TranslationSource> {
  const seen = new Set<string>();
  // A markup-only edit (element tags) keeps English's updatedAt, so several versions can share the
  // source time: the oldest of them (history runs newest first) is the text that was translated.
  let found: string | undefined;
  let ended = false;
  for (let page = 1; page <= 20; page++) {
    const { commits } = await history.getHistory(hash, page, signal);
    if (!commits.length) {
      ended = true;
      break;
    }
    for (const { commit } of commits) {
      if (seen.has(commit)) continue;
      seen.add(commit);
      const { tooltip } = await history.getVersion(hash, commit, signal);
      const english = tooltip.text.en;
      if (english && Date.parse(english.updatedAt) === Date.parse(sourceUpdatedAt))
        found = english.text;
      else if (found !== undefined) return { kind: 'found', text: found };
    }
  }
  if (found !== undefined) return { kind: 'found', text: found };
  return {
    kind: 'missing',
    reason: ended
      ? 'The English source revision was not found in tooltip history.'
      : 'The English source revision was not found within the first 600 history entries.',
  };
}

/**
 * What the translation pane's English diff compares, or nothing: an outdated translation, and a
 * current one whose English holds element tags (tagging keeps the translation current, so only
 * the diff shows that the English markup changed since it was translated).
 */
export function englishDiffFor(
  tooltip: Tooltip,
  lang: Lang,
  state: 'current' | 'outdated' | 'missing' | undefined,
): { hash: number; sourceUpdatedAt: string; current: string } | undefined {
  const english = tooltip.text.en?.text ?? '';
  const sourceUpdatedAt = tooltip.text[lang]?.sourceUpdatedAt;
  if (!sourceUpdatedAt || state === 'missing' || state === undefined) return undefined;
  if (state === 'current' && !findElementTags(english).length) return undefined;
  return { hash: tooltip.hash, sourceUpdatedAt, current: english };
}

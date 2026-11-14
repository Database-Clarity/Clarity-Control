import { memo } from 'react';
import { markupLanguage, parseMarkup, type Lang, type MarkupGlobals } from '@clarity/core';
import { useDataStore, type EditorData } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import type { Drafts } from '../../services/draftStorage';
import { tooltipImports } from '../../services/tooltipImports';
import { previewDrafts, previewText } from '../conflicts/previewDrafts';
import { archivedItemFor } from '../archive/archive';
import { Lines } from './TooltipPreview';
import styles from './TooltipPreview.module.scss';

const emptyGlobals: MarkupGlobals = { variables: '', titles: '' };
const catalogs = new WeakMap<EditorData, WeakMap<Drafts, Map<Lang, MarkupGlobals>>>();
const renders = new WeakMap<MarkupGlobals, Map<string, ReturnType<typeof parseMarkup>>>();
const revisions = new WeakMap<
  EditorData,
  Map<
    Lang,
    {
      checked: Drafts;
      source: Drafts;
      values: Map<string, string>;
    }
  >
>();

/** A translation edit must not schedule or reparse the unchanged English pane. */
export function languageRevision(data: EditorData | null, drafts: Drafts, lang: Lang): Drafts {
  if (!data) return drafts;
  let languages = revisions.get(data);
  if (!languages) revisions.set(data, (languages = new Map()));
  const previous = languages.get(lang);
  if (previous?.checked === drafts) return previous.source;
  const values = new Map<string, string>();
  for (const [hash, draft] of Object.entries(drafts)) {
    const text = draft.next.text[lang]?.text ?? '';
    if (text !== (data.bundle.tooltips[hash]?.text[lang]?.text ?? '')) values.set(hash, text);
  }
  if (
    previous &&
    previous.values.size === values.size &&
    [...values].every(([hash, text]) => previous.values.get(hash) === text)
  ) {
    previous.checked = drafts;
    return previous.source;
  }
  languages.set(lang, { checked: drafts, source: drafts, values });
  return drafts;
}

export function globalsFor(data: EditorData | null, drafts: Drafts, lang: Lang) {
  if (!data) return emptyGlobals;
  let snapshots = catalogs.get(data);
  if (!snapshots) catalogs.set(data, (snapshots = new WeakMap()));
  let languages = snapshots.get(drafts);
  if (!languages) snapshots.set(drafts, (languages = new Map()));
  let globals = languages.get(lang);
  if (!globals) {
    const imports = tooltipImports(data.bundle.tooltips, previewDrafts(drafts), lang, data.aliases);
    globals = { variables: imports[2] ?? '', titles: imports[3] ?? '', imports };
    languages.set(lang, globals);
  }
  return globals;
}

/** One reading render: the text read as `hash`'s type (an enhanced hash reads its enhanced block). */
export function readingParse(
  data: EditorData | null,
  globals: MarkupGlobals,
  text: string,
  hash: number | undefined,
) {
  const category =
    hash === undefined || !data ? undefined : archivedItemFor(hash, data)?.categoryId;
  const type = data?.categories.find((entry) => entry.id === category)?.legacyType;
  let cache = renders.get(globals);
  if (!cache) renders.set(globals, (cache = new Map()));
  const key = JSON.stringify([type, text]);
  let parsed = cache.get(key);
  if (!parsed) {
    parsed = parseMarkup(previewText(text), { ...globals, type });
    // Bound each revision's cache; old data and draft snapshots are weakly held.
    if (cache.size >= 128) cache.delete(cache.keys().next().value!);
    cache.set(key, parsed);
  }
  return parsed;
}

export const hasNativePopovers = () =>
  typeof HTMLElement !== 'undefined' &&
  typeof (HTMLElement.prototype as { showPopover?: unknown }).showPopover === 'function';

/** Reading surfaces share preview spans, styles, and top-layer title popovers. */
export const ReadingTooltip = memo(function ReadingTooltip({
  text,
  lang = 'en',
  hash,
}: {
  text: string;
  lang?: Lang;
  hash?: number;
}) {
  const data = useDataStore((state) => state.data);
  const drafts = useDraftStore((state) => languageRevision(data, state.drafts, lang));
  const globals = globalsFor(data, drafts, lang);
  const parsed = readingParse(data, globals, text, hash);
  const nativePopovers = hasNativePopovers();
  return (
    <div
      className={[styles.snippet, styles.reading, nativePopovers ? styles.containedReading : '']
        .filter(Boolean)
        .join(' ')}
      lang={markupLanguage(lang)}
    >
      <Lines lines={parsed.lines} />
    </div>
  );
});

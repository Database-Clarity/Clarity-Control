import { memo, useMemo } from 'react';
import { markupLanguage, type Lang } from '@clarity/core';
import { useDataStore } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import { compareRenders } from './compare';
import { CompareLines } from './PreviewColumn';
import { globalsFor, hasNativePopovers, languageRevision, readingParse } from './ReadingTooltip';
import styles from './TooltipPreview.module.scss';

/**
 * The base and an enhanced version read as one text (the preview's Compare rows), for the
 * translate-mode English: each changed value shows its base and enhanced values side by side,
 * coloured like the editor's base and enhanced arms (styles.armsCompare).
 */
export const ReadingCompare = memo(function ReadingCompare({
  baseText,
  baseHash,
  enhancedText,
  enhancedHash,
  lang = 'en',
}: {
  baseText: string;
  baseHash: number;
  enhancedText: string;
  enhancedHash: number;
  lang?: Lang;
}) {
  const data = useDataStore((state) => state.data);
  const drafts = useDraftStore((state) => languageRevision(data, state.drafts, lang));
  const globals = globalsFor(data, drafts, lang);
  const before = readingParse(data, globals, baseText, baseHash);
  const after = readingParse(data, globals, enhancedText, enhancedHash);
  const comparison = useMemo(() => compareRenders(before.lines, after.lines), [before, after]);
  return (
    <div
      className={[
        styles.snippet,
        styles.reading,
        styles.armsCompare,
        hasNativePopovers() ? styles.containedReading : '',
      ]
        .filter(Boolean)
        .join(' ')}
      lang={markupLanguage(lang)}
      data-english-compare=""
    >
      <CompareLines comparison={comparison} />
    </div>
  );
});

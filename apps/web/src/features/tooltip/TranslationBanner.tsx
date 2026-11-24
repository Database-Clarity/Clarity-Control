import { useMemo } from 'react';
import type { Lang, Tooltip } from '@clarity/core';
import type { EditorData } from '../../stores/data';
import { needsUpdate } from '../translations/pendingState';
import { useChangeSize } from '../translations/useChangeSizes';
import styles from './TranslationBanner.module.scss';

type Update = NonNullable<ReturnType<typeof needsUpdate>>;

/** Live output falls back strictly after 90 days, so 90 and a bit must not read "90 days". */
const daysBehind = (ageMs: number) => Math.ceil(ageMs / 86_400_000);

/** The banner's words: in full, and short for a narrow pane. */
function bannerText(update: Update, words: number | undefined): { full: string; short: string } {
  const ageMs = update.ageMs ?? 0;
  if (update.exportedInEnglish) {
    if (update.reason === 'numbers')
      return {
        full: 'Published in English until this is updated: it uses a number English removed',
        short: 'Published in English: removed number',
      };
    const days = `${daysBehind(ageMs)} days behind`;
    return {
      full: `Published in English until this is updated: the translation is ${days}`,
      short: `Published in English: ${days}`,
    };
  }
  if (update.reason === 'numbers' && !ageMs)
    return {
      full: 'English removed a number this translation uses',
      short: 'Uses a number English removed',
    };
  const size = words ? ` (${words} ${words === 1 ? 'word' : 'words'})` : '';
  return {
    full: `English changed since this translation${size}`,
    short: `English changed${size}`,
  };
}

export function TranslationBannerView({ update, words }: { update: Update; words?: number }) {
  const { full, short } = bannerText(update, words);
  return (
    <p className={styles.banner} data-level={update.exportedInEnglish ? 'published' : 'behind'}>
      <span className={styles.full}>{full}</span>
      <span className={styles.short}>{short}</span>
    </p>
  );
}

/**
 * Says when the open translation needs updating, from the draft as it would be saved: it goes as
 * soon as the typed text would be current, and comes back on Discard or undo.
 */
export function TranslationBanner({
  saved,
  base,
  next,
  lang,
  data,
  suspended,
}: {
  saved: Tooltip;
  /** The draft's two sides, when there is one. */
  base: Tooltip | undefined;
  next: Tooltip | undefined;
  lang: Lang;
  data: EditorData;
  /** Stepping: the word count is not asked for. */
  suspended: boolean;
}) {
  const update = useMemo(
    () => needsUpdate(saved, base && next && { base, next }, lang, data),
    [saved, base, next, lang, data],
  );
  const words = useChangeSize(
    update?.sourceUpdatedAt && update.ageMs && !update.exportedInEnglish && !suspended
      ? {
          hash: saved.hash,
          sourceUpdatedAt: update.sourceUpdatedAt,
          current: saved.text.en?.text ?? '',
        }
      : undefined,
  );
  return update && <TranslationBannerView update={update} words={words} />;
}

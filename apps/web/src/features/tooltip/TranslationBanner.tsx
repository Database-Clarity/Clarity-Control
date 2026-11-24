import { useMemo } from 'react';
import type { Lang, Tooltip } from '@clarity/core';
import type { EditorData } from '../../stores/data';
import { needsUpdate, type Update } from '../translations/pendingState';
import { useChangeSize } from '../translations/useChangeSizes';
import type { TranslationRevisions } from '../../../../../packages/core/src/translationRevision';
import styles from './TranslationBanner.module.scss';
import pageStyles from './TooltipPage.module.scss';

type Shown = Omit<Update, 'english'>;

/** Live output falls back strictly after 90 days, so 90 and a bit must not read "90 days". */
const daysBehind = (ageMs: number) => Math.ceil(ageMs / 86_400_000);

/** The banner's words: in full, and short for a narrow pane. */
function bannerText(update: Shown, words: number | undefined): { full: string; short: string } {
  const ageMs = update.ageMs ?? 0;
  if (update.reason === 'numbers')
    return update.exportedInEnglish
      ? {
          full: 'Published in English until this is updated: it uses a number English removed',
          short: 'Published in English: removed number',
        }
      : {
          full: 'English removed a number this translation uses',
          short: 'Uses a number English removed',
        };
  if (update.exportedInEnglish) {
    const days = `${daysBehind(ageMs)} days behind`;
    return {
      full: `Published in English until this is updated: the translation is ${days}`,
      short: `Published in English: ${days}`,
    };
  }
  const size = words ? ` (${words} ${words === 1 ? 'word' : 'words'})` : '';
  return {
    full: `English changed since this translation${size}`,
    short: `English changed${size}`,
  };
}

export function TranslationBannerView({
  update,
  words,
  onConfirm,
  onUndo,
}: {
  update?: Shown;
  words?: number;
  onConfirm?: () => void;
  onUndo?: () => void;
}) {
  if (!update && !onUndo) return null;
  const { full, short } = update
    ? bannerText(update, words)
    : { full: 'Marked as still correct', short: 'Marked as still correct' };
  return (
    <div
      className={styles.banner}
      data-level={update ? (update.exportedInEnglish ? 'published' : 'behind') : undefined}
      data-action={Boolean(onConfirm || onUndo) || undefined}
    >
      <p role="status" className={styles.message} title={full}>
        <span className={styles.full}>{full}</span>
        <span className={styles.short}>{short}</span>
        <span className={styles.narrow}>
          {update ? (update.exportedInEnglish ? 'Published in English' : 'English changed') : short}
        </span>
      </p>
      {(onConfirm || onUndo) && (
        <button
          type="button"
          className={pageStyles.ghost}
          aria-label={onUndo ? 'Undo marking as still correct' : undefined}
          onClick={onUndo ?? onConfirm}
        >
          {onUndo ? 'Undo' : 'Still correct'}
        </button>
      )}
    </div>
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
  translationRevisions,
  onConfirm,
  onUndo,
}: {
  saved: Tooltip;
  /** The draft's two sides, when there is one. */
  base: Tooltip | undefined;
  next: Tooltip | undefined;
  lang: Lang;
  data: EditorData;
  /** Stepping: the word count is not asked for. */
  suspended: boolean;
  translationRevisions?: TranslationRevisions;
  onConfirm?: () => void;
  onUndo?: () => void;
}) {
  const update = useMemo(
    () => needsUpdate(saved, base && next && { base, next, translationRevisions }, lang, data),
    [saved, base, next, lang, data, translationRevisions],
  );
  const words = useChangeSize(
    update?.sourceUpdatedAt &&
      update.ageMs &&
      !update.exportedInEnglish &&
      !suspended &&
      // Words are counted between saved texts, never against English still being typed.
      update.english === saved.text.en?.text
      ? { hash: saved.hash, sourceUpdatedAt: update.sourceUpdatedAt, current: update.english }
      : undefined,
  );
  return (
    <TranslationBannerView
      update={update ?? undefined}
      words={words}
      onConfirm={update && update.reason !== 'numbers' ? onConfirm : undefined}
      onUndo={onUndo}
    />
  );
}

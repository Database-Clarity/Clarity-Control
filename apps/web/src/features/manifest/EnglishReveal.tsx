import { markupLanguage, type Lang } from '@clarity/core';
import { Popover } from '../../ui/Popover';
import styles from './EnglishReveal.module.scss';

/**
 * A localised text's English original, in the shared anchored popup (hover, keyboard, click, and
 * tap). English text, or a translation equal to it, is plain text: a reveal that repeats what is
 * already on screen is noise.
 */
export function EnglishReveal({
  english,
  translated,
  lang,
  showTranslation = false,
}: {
  english: string;
  translated: string | undefined;
  lang: Lang;
  /** Names may be ellipsised: the reveal also shows the full translated spelling. */
  showTranslation?: boolean;
}) {
  const localised = lang !== 'en' && !!translated?.trim() && translated !== english;
  if (!localised) return <>{english}</>;
  return (
    <Popover
      key={`${lang}:${english}`}
      label="English original"
      trigger={<span lang={markupLanguage(lang)}>{translated}</span>}
      triggerLabel={`${translated} — show English original`}
      openOnHover
      className={styles.trigger}
      width={400}
    >
      {showTranslation && (
        <div className={`${styles.original} ${styles.translation}`} lang={markupLanguage(lang)}>
          {translated}
        </div>
      )}
      <div className={styles.original} lang="en">
        {english}
      </div>
    </Popover>
  );
}

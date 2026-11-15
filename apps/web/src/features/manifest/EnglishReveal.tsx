import { markupLanguage, type Lang } from '@clarity/core';
import { Popover } from '../../ui/Popover';
import styles from './EnglishReveal.module.scss';

/** The shared anchored popup for hover, keyboard, click, and tap. */
export function EnglishReveal({
  english,
  translated,
  lang,
  showTranslation = false,
}: {
  english: string;
  translated: string | undefined;
  lang: Lang;
  /** Names may be ellipsised: keep the full official spelling readable in the reveal. */
  showTranslation?: boolean;
}) {
  const localised = lang !== 'en' && !!translated?.trim() && translated !== english;
  if (!localised && !showTranslation) return <>{english}</>;
  const displayed = localised ? translated : english;
  return (
    <Popover
      key={`${lang}:${english}`}
      label={localised ? 'English original' : 'Full name'}
      trigger={<span lang={localised ? markupLanguage(lang) : 'en'}>{displayed}</span>}
      triggerLabel={localised ? `${displayed} — show English original` : english}
      openOnHover
      className={styles.trigger}
      width={400}
    >
      {showTranslation && localised && (
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

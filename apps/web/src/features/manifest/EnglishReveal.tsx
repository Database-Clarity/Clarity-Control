import { markupLanguage, type Lang } from '@clarity/core';
import { Popover } from '../../ui/Popover';
import styles from './EnglishReveal.module.scss';

/** Native hover text and the shared anchored popup for keyboard, click, and tap. */
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
  if (!translated?.trim() || translated === english || lang === 'en') return <>{english}</>;
  return (
    <Popover
      key={`${lang}:${english}`}
      label="English original"
      trigger={<span lang={markupLanguage(lang)}>{translated}</span>}
      triggerTitle={showTranslation ? `${translated}\n${english}` : english}
      triggerLabel={`${translated} — show English original`}
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

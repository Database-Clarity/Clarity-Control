import { languageLabel } from '../../languageLabels';
import { languages, type Tooltip } from '@clarity/core';
import { WordDiff } from '../../ui/diff';
import styles from './History.module.scss';

export function TooltipDiff({ before, current }: { before: Tooltip | null; current: Tooltip }) {
  const changed = languages.filter((lang) => before?.text[lang]?.text !== current.text[lang]?.text);
  return (
    <div className={styles.diff}>
      {changed.map((lang) => (
        <section key={lang} aria-label={`${languageLabel(lang)} comparison`}>
          <h4>{languageLabel(lang)}</h4>
          <div className={styles.columns}>
            <div>
              <strong>Previous / live</strong>
              <pre>{before?.text[lang]?.text ?? '(not present)'}</pre>
            </div>
            <div>
              <strong>Current</strong>
              <pre>{current.text[lang]?.text ?? '(not present)'}</pre>
            </div>
          </div>
          <WordDiff
            before={before?.text[lang]?.text ?? ''}
            after={current.text[lang]?.text ?? ''}
          />
        </section>
      ))}
      {!changed.length && <p>No language text changes.</p>}
      {JSON.stringify(before?.associated ?? []) !== JSON.stringify(current.associated) && (
        <p>
          Associated tooltips: {before?.associated.join(', ') || '(none)'} →{' '}
          {current.associated.join(', ') || '(none)'}
        </p>
      )}
      {JSON.stringify(before?.custom) !== JSON.stringify(current.custom) && (
        <p>
          Custom identity: {JSON.stringify(before?.custom) ?? '(none)'} →{' '}
          {JSON.stringify(current.custom) ?? '(none)'}
        </p>
      )}
    </div>
  );
}

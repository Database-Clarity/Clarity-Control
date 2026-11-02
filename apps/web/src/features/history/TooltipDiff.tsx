import { languageLabel } from '../../languageLabels';
import { languages, type Tooltip } from '@clarity/core';
import { WordDiff } from '../../ui/diff';
import {
  attachmentCategory,
  categoryLabel,
  effectCategory,
} from '../compendium/itemClassification';
import styles from './History.module.scss';

const switchable = [attachmentCategory, effectCategory];
/** Friendly line when the only custom change is an attachment/effect category switch. */
export function categorySwitchLine(before: Tooltip | null, current: Tooltip): string | undefined {
  const from = before?.custom?.categoryId ?? attachmentCategory,
    to = current.custom?.categoryId ?? attachmentCategory;
  if (from === to || !switchable.includes(from) || !switchable.includes(to)) return;
  // A differing custom name is a different identity change: keep the raw line.
  const a = before?.custom?.name,
    b = current.custom?.name;
  if (a && b && a !== b) return;
  return `Category: ${categoryLabel(from)} → ${categoryLabel(to)}`;
}

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
      {categorySwitchLine(before, current) && <p>{categorySwitchLine(before, current)}</p>}
      {!categorySwitchLine(before, current) &&
        JSON.stringify(before?.custom) !== JSON.stringify(current.custom) && (
          <p>
            Custom identity: {JSON.stringify(before?.custom) ?? '(none)'} →{' '}
            {JSON.stringify(current.custom) ?? '(none)'}
          </p>
        )}
    </div>
  );
}

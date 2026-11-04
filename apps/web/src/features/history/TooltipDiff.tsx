import type { Item } from '../../services/generator';
import { languageLabel } from '../../languageLabels';
import { languages, sameCell, type Tooltip } from '@clarity/core';
import { CompendiumDiff } from '../compendium/CompendiumDiff';
import { HistoryWordDiff } from './HistoryWordDiff';
import {
  attachmentCategory,
  categoryLabel,
  classifyItem,
  effectCategory,
} from '../compendium/itemClassification';
import { archiveChangeLine } from '../archive/archiveFormat';
import { useSyncedSettings } from '../../stores/settings';
import styles from './History.module.scss';

const emptyCell = { plain: '', runs: [] };
const switchable = [attachmentCategory, effectCategory];
const customText = (tooltip: Tooltip | null) => JSON.stringify(tooltip?.custom) ?? '(none)';
/**
 * Identity lines for the custom field. The friendly "Category: X → Y" line is only produced when
 * the item is known (so a missing custom has a provable native category and name) and any other
 * identity change (name) is still reported alongside it, never hidden behind it.
 */
export function identityLines(
  before: Tooltip | null,
  current: Tooltip,
  item?: Pick<Item, 'name'> & Parameters<typeof classifyItem>[0],
): string[] {
  if (JSON.stringify(before?.custom) === JSON.stringify(current.custom)) return [];
  const raw = `Custom identity: ${customText(before)} → ${customText(current)}`;
  if (!item) return [raw];
  const native = classifyItem(item)?.categoryId;
  const from = before?.custom?.categoryId ?? native,
    to = current.custom?.categoryId ?? native;
  if (!from || !to || from === to || !switchable.includes(from) || !switchable.includes(to))
    return [raw];
  const lines = [`Category: ${categoryLabel(from)} → ${categoryLabel(to)}`];
  const a = before?.custom?.name ?? item.name,
    b = current.custom?.name ?? item.name;
  if (a !== b) lines.push(`Custom identity name: ${a} → ${b}`);
  return lines;
}

export function TooltipDiff({
  before,
  current,
  item,
  raw = true,
}: {
  before: Tooltip | null;
  current: Tooltip;
  item?: Item;
  /** Show both full texts above the word diff; popovers show the word diff alone. */
  raw?: boolean;
}) {
  const changed = languages.filter((lang) => before?.text[lang]?.text !== current.text[lang]?.text);
  const dateSettings = useSyncedSettings();
  return (
    <div className={styles.diff}>
      {changed.map((lang) => (
        <section key={lang} lang={lang} aria-label={`${languageLabel(lang)} comparison`}>
          <h4>{languageLabel(lang)}</h4>
          {raw && (
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
          )}
          <HistoryWordDiff
            before={before?.text[lang]?.text ?? ''}
            after={current.text[lang]?.text ?? ''}
          />
        </section>
      ))}
      {(before?.compendium || current.compendium) &&
        !sameCell(
          before?.compendium?.snapshot ?? emptyCell,
          current.compendium?.snapshot ?? emptyCell,
        ) && (
          <CompendiumDiff
            before={before?.compendium?.snapshot ?? emptyCell}
            after={current.compendium?.snapshot ?? emptyCell}
          />
        )}
      {!changed.length && <p>No language text changes.</p>}
      {JSON.stringify(before?.associated ?? []) !== JSON.stringify(current.associated) && (
        <p>
          Associated tooltips: {before?.associated.join(', ') || '(none)'} →{' '}
          {current.associated.join(', ') || '(none)'}
        </p>
      )}
      {archiveChangeLine(before?.archive, current.archive, dateSettings) && (
        <p>{archiveChangeLine(before?.archive, current.archive, dateSettings)}</p>
      )}
      {identityLines(before, current, item).map((line) => (
        <p key={line}>{line}</p>
      ))}
    </div>
  );
}

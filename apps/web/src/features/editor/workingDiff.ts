import { sameCell, type Lang, type Tooltip } from '@clarity/core';
import type { Item } from '../../services/generator';

/** What the editor's Changes view compares: the saved version against the work in progress. */
export interface WorkingDiffSource {
  /** The draft's base: the version the next save is compared against. */
  saved: Tooltip;
  /** The draft, or the saved tooltip itself while nothing is unsaved. */
  current: Tooltip;
  /** Names a category change; without it the raw identity is shown. */
  item?: Item;
}

type Fields = Pick<Tooltip, 'associated' | 'custom' | 'archive' | 'compendium'>;

const emptyCell = { plain: '', runs: [] };
const same = (a: unknown, b: unknown) =>
  a === b || JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * The tooltip with only the language in view. The Changes view compares these, so a language
 * the editor is not showing is never compared, shown, or counted as a change.
 */
export function inView(tooltip: Tooltip, lang: Lang): Tooltip {
  const text = tooltip.text[lang];
  return { ...tooltip, text: text ? { [lang]: text } : {} };
}

/** Whether the text of the language in view differs (the same test the History diff uses). */
export function textChanged(saved: Tooltip, current: Tooltip, lang: Lang): boolean {
  return saved.text[lang]?.text !== current.text[lang]?.text;
}

/**
 * Whether a field the History diff reports besides text differs: associations, category, archive
 * state, or the linked Compendium cell. Typing keeps these objects identical, so this is four
 * identity checks while only the text changes.
 */
export function fieldsChanged(saved: Fields, current: Fields): boolean {
  return (
    !same(saved.associated, current.associated) ||
    !same(saved.custom, current.custom) ||
    !same(saved.archive, current.archive) ||
    (saved.compendium !== current.compendium &&
      !sameCell(saved.compendium?.snapshot ?? emptyCell, current.compendium?.snapshot ?? emptyCell))
  );
}

export function hasWorkingChanges(saved: Tooltip, current: Tooltip, lang: Lang): boolean {
  return saved !== current && (textChanged(saved, current, lang) || fieldsChanged(saved, current));
}

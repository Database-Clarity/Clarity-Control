import { languages, type Tooltip } from '@clarity/core';
import { languageLabel } from '../../languageLabels';

export interface ChangedFields {
  /** Language codes whose saved text differs from the live text. */
  text: string[];
  associations: boolean;
  /** Custom identity (name or category override). */
  custom: boolean;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * What differs between the live (last pushed) tooltip and the saved one, by field. A tooltip with
 * no live version is all new: every saved language counts as changed.
 */
export function changedFields(before: Tooltip | null, current: Tooltip): ChangedFields {
  return {
    text: languages.filter((lang) => before?.text[lang]?.text !== current.text[lang]?.text),
    associations: !same(before?.associated ?? [], current.associated),
    custom: !same(before?.custom, current.custom),
  };
}

/** `English text · Associations`, the line the detail leads with; empty when nothing differs. */
export function changedSummary(fields: ChangedFields, markerOnly = false): string {
  const parts: string[] = [];
  if (fields.text.length)
    parts.push(
      fields.text.length === 1 && fields.text[0] === 'en'
        ? 'English text'
        : `${fields.text.map((lang) => languageLabel(lang)).join(', ')} text`,
    );
  if (fields.associations) parts.push('Associations');
  if (fields.custom) parts.push('Custom identity');
  if (markerOnly) parts.push('Aliases');
  return parts.join(' · ');
}

export type ChangeMark = 'Text' | 'Assoc' | 'Alias' | 'New';
/** The row marks: what kind of change this is, when the live version is known. */
export function changeMarks(
  fields: ChangedFields | undefined,
  { isNew, markerOnly }: { isNew: boolean; markerOnly: boolean },
): ChangeMark[] {
  if (isNew) return fields?.text.length ? ['Text', 'New'] : ['New'];
  if (markerOnly) return ['Alias'];
  if (!fields) return [];
  const marks: ChangeMark[] = [];
  if (fields.text.length) marks.push('Text');
  if (fields.associations) marks.push('Assoc');
  return marks;
}

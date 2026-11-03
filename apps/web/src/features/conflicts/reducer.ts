import { langSchema, merge3, tooltipSchema, type Tooltip } from '@clarity/core';
import type { Change, SaveConflict } from '../../services/api';

export type Resolution = { choice: 'mine' | 'theirs' } | { choice: 'edit'; text: string };
export type Resolutions = Record<string, Resolution>;
export const resolutionKey = (hash: number, field: string) => `${hash}:${field}`;

export function conflictReducer(
  state: Resolutions,
  action: { hash: number; field: string; resolution: Resolution },
): Resolutions {
  return { ...state, [resolutionKey(action.hash, action.field)]: action.resolution };
}

export function fieldValue(tooltip: Tooltip | null, field: string): unknown {
  if (!tooltip || field === '$exists') return tooltip;
  if (field.startsWith('text.')) return tooltip.text[langSchema.parse(field.slice(5))];
  if (!(field in tooltipSchema.shape) || field === 'hash')
    throw new Error(`Unknown conflict field ${field}.`);
  return tooltip[field as keyof Tooltip];
}

export function setField(tooltip: Tooltip, field: string, value: unknown): Tooltip {
  if (field.startsWith('text.')) {
    const lang = langSchema.parse(field.slice(5));
    const text = { ...tooltip.text, [lang]: value };
    if (value === undefined) delete text[lang];
    return tooltipSchema.parse({ ...tooltip, text });
  }
  if (!(field in tooltipSchema.shape) || field === 'hash')
    throw new Error(`Unknown conflict field ${field}.`);
  const next = { ...tooltip, [field]: value };
  return tooltipSchema.parse(next);
}

export function displayField(tooltip: Tooltip | null, field: string): string {
  const value = fieldValue(tooltip, field);
  if (field.startsWith('text.')) {
    return tooltip?.text[langSchema.parse(field.slice(5))]?.text ?? '(not present)';
  }
  return value === undefined ? '(not present)' : JSON.stringify(value, null, 2);
}

export function resolveConflicts(
  changes: Change[],
  conflicts: SaveConflict[],
  resolutions: Resolutions,
): { changes: Change[]; deleted: number[] } {
  const byHash = new Map(conflicts.map((conflict) => [conflict.hash, conflict]));
  const deleted: number[] = [];
  const resolved = changes.flatMap((change): Change[] => {
    const conflict = byHash.get(change.hash);
    if (!conflict) return [change];
    let base = conflict.base;
    let next = conflict.next;
    for (const field of conflict.fields) {
      const resolution = resolutions[resolutionKey(conflict.hash, field)];
      if (!resolution) throw new Error(`Choose a resolution for ${conflict.hash} / ${field}.`);
      let value =
        resolution.choice === 'theirs' ? fieldValue(conflict.head, field) : fieldValue(next, field);
      if (resolution.choice === 'edit') {
        if (field.startsWith('text.')) {
          const entry =
            next.text[langSchema.parse(field.slice(5))] ??
            conflict.head?.text[langSchema.parse(field.slice(5))];
          value = { ...entry, text: resolution.text };
        } else value = JSON.parse(resolution.text);
      }
      if (field === '$exists') {
        if (value === null) {
          deleted.push(change.hash);
          return [];
        }
        next = tooltipSchema.parse(value);
        base = conflict.head;
      } else {
        if (!base || !conflict.head) throw new Error('Missing tooltip for a field conflict.');
        next = setField(next, field, value);
        base = setField(base, field, fieldValue(conflict.head, field));
      }
    }
    if (!base || !conflict.head) return [{ hash: change.hash, base: conflict.head, next }];
    const merged = merge3(base, conflict.head, next);
    if (!merged.ok) throw new Error(`Unresolved conflicts for ${change.hash}.`);
    return [{ hash: change.hash, base: conflict.head, next: merged.merged }];
  });
  return { changes: resolved, deleted };
}

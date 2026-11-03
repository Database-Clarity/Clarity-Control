import {
  langSchema,
  mergeTextWithMarkers,
  merge3,
  stableStringify,
  tooltipSchema,
  type Lang,
  type LangText,
  type Tooltip,
} from '@clarity/core';
import type { SaveConflict } from '../../services/api';
import type { Drafts } from '../../services/draftStorage';
import { resolveConflicts, resolutionKey, type Resolutions } from './reducer';

/** "2026-11-03 18:02" in the viewer's local time: the stamp on the closing marker. */
export function stampOf(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** What follows ">>>>>>> theirs": who wrote their version, and when. */
export function theirsLabel(entry: LangText | undefined): string {
  return entry ? `(${entry.updatedBy.replace(/[\r\n]+/g, ' ')}, ${stampOf(entry.updatedAt)})` : '';
}

export const isTextField = (field: string) => field.startsWith('text.');
export const fieldLanguage = (field: string): Lang => langSchema.parse(field.slice(5));

export interface Rebased {
  /** The server's version: the draft's new base. */
  base: Tooltip;
  /** My tooltip on top of it: theirs' other changes merged in, text conflicts as marker blocks. */
  next: Tooltip;
  /** Languages that now carry marker blocks, and how many blocks in all. */
  markerLanguages: Lang[];
  markers: number;
  /** Languages whose text both sides changed but that merged line by line without a conflict. */
  mergedLanguages: Lang[];
  /** Fields that are not text and still need a choice (mine is in the draft until then). */
  rows: string[];
}

/**
 * Rebases my tooltip on the server's: everything only they changed comes along, a text both
 * sides changed is merged line by line with a marker block where the same lines differ, and any
 * other conflicting field keeps my value until a row asks which one to keep. Not for `$exists`.
 */
export function rebaseConflict(
  conflict: SaveConflict,
  label: (theirs: LangText | undefined) => string = theirsLabel,
): Rebased | null {
  const { base, head, next, fields } = conflict;
  if (!base || !head || fields.includes('$exists')) return null;
  const mine: Resolutions = {};
  for (const field of fields) mine[resolutionKey(conflict.hash, field)] = { choice: 'mine' };
  const resolved = resolveConflicts([{ hash: conflict.hash, base, next }], [conflict], mine)
    .changes[0];
  if (!resolved) return null;
  const merged: Tooltip = structuredClone(resolved.next);
  const markerLanguages: Lang[] = [];
  const mergedLanguages: Lang[] = [];
  let markers = 0;
  for (const field of fields.filter(isTextField)) {
    const lang = fieldLanguage(field);
    const result = mergeTextWithMarkers(
      base.text[lang]?.text ?? '',
      next.text[lang]?.text ?? '',
      head.text[lang]?.text ?? '',
      label(head.text[lang]),
    );
    const entry = next.text[lang] ?? head.text[lang];
    if (!entry) continue;
    merged.text[lang] = { ...entry, text: result.text };
    if (result.conflicts > 0) {
      markerLanguages.push(lang);
      markers += result.conflicts;
    } else mergedLanguages.push(lang);
  }
  return {
    base: head,
    next: tooltipSchema.parse(merged),
    markerLanguages,
    markers,
    mergedLanguages,
    rows: fields.filter((field) => !isTextField(field)),
  };
}

/**
 * Reload after another tab changed the drafts: a three-way merge of the draft per tooltip.
 * `ancestor` is what this tab last read or wrote; `mine` what it holds now (resolved parts
 * included); `theirs` what the other tab stored. A tooltip only one side touched is taken as it
 * is; one both touched is merged field by field, text line by line with marker blocks, and any
 * other field both changed keeps mine. Nothing either side wrote is dropped silently.
 */
export function reconcileDrafts(ancestor: Drafts, mine: Drafts, theirs: Drafts): Drafts {
  const same = (a: unknown, b: unknown) =>
    a === undefined || b === undefined ? a === b : stableStringify(a) === stableStringify(b);
  const out: Drafts = {};
  for (const key of new Set([...Object.keys(mine), ...Object.keys(theirs)])) {
    const a = ancestor[key];
    const m = mine[key];
    const t = theirs[key];
    if (same(m, t)) {
      if (m) out[key] = m;
    } else if (same(a, t)) {
      if (m) out[key] = m;
    } else if (same(a, m)) {
      if (t) out[key] = t;
    } else if (!m && t) out[key] = t;
    else if (m && !t) out[key] = m;
    else if (m && t) out[key] = reconcileOne(a, m, t);
  }
  return out;
}

function reconcileOne(
  ancestor: Drafts[string] | undefined,
  mine: Drafts[string],
  theirs: Drafts[string],
): Drafts[string] {
  // Keep the newer base: the other tab's when it moved, otherwise mine.
  const base =
    ancestor && stableStringify(theirs.base) === stableStringify(ancestor.base)
      ? mine.base
      : theirs.base;
  const origin = ancestor?.next ?? theirs.base;
  const merge = merge3(origin, theirs.next, mine.next);
  if (merge.ok) return { base, next: merge.merged };
  const rebased = rebaseConflict(
    {
      hash: mine.next.hash,
      base: origin,
      head: theirs.next,
      next: mine.next,
      fields: merge.conflicts.map(({ field }) => field),
    },
    () => '(other tab)',
  );
  return { base, next: rebased?.next ?? mine.next };
}

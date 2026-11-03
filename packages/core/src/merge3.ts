import { stableStringify } from './contentHash.js';
import { languages } from './languages.js';
import { tooltipSchema, type Tooltip } from './schemas.js';

export interface MergeConflict {
  field: string;
  base: unknown;
  head: unknown;
  next: unknown;
}
export type MergeResult = { ok: true; merged: Tooltip } | { ok: false; conflicts: MergeConflict[] };

const equal = (a: unknown, b: unknown) =>
  a === undefined || b === undefined ? a === b : stableStringify(a) === stableStringify(b);

export function merge3(base: Tooltip, head: Tooltip, next: Tooltip): MergeResult {
  for (const value of [base, head, next]) tooltipSchema.parse(value);
  if (base.hash !== head.hash || base.hash !== next.hash) {
    throw new Error('Cannot merge different tooltip hashes');
  }
  const conflicts: MergeConflict[] = [];
  function atomic<T>(field: string, original: T, theirs: T, mine: T): T {
    if (equal(theirs, mine) || equal(original, theirs)) return mine;
    if (equal(original, mine)) return theirs;
    conflicts.push({ field, base: original, head: theirs, next: mine });
    return original;
  }
  /** Both sides changed the content identically but stamped it differently (a retried save): keep head's. */
  function stamped<T extends object>(
    field: string,
    original: T | undefined,
    theirs: T | undefined,
    mine: T | undefined,
    content: (value: T) => unknown,
  ): T | undefined {
    const sameChange =
      theirs !== undefined &&
      mine !== undefined &&
      equal(content(theirs), content(mine)) &&
      (original === undefined || !equal(content(original), content(mine)));
    if (sameChange) return theirs;
    return atomic(field, original, theirs, mine);
  }
  const merged: Record<string, unknown> = { hash: base.hash };
  const keys = new Set([...Object.keys(base), ...Object.keys(head), ...Object.keys(next)]);
  for (const key of keys) {
    if (key === 'text' || key === 'associated' || key === 'hash') continue;
    const field = key as keyof Tooltip;
    const value =
      key === 'bungieSnapshot'
        ? stamped(
            key,
            base.bungieSnapshot,
            head.bungieSnapshot,
            next.bungieSnapshot,
            (snapshot) => snapshot.description,
          )
        : atomic(key, base[field], head[field], next[field]);
    if (value !== undefined) merged[key] = value;
  }
  const text: Tooltip['text'] = {};
  for (const language of languages) {
    const value = stamped(
      `text.${language}`,
      base.text[language],
      head.text[language],
      next.text[language],
      (entry) => entry.text,
    );
    if (value !== undefined) text[language] = value;
  }
  const original = new Set(base.associated);
  const theirs = new Set(head.associated);
  const mine = new Set(next.associated);
  const members = new Set(
    [...original, ...theirs, ...mine].filter((hash) =>
      original.has(hash) ? theirs.has(hash) && mine.has(hash) : theirs.has(hash) || mine.has(hash),
    ),
  );
  const sameOrder = (a: readonly number[], b: readonly number[]) =>
    a.length === b.length && a.every((hash, index) => hash === b[index]);
  const associated = sameOrder(head.associated, base.associated)
    ? next.associated.filter((hash) => members.has(hash))
    : sameOrder(next.associated, base.associated)
      ? head.associated.filter((hash) => members.has(hash))
      : [
          ...next.associated.filter((hash) => members.has(hash)),
          ...head.associated.filter((hash) => members.has(hash) && !mine.has(hash)),
        ];
  if (conflicts.length) return { ok: false, conflicts };
  return { ok: true, merged: tooltipSchema.parse({ ...merged, text, associated }) };
}

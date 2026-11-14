import type { Lang } from '../languages.js';
import { numberSlots } from '../markup/numberSlots.js';
import { numberMapSchema, type LangText, type NumberMap, type Tooltip } from '../schemas.js';
import { alignSlots } from './identity.js';
import { freezeFormula } from './freeze.js';

export type NumberValues = ReadonlyMap<number, string | null>;
export interface NumberToken {
  from: number;
  to: number;
  id?: number;
}
/** Comments intentionally participate. A malformed prefix is an error, never ignored. */
export function numberTokens(text: string): NumberToken[] {
  return [...text.matchAll(/#\{=[^}\n]*(?:}|$)/gm)].map((match) => {
    const valid = /^#\{=([1-9]\d*)\}$/.exec(match[0]);
    const id = valid ? Number(valid[1]) : undefined;
    return {
      from: match.index,
      to: match.index + match[0].length,
      ...(id !== undefined && Number.isSafeInteger(id) ? { id } : {}),
    };
  });
}
export function implicitNumberMap(count: number): NumberMap {
  return { ids: Array.from({ length: count }, (_, i) => i + 1), next: count + 1, retired: {} };
}
export function readNumberMap(english: Pick<LangText, 'text' | 'numbers'>): NumberMap {
  const count = numberSlots(english.text).length;
  const map =
    english.numbers === undefined
      ? implicitNumberMap(count)
      : numberMapSchema.parse(english.numbers);
  if (map.ids.length !== count)
    throw new Error(`Number map has ${map.ids.length} ids for ${count} English slots.`);
  return map;
}
export function numberValues(
  english: Pick<LangText, 'text' | 'numbers'>,
  lang?: Lang,
): NumberValues {
  const map = readNumberMap(english);
  const values = new Map<number, string | null>();
  numberSlots(english.text).forEach((slot, i) => values.set(map.ids[i], slot.value));
  for (const [id, retired] of Object.entries(map.retired))
    values.set(
      Number(id),
      retired === null
        ? null
        : typeof retired === 'string'
          ? retired
          : lang !== undefined && retired.fallback.includes(lang)
            ? null
            : retired.value,
    );
  return values;
}
export function resolveNumberTokens(text: string, values: NumberValues): string {
  if (!text.includes('#{=')) return text;
  let result = '',
    at = 0;
  for (const token of numberTokens(text)) {
    const value = token.id === undefined ? undefined : values.get(token.id);
    if (typeof value !== 'string')
      throw new Error(
        token.id === undefined
          ? 'Malformed number token.'
          : `Unknown or unfreezable number #{=${token.id}}.`,
      );
    if (value.includes('#{=')) throw new Error('A number value cannot contain number tokens.');
    result += text.slice(at, token.from) + value;
    at = token.to;
  }
  return result + text.slice(at);
}
/** Computed only from saved English -> merged English; ignore any client-provided map. */
export function reconcileNumberMap(
  before: Pick<LangText, 'text' | 'numbers'> | undefined,
  after: Pick<LangText, 'text'>,
  tooltip: Pick<Tooltip, 'text'>,
): NumberMap | undefined {
  const old = before ?? { text: '' };
  const map = readNumberMap(old);
  const alignment = alignSlots(old.text, after.text);
  const next: NumberMap = { ids: [], next: map.next, retired: { ...map.retired } };
  const carried = new Map([...alignment.map].map(([a, b]) => [b, map.ids[a]]));
  next.ids = alignment.after.map((_, index) => carried.get(index) ?? next.next++);
  const referenced = new Set(
    Object.entries(tooltip.text).flatMap(([lang, entry]) =>
      lang === 'en'
        ? []
        : numberTokens(entry.text).flatMap((token) => (token.id === undefined ? [] : [token.id])),
    ),
  );
  for (const [index, slot] of alignment.before.entries()) {
    const id = map.ids[index];
    if (!alignment.map.has(index) && referenced.has(id)) {
      const referencing = Object.fromEntries(
        Object.entries(tooltip.text).filter(
          ([lang, entry]) =>
            lang !== 'en' && numberTokens(entry.text).some((token) => token.id === id),
        ),
      );
      next.retired[id] =
        slot.kind === 'M' ? freezeFormula(slot.value, old.text, map, referencing) : slot.value;
    }
  }
  for (const id of Object.keys(next.retired))
    if (!referenced.has(Number(id))) delete next.retired[id];
  const implicit = implicitNumberMap(next.ids.length);
  return next.next === implicit.next &&
    next.ids.every((id, i) => id === implicit.ids[i]) &&
    !Object.keys(next.retired).length
    ? undefined
    : next;
}

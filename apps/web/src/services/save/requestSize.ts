import type { Change } from '../api';
import { languages } from '@clarity/core';

// A request with the largest real English edit, or several smaller metadata edits,
// falls into the measured low-CPU band. Text edits also run revision and number checks.
export const saveRequestLimits = {
  changes: 100,
  bytes: 2_000_000,
  work: 16 * 1024,
  atomic: 40 * 1024,
};
const encoder = new TextEncoder();

export const jsonBytes = (value: unknown) => encoder.encode(JSON.stringify(value)).length;

export function saveEnvelopeBytes(message: string, noTranslationImpact: boolean) {
  return jsonBytes({ changes: [], message, ...(noTranslationImpact && { noTranslationImpact }) });
}

export function saveChangeCost(change: Change) {
  const bytes = jsonBytes(change) + 1;
  let work = bytes + 512;
  for (const lang of languages) {
    const before = change.base?.text[lang]?.text;
    const after = change.next.text[lang]?.text;
    if (before !== after)
      work += (lang === 'en' ? 2 : 1) * (jsonBytes(before ?? '') + jsonBytes(after ?? ''));
  }
  return { bytes, work };
}

export function fitsSaveCosts(
  items: readonly Change[],
  envelope: number,
  cost: (change: Change) => { bytes: number; work: number },
  workLimit = saveRequestLimits.work,
) {
  if (items.length > saveRequestLimits.changes) return false;
  let bytes = envelope - 1;
  let work = 0;
  for (const item of items) {
    const size = cost(item);
    bytes += size.bytes;
    work += size.work;
  }
  return bytes <= saveRequestLimits.bytes && work <= workLimit;
}

export function fitsSaveRequest(
  changes: Change[],
  message: string,
  noTranslationImpact: boolean,
  workLimit?: number,
) {
  return fitsSaveCosts(
    changes,
    saveEnvelopeBytes(message, noTranslationImpact),
    saveChangeCost,
    workLimit,
  );
}

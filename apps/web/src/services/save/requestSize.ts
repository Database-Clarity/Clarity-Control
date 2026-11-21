import type { Change } from '../api';
import { languages, usesEnglishFallback } from '@clarity/core';

// A request with the largest real English edit, or about 50 real Compendium links, falls into
// the measured CPU band. Text edits also run revision and number checks.
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

/** No live text changes in any language: a Compendium link or other metadata-only change. */
export function metadataOnly({ base, next }: Change) {
  return languages.every(
    (lang) =>
      base?.text[lang]?.text === next.text[lang]?.text &&
      (!base || usesEnglishFallback(base, lang) === usesEnglishFallback(next, lang)),
  );
}

export function saveChangeCost(change: Change) {
  const bytes = jsonBytes(change) + 1;
  // Metadata-only changes skip every text check. Hosted /save CPU is about 40 ms, and cold local
  // runs add 0.35 to 0.5 ms per real Compendium link: about 50 links per part, under 64 ms.
  if (metadataOnly(change)) return { bytes, work: Math.ceil((bytes + 512) / 12) };
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

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
  let work = bytes + 512;
  // Metadata-only changes skip every text check. Hosted /save CPU is about 40 ms, and cold local
  // runs add 0.35 to 0.5 ms per real Compendium link: about 50 links per part, under 64 ms.
  // The discount applies only to a part with no text edit (fitsSaveCosts).
  if (metadataOnly(change)) return { bytes, work, metadataWork: Math.ceil(work / 12) };
  for (const lang of languages) {
    const before = change.base?.text[lang]?.text;
    const after = change.next.text[lang]?.text;
    if (before !== after)
      work += (lang === 'en' ? 2 : 1) * (jsonBytes(before ?? '') + jsonBytes(after ?? ''));
  }
  return { bytes, work };
}

type SaveCost = { bytes: number; work: number; metadataWork?: number };

export function fitsSaveCosts(
  items: readonly Change[],
  envelope: number,
  cost: (change: Change) => SaveCost,
  workLimit = saveRequestLimits.work,
) {
  if (items.length > saveRequestLimits.changes) return false;
  let bytes = envelope - 1;
  let work = 0;
  let metadataWork = 0;
  let metadata = true;
  for (const item of items) {
    const size = cost(item);
    bytes += size.bytes;
    work += size.work;
    if (size.metadataWork === undefined) metadata = false;
    else metadataWork += size.metadataWork;
  }
  return bytes <= saveRequestLimits.bytes && (metadata ? metadataWork : work) <= workLimit;
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

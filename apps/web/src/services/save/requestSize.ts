import type { Change } from '../api';

export const saveRequestLimits = { changes: 100, bytes: 2_000_000 };
const encoder = new TextEncoder();

export const jsonBytes = (value: unknown) => encoder.encode(JSON.stringify(value)).length;

export function saveEnvelopeBytes(message: string, noTranslationImpact: boolean) {
  return jsonBytes({ changes: [], message, ...(noTranslationImpact && { noTranslationImpact }) });
}

export function fitsSaveRequest(changes: Change[], message: string, noTranslationImpact: boolean) {
  return (
    changes.length <= saveRequestLimits.changes &&
    changes.reduce(
      (size, change) => size + jsonBytes(change) + 1,
      saveEnvelopeBytes(message, noTranslationImpact) - 1,
    ) <= saveRequestLimits.bytes
  );
}

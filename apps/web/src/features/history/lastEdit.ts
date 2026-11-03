import type { Tooltip } from '@clarity/core';

/** Epoch 0 (and missing or invalid values) mean "never recorded" in migrated data. */
export function known(value: string | number | undefined): string | number | undefined {
  const time = value === undefined ? NaN : typeof value === 'number' ? value : Date.parse(value);
  return time > 0 && Number.isFinite(time) ? value : undefined;
}

/** The newest recorded edit of a tooltip in any language, else the legacy upload. */
export function lastEdit(tooltip: Tooltip): { at?: string | number; by?: string } {
  let best: { at: string; by: string; time: number } | undefined;
  for (const entry of Object.values(tooltip.text)) {
    const at = known(entry?.updatedAt);
    if (!entry || at === undefined) continue;
    const time = typeof at === 'number' ? at : Date.parse(at);
    if (!best || time > best.time) best = { at: String(at), by: entry.updatedBy, time };
  }
  if (best) return { at: best.at, by: best.by || undefined };
  const upload = known(tooltip.legacy?.lastUpload);
  return upload === undefined ? {} : { at: upload, by: tooltip.legacy?.uploadedBy || undefined };
}

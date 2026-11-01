import type { Lang, Tooltip } from '@clarity/core';

function date(value: string | number | undefined): string {
  const time = value === undefined ? NaN : typeof value === 'number' ? value : Date.parse(value);
  const parsed = new Date(time);
  return time > 0 && Number.isFinite(parsed.getTime()) ? parsed.toISOString() : 'unknown time';
}

export function LanguageSummary({
  base,
  lang,
  draft,
}: {
  base: Tooltip;
  lang: Lang;
  draft: boolean;
}) {
  const entry = base.text[lang];
  const legacy = base.legacy;
  const iso = date(entry?.updatedAt);
  const shortDate =
    iso === 'unknown time'
      ? iso
      : new Date(iso).toLocaleDateString(undefined, {
          day: 'numeric',
          month: 'short',
          timeZone: 'UTC',
        });
  return (
    <details>
      <summary>
        {draft && 'Local draft · '}
        {entry
          ? `Edited by ${entry.updatedBy || 'unknown author'} · ${shortDate}`
          : 'No saved language text'}
      </summary>
      <p>
        Saved language edit: {entry?.updatedBy || 'unknown author'}, {iso}. Legacy tooltip upload:{' '}
        {legacy?.uploadedBy || 'unknown author'}, {date(legacy?.lastUpload)}.
      </p>
    </details>
  );
}

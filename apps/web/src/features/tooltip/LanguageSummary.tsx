import type { Lang, Tooltip } from '@clarity/core';

function date(value: string | number | undefined): string {
  const time = value === undefined ? NaN : typeof value === 'number' ? value : Date.parse(value);
  const parsed = new Date(time);
  return time > 0 && Number.isFinite(parsed.getTime()) ? parsed.toISOString() : 'unknown time';
}

export function LanguageSummary({ base, lang, draft }: { base: Tooltip; lang: Lang; draft: boolean }) {
  const entry = base.text[lang];
  const legacy = base.legacy;
  return <p>
    {draft && 'Local unsaved changes. '}
    {entry ? `Saved language edit: ${entry.updatedBy || 'unknown author'}, ${date(entry.updatedAt)}.` : 'No saved language text.'}
    {' '}Legacy tooltip upload: {legacy?.uploadedBy || 'unknown author'}, {date(legacy?.lastUpload)}.
  </p>;
}

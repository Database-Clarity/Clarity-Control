import type { Lang, Tooltip } from '@clarity/core';
import { When } from '../../ui/When';

/** Epoch 0 (and missing or invalid values) mean "never recorded" in migrated data. */
function known(value: string | number | undefined): string | number | undefined {
  const time = value === undefined ? NaN : typeof value === 'number' ? value : Date.parse(value);
  return time > 0 && Number.isFinite(time) ? value : undefined;
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
  return (
    <details>
      <summary>
        {draft && 'Local draft · '}
        {entry ? (
          <>
            Edited by {entry.updatedBy || 'unknown author'} ·{' '}
            <When value={known(entry.updatedAt)} />
          </>
        ) : (
          'No saved language text'
        )}
      </summary>
      <p>
        Saved language edit: {entry?.updatedBy || 'unknown author'},{' '}
        <When value={known(entry?.updatedAt)} />. Legacy tooltip upload:{' '}
        {legacy?.uploadedBy || 'unknown author'}, <When value={known(legacy?.lastUpload)} />.
      </p>
    </details>
  );
}

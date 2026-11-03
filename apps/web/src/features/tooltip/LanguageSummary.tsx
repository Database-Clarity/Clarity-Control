import type { Lang, Tooltip } from '@clarity/core';
import { When } from '../../ui/When';
import { known } from '../history/lastEdit';

export function LanguageSummary({
  base,
  lang,
  draft,
  open = false,
}: {
  base: Tooltip;
  lang: Lang;
  draft: boolean;
  open?: boolean;
}) {
  const entry = base.text[lang];
  const legacy = base.legacy;
  return (
    <details open={open}>
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

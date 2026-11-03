import type { Lang, Tooltip } from '@clarity/core';
import { When } from '../../ui/When';
import { known } from '../history/lastEdit';

export function LanguageSummary({
  base,
  lang,
  draft,
  plain = false,
}: {
  base: Tooltip;
  lang: Lang;
  draft: boolean;
  /** Two plain lines, for a popover; otherwise a disclosure. */
  plain?: boolean;
}) {
  const entry = base.text[lang];
  const legacy = base.legacy;
  const summary = (
    <>
      {draft && 'Local draft · '}
      {entry ? (
        <>
          Edited by {entry.updatedBy || 'unknown author'} · <When value={known(entry.updatedAt)} />
        </>
      ) : (
        'No saved language text'
      )}
    </>
  );
  const detail = (
    <>
      Saved language edit: {entry?.updatedBy || 'unknown author'},{' '}
      <When value={known(entry?.updatedAt)} />. Legacy tooltip upload:{' '}
      {legacy?.uploadedBy || 'unknown author'}, <When value={known(legacy?.lastUpload)} />.
    </>
  );
  if (plain)
    return (
      <>
        <p style={{ margin: '0 0 6px', fontWeight: 700 }}>{summary}</p>
        <p style={{ margin: 0 }}>{detail}</p>
      </>
    );
  return (
    <details>
      <summary>{summary}</summary>
      <p>{detail}</p>
    </details>
  );
}

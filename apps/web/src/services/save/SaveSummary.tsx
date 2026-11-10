import { memo, useEffect, useState } from 'react';
import { languageLabel } from '../../languageLabels';
import { languages, stableStringify, type TooltipValidationIssue } from '@clarity/core';
import { Link } from 'react-router-dom';
import type { Change } from '../api';
import type { EditorData } from '../../stores/data';
import { WordDiff } from '../../ui/diff';
import { CompendiumFreshness } from '../../features/compendium/CompendiumFreshness';

export function SaveSummary({
  changes,
  issues,
  data,
}: {
  changes: Change[];
  issues: TooltipValidationIssue[];
  data: EditorData;
}) {
  // Native dialog opening forces layout. Keep that first commit small, then append
  // bounded groups between frames. Memoized rows preserve selection and avoid re-diffing.
  const [shown, setShown] = useState({ changes, count: 10 });
  const visible = shown.changes === changes ? shown.count : 10;
  useEffect(() => {
    if (visible >= changes.length) return;
    const frame = requestAnimationFrame(() => {
      setShown({ changes, count: Math.min(visible + 10, changes.length) });
    });
    return () => cancelAnimationFrame(frame);
  }, [changes, visible]);
  return (
    <>
      <p>
        {changes.length} changed tooltip(s). Removed words are struck through; additions are
        underlined.
      </p>
      {changes.some(({ next }) => next.compendium) && <CompendiumFreshness staleOnly />}
      {issues.length > 0 && (
        <section aria-label="Save validation issues">
          <h3>Validation</h3>
          <ul>
            {issues.map((issue, index) => (
              <li key={index}>
                <strong>{issue.severity}</strong>: {issue.hash} / {languageLabel(issue.lang)}:{' '}
                {issue.message}
              </li>
            ))}
          </ul>
        </section>
      )}
      {changes.slice(0, visible).map((change) => (
        <SaveChange key={change.hash} change={change} data={data} />
      ))}
      {visible < changes.length && <p role="status">Preparing save summary...</p>}
    </>
  );
}

const SaveChange = memo(function SaveChange({
  change,
  data,
}: {
  change: Change;
  data: EditorData;
}) {
  const { hash, base, next } = change;
  const beforeFields = Object.fromEntries(
    Object.entries(base ?? {}).filter(([key]) => key !== 'text'),
  );
  const afterFields = Object.fromEntries(Object.entries(next).filter(([key]) => key !== 'text'));
  const changedFields = [
    ...new Set([...Object.keys(beforeFields), ...Object.keys(afterFields)]),
  ].filter(
    (key) =>
      key !== 'hash' && JSON.stringify(beforeFields[key]) !== JSON.stringify(afterFields[key]),
  );
  return (
    <section key={hash}>
      <h3>
        <Link to={`/t/${hash}`}>{data.items[hash]?.name ?? next.custom?.name ?? hash}</Link> ({hash}
        )
      </h3>
      {languages
        .filter((lang) => (base?.text[lang]?.text ?? '') !== (next.text[lang]?.text ?? ''))
        .map((lang) => (
          <section key={lang}>
            <h4>{languageLabel(lang)}</h4>
            <WordDiff before={base?.text[lang]?.text ?? ''} after={next.text[lang]?.text ?? ''} />
          </section>
        ))}
      {stableStringify(beforeFields) !== stableStringify(afterFields) && (
        <details>
          <summary>Other tooltip fields ({changedFields.join(', ')})</summary>
          <WordDiff
            before={JSON.stringify(beforeFields, null, 2)}
            after={JSON.stringify(afterFields, null, 2)}
          />
        </details>
      )}
    </section>
  );
});

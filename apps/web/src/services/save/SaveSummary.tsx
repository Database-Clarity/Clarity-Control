import { SkeletonBoundary } from '../../ui/Skeleton';
import { memo, useEffect, useState, type MouseEvent } from 'react';
import { languageLabel } from '../../languageLabels';
import {
  clearedEnglishMessage,
  languages,
  stableStringify,
  type TooltipValidationIssue,
} from '@clarity/core';
import { Link } from 'react-router-dom';
import type { Change } from '../api';
import type { EditorData } from '../../stores/data';
import { WordDiff } from '../../ui/diff';
import { CompendiumFreshness } from '../../features/compendium/CompendiumFreshness';
import { editorPath } from '../../features/queue/editorPath';

type TooltipVisit = (event: MouseEvent<HTMLAnchorElement>) => void;

export function SaveSummary({
  changes,
  issues,
  data,
  onVisit,
}: {
  changes: Change[];
  issues: TooltipValidationIssue[];
  data: EditorData;
  onVisit?: TooltipVisit;
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
  // Errors block saving, and a cleared text removes a tooltip: both must be seen.
  const isOpen = ({ severity, message }: TooltipValidationIssue) =>
    severity === 'error' || message === clearedEnglishMessage;
  const open = issues.filter(isOpen);
  const warnings = issues.filter((issue) => !isOpen(issue));
  const changesByHash = issues.length
    ? new Map(changes.map((change) => [change.hash, change]))
    : null;
  const issueList = (rows: TooltipValidationIssue[]) =>
    rows.length > 0 && (
      <ul>
        {rows.map(({ severity, hash, lang, message }, index) => {
          const change = changesByHash?.get(hash);
          const name = tooltipName(hash, data, change);
          return (
            <li key={index}>
              <Link to={editorPath(hash, data, lang)} onClick={onVisit}>
                {name}
                {name !== hash && <small> ({hash})</small>} / {languageLabel(lang)}{' '}
                <strong>{severity}</strong> · {message}
              </Link>
            </li>
          );
        })}
      </ul>
    );
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
          {/* Other warnings fold away (they can run to hundreds). */}
          {issueList(open)}
          {warnings.length > 0 && (
            <details>
              <summary>
                {warnings.length} warning{warnings.length === 1 ? '' : 's'}
              </summary>
              {issueList(warnings)}
            </details>
          )}
        </section>
      )}
      {changes.slice(0, visible).map((change) => (
        <SaveChange key={change.hash} change={change} data={data} onVisit={onVisit} />
      ))}
      <SkeletonBoundary
        pending={visible < changes.length}
        label="Preparing save summary..."
        shape="rows"
        count={Math.max(1, Math.min(3, changes.length - visible))}
      />
    </>
  );
}

const tooltipName = (hash: number, data: EditorData, change?: Change): string | number =>
  data.items[hash]?.name ??
  change?.next.custom?.name ??
  change?.base?.custom?.name ??
  data.bundle.tooltips[hash]?.custom?.name ??
  hash;

const SaveChange = memo(function SaveChange({
  change,
  data,
  onVisit,
}: {
  change: Change;
  data: EditorData;
  onVisit?: TooltipVisit;
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
        <Link to={editorPath(hash, data)} onClick={onVisit}>
          {tooltipName(hash, data, change)}
        </Link>{' '}
        ({hash})
      </h3>
      {languages
        .filter((lang) => (base?.text[lang]?.text ?? '') !== (next.text[lang]?.text ?? ''))
        .map((lang) => (
          <section key={lang}>
            <h4>{languageLabel(lang)}</h4>
            <WordDiff before={base?.text[lang]?.text ?? ''} after={next.text[lang]?.text ?? ''} />
          </section>
        ))}
      {Object.entries(change.translationRevisions ?? {}).map(([lang, proof]) => (
        <section key={lang}>
          <h4>{languageLabel(lang)}</h4>
          <p>{proof.restore ? 'Restored translation revision' : 'Marked as still correct'}</p>
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

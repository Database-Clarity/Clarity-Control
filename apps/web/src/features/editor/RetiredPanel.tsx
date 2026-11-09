import { useMemo, useState } from 'react';
import {
  applyRetiredEdits,
  findRetiredMarkup,
  maskConflicts,
  type RetiredFix,
  type RetiredOccurrence,
} from '@clarity/core';
import { Overlay } from './StatusBar';
import styles from './RetiredPanel.module.scss';

const listed = 50;

/** The same search the editor runs, on the text the panel shows (a conflict's "theirs" is hidden). */
export const retiredIn = (text: string) => findRetiredMarkup(maskConflicts(text));

/** The tag as written, cut with an ellipsis when long, so two forms on one line read apart. */
const shorten = (source: string, max = 40) =>
  source.length > max ? `${source.slice(0, max - 1)}…` : source;

const lineOf = (text: string, at: number) => {
  let line = 1;
  for (
    let index = text.indexOf('\n');
    index !== -1 && index < at;
    index = text.indexOf('\n', index + 1)
  )
    line++;
  return line;
};

/** What a structural fix changes, as the text before and after, so it can be read before applying. */
export function previewFix(text: string, fix: RetiredFix): { before: string; after: string } {
  const from = Math.min(...fix.edits.map((edit) => edit.from));
  const to = Math.max(...fix.edits.map((edit) => edit.to));
  const next = applyRetiredEdits(text, fix.edits);
  return {
    before: text.slice(from, to),
    after: next.slice(from, to + (next.length - text.length)),
  };
}

/**
 * Every retired form in the text, each with its fixes in the concept's order (Remove tag, then
 * Change to yellow), and Fix all. A fix that rewrites a block or table shows its result first and
 * applies on a second click. The list is computed from the text itself, so it is never stale.
 */
export function RetiredPanel({
  value,
  readOnly,
  onApply,
  onFixAll,
  onClose,
}: {
  value: string;
  readOnly: boolean;
  onApply(occurrence: RetiredOccurrence, fix: RetiredFix): void;
  onFixAll(): void;
  onClose(): void;
}) {
  const found = useMemo(() => retiredIn(value), [value]);
  const [previewing, setPreviewing] = useState<string | null>(null);
  const simple = found.filter((occurrence) => !occurrence.fixes[0]!.structural).length;
  return (
    <Overlay id="editor-panel-retired" label="Retired markup" onClose={onClose}>
      <p className={styles.lead}>
        Retired markup still renders but is no longer supported. It will block saving once the
        existing tooltips are clean.
      </p>
      {!readOnly && simple > 0 && (
        <div className={styles.all}>
          <button
            type="button"
            data-retired-all
            title="Applies each form's first fix: tags are removed and their text kept"
            onClick={onFixAll}
          >
            Fix all ({simple})
          </button>
          {found.length > simple && (
            <span className={styles.note}>
              {found.length - simple} block or table form{found.length - simple === 1 ? '' : 's'}{' '}
              stay for you to preview.
            </span>
          )}
        </div>
      )}
      <ul aria-label="Retired markup" className={styles.list}>
        {found.slice(0, listed).map((occurrence) => {
          const key = `${occurrence.from}:${occurrence.token}`;
          return (
            <li key={key} data-retired-item>
              <div className={styles.row}>
                <span className={styles.where}>Line {lineOf(value, occurrence.from)}</span>
                <code className={styles.token} title={occurrence.source}>
                  {shorten(occurrence.source)}
                </code>
                {!readOnly &&
                  occurrence.fixes.map((fix) => (
                    <button
                      key={fix.id}
                      type="button"
                      data-retired-fix={fix.id}
                      aria-expanded={fix.structural ? previewing === `${key}:${fix.id}` : undefined}
                      onClick={() =>
                        fix.structural
                          ? setPreviewing(
                              previewing === `${key}:${fix.id}` ? null : `${key}:${fix.id}`,
                            )
                          : onApply(occurrence, fix)
                      }
                    >
                      {fix.label}
                      {fix.structural && '…'}
                    </button>
                  ))}
              </div>
              {occurrence.fixes.map((fix) => {
                if (!fix.structural || previewing !== `${key}:${fix.id}`) return null;
                const { before, after } = previewFix(value, fix);
                return (
                  <div key={fix.id} className={styles.preview} data-retired-preview>
                    <pre aria-label="Before">{before}</pre>
                    <span aria-hidden="true">→</span>
                    <pre aria-label="After">{after || '(nothing)'}</pre>
                    <div className={styles.confirm}>
                      <button
                        type="button"
                        data-retired-apply
                        onClick={() => {
                          setPreviewing(null);
                          onApply(occurrence, fix);
                        }}
                      >
                        Apply: {fix.label}
                      </button>
                      <button type="button" onClick={() => setPreviewing(null)}>
                        Cancel
                      </button>
                    </div>
                  </div>
                );
              })}
            </li>
          );
        })}
      </ul>
      {found.length > listed && <p>{found.length - listed} more underlined in the editor.</p>}
    </Overlay>
  );
}

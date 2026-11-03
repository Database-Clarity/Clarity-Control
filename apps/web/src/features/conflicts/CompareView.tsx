import { useEffect, useMemo, useRef } from 'react';
import { changedLines } from '@clarity/core';
import styles from './CompareView.module.scss';

/** The three versions of one language's text a conflict started from. */
export interface CompareData {
  mine: string;
  /** The common ancestor; null when it is no longer known (then no line is marked as changed). */
  base: string | null;
  theirs: string;
  /** "(alice, 2026-11-03 18:02)": who wrote theirs, and when. */
  theirsLabel: string;
}

function Column({
  title,
  detail,
  text,
  changed,
}: {
  title: string;
  detail?: string;
  text: string | null;
  changed: ReadonlySet<number> | null;
}) {
  const lines = text === null ? null : text.split(/\r?\n/);
  return (
    <section className={styles.column} aria-label={title}>
      <h3 className={styles.heading}>
        {title}
        {detail && <span className={styles.detail}> {detail}</span>}
      </h3>
      {lines === null ? (
        <p className={styles.unknown}>Not available any more.</p>
      ) : (
        <ol className={styles.lines}>
          {lines.map((line, index) => (
            <li key={index} data-changed={changed?.has(index) || undefined}>
              {line || '\u200b'}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/**
 * Mine, Base and Theirs side by side over the text. Lines that differ from Base are marked on both
 * sides. It covers the text area and never resizes it; Esc (or Back) returns to the editor.
 */
export function CompareView({ data, onClose }: { data: CompareData; onClose(): void }) {
  const root = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    element.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      close.current();
    };
    element.addEventListener('keydown', onKey);
    return () => element.removeEventListener('keydown', onKey);
  }, []);
  const marks = useMemo(
    () =>
      data.base === null
        ? { mine: null, theirs: null }
        : {
            mine: changedLines(data.base, data.mine),
            theirs: changedLines(data.base, data.theirs),
          },
    [data],
  );
  return (
    <section
      ref={root}
      tabIndex={-1}
      className={styles.view}
      aria-label="Compare mine, base and theirs"
      data-editor-overlay
      data-conflict-compare
    >
      <div className={styles.bar}>
        <button type="button" className={styles.back} onClick={onClose}>
          Back to the text
          <kbd>Esc</kbd>
        </button>
        <span className={styles.legend}>Marked lines differ from Base.</span>
      </div>
      <div className={styles.columns}>
        <Column title="Mine" text={data.mine} changed={marks.mine} />
        <Column title="Base" detail="before either change" text={data.base} changed={null} />
        <Column
          title="Theirs"
          detail={data.theirsLabel}
          text={data.theirs}
          changed={marks.theirs}
        />
      </div>
    </section>
  );
}

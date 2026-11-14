import { LoadingSkeleton, useSkeletonVisible } from '../../ui/Skeleton';
import {
  memo,
  startTransition,
  useDeferredValue,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { parseMarkup, type Lang, type MarkupGlobals, type MarkupSpan } from '@clarity/core';
import { compareRenders, type CompareLine, type Comparison } from './compare';
import { classNames, Lines, PreviewSpan, TooltipPreview } from './TooltipPreview';
import styles from './PreviewColumn.module.scss';
import previewStyles from './TooltipPreview.module.scss';

import type { PreviewMode } from './previewMode';

/** One enhanced version the column can show next to the base. */
export interface EnhancedView {
  hash: number;
  name: string;
  text: string;
  globals: MarkupGlobals;
  /** Derived versions are the base text read as the enhanced type: seeing one is seeing the base. */
  derived: boolean;
}

export interface PreviewColumnProps {
  hash: number;
  lang: Lang;
  name: string;
  /** Exotic armour: the piece carrying this perk, shown above the perk's name. */
  piece?: string;
  /** The piece's icon beside the piece row. */
  pieceIcon?: string;
  icon?: string;
  categoryLabel?: string;
  archiveIcon?: boolean;
  baseText: string;
  baseGlobals: MarkupGlobals;
  enhanced: EnhancedView[];
  /** The view in effect (`effectiveMode`); items without an enhanced version are always Base. */
  mode: PreviewMode;
  onMode(mode: PreviewMode): void;
  /** Which enhanced version is shown, when there are several. */
  variant: number | undefined;
  onVariant(hash: number): void;
  /** Effects that acknowledge the current text, after its deferred render commits. */
  acknowledgement?: ReactNode;
  /** Keep document parsing behind the urgent editor/header render during stepping. */
  stepping?: boolean;
  /** The current document committed and had an opportunity to paint. */
  onDocumentPaint?(hash: number): void;
  pendingDocument?: boolean;
  loadingContent?: boolean;
  /**
   * Scheduled changes: the Current / Upcoming switch, drawn above the preview at once (never
   * deferred with the document). The page switches what the text props render; this only shows it.
   */
  source?: ReactNode;
}

const labels: Record<PreviewMode, string> = {
  base: 'Base',
  enhanced: 'Enhanced',
  compare: 'Compare',
};

/**
 * The preview column: ONE perk header, then Base | Enhanced | Compare (the last two dimmed when the
 * item has no enhanced version), then one body. Base and Enhanced are the renders a consumer sees; Compare is
 * a working view of the two, so only Base and Enhanced ever count as "previewed".
 */
export function PreviewColumn(props: PreviewColumnProps) {
  const [settled, setSettled] = useState(props);
  const changedDocument = settled.hash !== props.hash || settled.lang !== props.lang;
  // A route change starts with the correct document immediately. Live edits wait
  // for a short input pause, so skipped text snapshots never parse or relayout.
  if (changedDocument && !props.stepping) setSettled(props);
  useEffect(() => {
    if (settled === props) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = () => {
      timer = setTimeout(() => startTransition(() => setSettled(props)), props.stepping ? 0 : 40);
    };
    // Paint the urgent editor and header before parsing the preview. New input
    // cancels this snapshot instead of queuing intermediate documents.
    const frame = props.stepping ? requestAnimationFrame(settle) : undefined;
    if (!props.stepping) settle();
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, [props, settled]);
  const deferred = useDeferredValue(settled);
  // A different document/language must never display the previous one's contents.
  // Same-document typing can let the editor paint before parsing its live preview.
  const content =
    props.stepping || (deferred.hash === props.hash && deferred.lang === props.lang)
      ? deferred
      : props;
  const pendingDocument = content.hash !== props.hash || content.lang !== props.lang;
  const onDocumentPaint = props.onDocumentPaint;
  useEffect(() => {
    if (pendingDocument || !onDocumentPaint) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const frame = requestAnimationFrame(() => {
      timer = setTimeout(() => onDocumentPaint(content.hash), 0);
    });
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, [pendingDocument, content.hash, content.lang, onDocumentPaint]);
  return (
    <>
      {props.source}
      <PreviewColumnBody
        {...content}
        source={undefined}
        mode={content.hash === props.hash ? props.mode : content.mode}
        variant={content.hash === props.hash ? props.variant : content.variant}
        onMode={props.onMode}
        onVariant={props.onVariant}
        pendingDocument={pendingDocument}
      />
      {content === props && props.acknowledgement}
    </>
  );
}

const PreviewColumnBody = memo(function PreviewColumnBody({
  hash,
  lang,
  name,
  piece,
  pieceIcon,
  icon,
  categoryLabel,
  archiveIcon,
  baseText,
  baseGlobals,
  enhanced,
  mode,
  onMode,
  variant,
  onVariant,
  pendingDocument,
  loadingContent,
}: PreviewColumnProps) {
  // Held past `loadingContent` until a painted skeleton has had its minimum (ui/Skeleton rule).
  const skeletonShown = useSkeletonVisible(Boolean(loadingContent), hash, true);
  const selected = enhanced.find((entry) => entry.hash === variant) ?? enhanced[0];
  const effective: PreviewMode = selected ? mode : 'base';
  const selectedText = selected?.text;
  const selectedGlobals = selected?.globals;
  const comparison = useMemo<Comparison | undefined>(() => {
    if (selectedText === undefined || !selectedGlobals || effective !== 'compare') return undefined;
    return compareRenders(
      parseMarkup(baseText, baseGlobals).lines,
      parseMarkup(selectedText, selectedGlobals).lines,
    );
  }, [baseText, baseGlobals, selectedText, selectedGlobals, effective]);

  const shown = effective === 'enhanced' && selected ? selected : undefined;
  // "n changes" always; " vs Base" while the strip has room (a narrow column drops it).
  const summary =
    effective === 'compare' && comparison
      ? comparison.changes === 0
        ? { count: 'No changes', rest: ' vs Base' }
        : {
            count: `${comparison.changes} ${comparison.changes === 1 ? 'change' : 'changes'}`,
            rest: ' vs Base',
          }
      : undefined;

  // The row is always there, so stepping onto an item with no enhanced version moves nothing: the
  // views it lacks are dimmed, the chosen view is kept by the page and returns on the next item
  // that has one.
  const bar = (
    <div className={styles.bar}>
      <VersionSwitch
        label="Preview version"
        value={effective}
        hasEnhanced={Boolean(selected)}
        onChange={onMode}
      />
      {selected && enhanced.length > 1 && (
        <select
          className={styles.versions}
          aria-label="Enhanced version"
          value={selected.hash}
          onChange={(event) => onVariant(Number(event.target.value))}
        >
          {enhanced.map((entry) => (
            <option key={entry.hash} value={entry.hash}>
              {entry.name}
            </option>
          ))}
        </select>
      )}
      <span className={styles.summary} aria-live="polite">
        {summary && (
          <>
            {summary.count}
            <span className={styles.vsBase}>{summary.rest}</span>
          </>
        )}
      </span>
    </div>
  );

  return (
    <section
      className={styles.column}
      aria-label={`${name} preview`}
      aria-busy={pendingDocument || undefined}
      data-tooltip-hash={hash}
    >
      <TooltipPreview
        text={shown ? shown.text : baseText}
        lang={lang}
        name={name}
        piece={piece}
        pieceIcon={pieceIcon}
        icon={icon}
        categoryLabel={[categoryLabel, hash].filter(Boolean).join(' · ')}
        globals={shown ? shown.globals : baseGlobals}
        archiveIcon={archiveIcon}
        tooltipHash={shown ? shown.hash : hash}
        bar={bar}
        fill
      >
        {loadingContent || skeletonShown ? (
          <LoadingSkeleton
            label="Loading preview text…"
            count={12}
            text={baseText || undefined}
            visible={skeletonShown}
          />
        ) : (
          comparison && (
            <div className={styles.compare} data-compare="">
              {comparison.lines.map((entry, index) => (
                <CompareRow key={index} entry={entry} />
              ))}
            </div>
          )
        )}
      </TooltipPreview>
    </section>
  );
});

/**
 * Base | Enhanced | Compare: the preview's version strip, also the translate-mode English pane's
 * (one control, one look). Without an enhanced version the last two stay, dimmed.
 */
export function VersionSwitch({
  label,
  value,
  hasEnhanced,
  onChange,
  fill,
}: {
  label: string;
  value: PreviewMode;
  hasEnhanced: boolean;
  onChange(mode: PreviewMode): void;
  /** In a pane header: take the row's free room on phones (RightPane `data-pane-fill`). */
  fill?: boolean;
}) {
  return (
    <div
      className={styles.segmented}
      role="group"
      aria-label={label}
      data-pane-fill={fill ? '' : undefined}
    >
      {(['base', 'enhanced', 'compare'] as const).map((mode) => {
        const missing = !hasEnhanced && mode !== 'base';
        return (
          <button
            key={mode}
            type="button"
            aria-pressed={value === mode}
            disabled={missing}
            title={missing ? 'This item has no enhanced version' : undefined}
            onClick={() => onChange(mode)}
          >
            {labels[mode]}
          </button>
        );
      })}
    </div>
  );
}

/** The Compare rows of a comparison (compare.ts), as the preview column draws them. */
export function CompareLines({ comparison }: { comparison: Comparison }) {
  return (
    <div className={styles.compare} data-compare="">
      {comparison.lines.map((entry, index) => (
        <CompareRow key={index} entry={entry} />
      ))}
    </div>
  );
}

/**
 * One changed value: struck base value, arrow, enhanced value. The arrow stays with the words on
 * either side of it, so a line never breaks between "5", the arrow and "4"; longer phrases still wrap.
 */
function ChangeRun({ was, now }: { was: MarkupSpan[]; now: MarkupSpan[] }) {
  const last = was.slice(-1);
  const first = now.slice(0, 1);
  const span = (parts: MarkupSpan[], className?: string) =>
    parts.map((part, index) => (
      <span key={index} className={className}>
        <PreviewSpan part={part} />
      </span>
    ));
  return (
    <>
      {span(was.slice(0, -1), previewStyles.was)}
      <span className={styles.glue}>
        {span(last, previewStyles.was)}
        <span
          className={previewStyles.enhancedArrow}
          role="img"
          aria-label={was.length ? 'becomes' : 'enhanced'}
        />
        {span(first, previewStyles.now)}
      </span>
      {span(now.slice(1), previewStyles.now)}
    </>
  );
}

const CompareRow = memo(
  function CompareRow({ entry }: { entry: CompareLine }) {
    // Tables are retired from the markup row but still render in older text.
    if (entry.line.table) return <Lines lines={[entry.line]} />;
    if (entry.kind === 'changed' && entry.segments) {
      return (
        <div className={classNames(entry.line.classNames)} data-kind="changed">
          {entry.segments.map((segment, index) =>
            segment.kind === 'same' ? (
              segment.spans.map((part, partIndex) => (
                <PreviewSpan key={`${index}.${partIndex}`} part={part} />
              ))
            ) : (
              <ChangeRun key={index} was={segment.was} now={segment.now} />
            ),
          )}
        </div>
      );
    }
    const className = [
      classNames(entry.line.classNames),
      entry.kind === 'added' ? previewStyles.added : '',
      entry.kind === 'removed' ? previewStyles.removed : '',
    ]
      .filter(Boolean)
      .join(' ');
    return (
      <div className={className || undefined} data-kind={entry.kind}>
        {entry.line.linesContent?.map((part, index) => (
          <PreviewSpan key={index} part={part} />
        ))}
      </div>
    );
  },
  (previous, next) =>
    previous.entry === next.entry || JSON.stringify(previous.entry) === JSON.stringify(next.entry),
);
